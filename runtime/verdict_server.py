"""Pinned, local-only Verdict 151M (GLiClass) adapter for Sudus.

Verdict 151M is NOT the separate Verdict 2.0 marker-pointer checkpoint. This
adapter exposes a conditional 0..4 Score distribution and records the original
abstention mass. Its confidence is distribution concentration, NOT an empirical
probability that the argmax is correct. Sudus-specific calibration is required.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

MODEL_ID = 'verdict-151m-d2528239'
UPSTREAM_REV = 'bff28567cff463b833bf044f351a8b7945d53e07'
MAX_TOKENS = 512  # model's published inference input limit; checked with its tokenizer
DIMENSIONS = ('evidence', 'reach', 'contract', 'surface', 'ambiguity')
ABSTAIN = '__insufficient_evidence__'
FILE_HASHES = {
    'model.safetensors': 'd252823994d47a7933217fc86449493299643af6a0c0d83d6bd5a7666d3253ef',
    'calibrator.json': 'af2a876993148efa0726b6ccf710fe2303897d20c0ce8c7c9036eb50f64d23de',
    'config.json': '303f8eef1009cfdcb0cfba3e653247e625f16a4501e2351bad1a633f1f644695',
    'tokenizer.json': '8bb449eb0c037aae44115b65905bb339b8f3f74eb37067c19127feb3c0755723',
    'tokenizer_config.json': 'fb54f027372062b2ca52282efb04d178a8b57167a00cd8f4e816515823a2c016',
}

class VerdictRefusal(Exception):
    def __init__(self, status: int, kind: str):
        super().__init__(kind)
        self.status = status
        self.kind = kind


def verify_artifacts(model_dir: Path, upstream_dir: Path) -> None:
    sha = subprocess.run(['git', '-C', str(upstream_dir), 'rev-parse', 'HEAD'],
                         capture_output=True, text=True, check=True).stdout.strip()
    if sha != UPSTREAM_REV:
        raise VerdictRefusal(503, 'upstream_revision_mismatch')
    modified = subprocess.run(['git', '-C', str(upstream_dir), 'status', '--porcelain', '--untracked-files=no'],
                              capture_output=True, text=True, check=True).stdout
    if modified.strip():
        raise VerdictRefusal(503, 'upstream_dirty')
    for name, expected in FILE_HASHES.items():
        path = model_dir / name
        if not path.is_file():
            raise VerdictRefusal(503, 'model_artifact_missing')
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != expected:
            raise VerdictRefusal(503, 'model_artifact_mismatch')


def _probabilities(result) -> tuple[list[float], float]:
    data = result.probabilities
    if not isinstance(data, dict) or set(data) != {*map(str, range(5)), ABSTAIN}:
        raise VerdictRefusal(503, 'unexpected_model_distribution')
    values = [data[str(i)] for i in range(5)] + [data[ABSTAIN]]
    if any(not isinstance(x, (int, float)) or not math.isfinite(x) or not 0 <= x <= 1 for x in values):
        raise VerdictRefusal(503, 'invalid_model_distribution')
    if abs(sum(values) - 1.0) > 1e-3:
        raise VerdictRefusal(503, 'invalid_model_distribution')
    if result.is_abstention or values[-1] >= max(values[:-1]):
        raise VerdictRefusal(409, 'abstention')
    substantive = sum(values[:-1])
    if substantive <= 0:
        raise VerdictRefusal(409, 'abstention')
    return [x / substantive for x in values[:-1]], values[-1]


def predict(request: dict, engine, Score, Level, format_query, build_model_input,
            model_id: str = MODEL_ID) -> dict:
    if (not isinstance(request, dict) or request.get('model') != model_id or
        not isinstance(request.get('state'), (dict, list, str)) or
        not isinstance(request.get('questions'), dict) or
        set(request['questions']) != set(DIMENSIONS)):
        raise VerdictRefusal(422, 'request_contract')
    if engine.calibrator is None:
        raise VerdictRefusal(503, 'calibrator_missing')
    state = (request['state'] if isinstance(request['state'], str) else
             json.dumps(request['state'], sort_keys=True, ensure_ascii=False, separators=(',', ':')))
    queries = []
    input_tokens = 0
    for dimension in DIMENSIONS:
        spec = request['questions'][dimension]
        if (not isinstance(spec, dict) or spec.get('type') != 'score' or
            not isinstance(spec.get('instructions'), str) or
            not isinstance(spec.get('criteria'), list) or len(spec['criteria']) != 5 or
            any(not isinstance(x, str) for x in spec['criteria'])):
            raise VerdictRefusal(422, 'request_contract')
        q = Score(id=dimension, question=spec['instructions'], levels=tuple(
            Level(id=str(i), description=label, value=float(i))
            for i, label in enumerate(spec['criteria'])))
        _, labels, _ = format_query(state, q)
        text = build_model_input(q.question, state, labels)
        count = len(engine.tokenizer(text, add_special_tokens=True, truncation=False)['input_ids'])
        if count > MAX_TOKENS:
            raise VerdictRefusal(422, 'context_exceeded')
        input_tokens += count
        queries.append(q)
    evaluated = engine.evaluate(context=state, queries=queries)
    rows = evaluated.results
    if len(rows) != len(DIMENSIONS) or {r.id for r in rows} != set(DIMENSIONS):
        raise VerdictRefusal(503, 'incomplete_model_response')
    answers = {}
    for result in rows:
        conditional, abstention = _probabilities(result)
        score = sum(i * p for i, p in enumerate(conditional))
        # This is a distribution-shape statistic, not P(correct). The returned
        # source calibration applies to candidate probabilities, not to Sudus.
        whole = [p * (1 - abstention) for p in conditional] + [abstention]
        entropy = -sum(p * math.log(p) for p in whole if p > 0)
        concentration = max(0.0, min(1.0, 1.0 - entropy / math.log(len(whole))))
        answers[result.id] = {
            'score': score, 'confidence': concentration,
            'confidence_kind': 'distribution_concentration',
            'abstention_probability': abstention,
            'probabilities': {str(i): p for i, p in enumerate(conditional)},
        }
    return {'model': model_id, 'answers': answers, 'usage': {'input_tokens': input_tokens, 'output_tokens': 0}}


def serve(model_dir: Path, upstream_dir: Path, port: int, device: str) -> None:
    verify_artifacts(model_dir, upstream_dir)
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    sys.path.insert(0, str(upstream_dir))
    from core.engine_encoder import DecisionEngine
    from core.primitives import Score, Level
    from core.formatting import format_query, build_model_input
    engine = DecisionEngine(model_name_or_path=str(model_dir), device=device, max_length=MAX_TOKENS)
    if engine.calibrator is None:
        raise VerdictRefusal(503, 'calibrator_missing')

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status: int, payload: dict) -> None:
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            if self.path != '/healthz':
                self.reply(404, {'error': 'not_found'}); return
            self.reply(200, {'ok': True, 'model': MODEL_ID,
                             'checkpoint_sha256': FILE_HASHES['model.safetensors'],
                             'calibrator_sha256': FILE_HASHES['calibrator.json'],
                             'max_tokens': MAX_TOKENS,
                             'confidence_kind': 'distribution_concentration'})

        def do_POST(self):
            if self.path != '/v1/systemone':
                self.reply(404, {'error': 'not_found'}); return
            try:
                length = int(self.headers.get('Content-Length', '-1'))
                if not 0 <= length <= 64000:
                    raise VerdictRefusal(413, 'request_oversize')
                request = json.loads(self.rfile.read(length).decode('utf-8'))
                result = predict(request, engine, Score, Level, format_query, build_model_input)
                self.reply(200, result)
            except VerdictRefusal as err:
                self.reply(err.status, {'error': err.kind})
            except (UnicodeError, ValueError, TypeError):
                self.reply(422, {'error': 'invalid_request'})
            except Exception:
                # Never echo the untrusted state or model diagnostics into a response.
                self.reply(503, {'error': 'inference_failed'})

        def log_message(self, fmt, *args):
            pass  # No request bodies, paths containing user data, or credentials in logs.

    HTTPServer(('127.0.0.1', port), Handler).serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description='Local-only, pinned Verdict 151M adapter; not Verdict 2.0.')
    parser.add_argument('--model-dir', required=True, type=Path)
    parser.add_argument('--upstream-dir', required=True, type=Path)
    parser.add_argument('--port', type=int, default=8011)
    parser.add_argument('--device', choices=('cpu', 'cuda'), default='cpu')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    serve(args.model_dir.resolve(), args.upstream_dir.resolve(), args.port, args.device)

if __name__ == '__main__': main()
