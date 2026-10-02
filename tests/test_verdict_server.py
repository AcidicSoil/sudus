"""Small dependency-free contract tests for the optional Verdict 151M sidecar."""
import importlib.util
import hashlib
import subprocess
import tempfile
import json
import pathlib
import types
import unittest

SPEC = importlib.util.spec_from_file_location('verdict_server', pathlib.Path(__file__).resolve().parents[1] / 'runtime' / 'verdict_server.py')
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)

DIMS = ('evidence', 'reach', 'contract', 'surface', 'ambiguity')
MODEL = 'verdict-151m-d2528239'

class FakeTokenizer:
    tokens = 40
    def __call__(self, prompt, **kw):
        assert kw.get('truncation') is False
        return {'input_ids': list(range(self.tokens))}

class FakeEngine:
    def __init__(self, rows):
        self.rows = rows
        self.calls = 0
        self.tokenizer = FakeTokenizer()
        self.calibrator = object()
    def evaluate(self, **kw):
        self.calls += 1
        return types.SimpleNamespace(results=self.rows)

class FakeLevel:
    def __init__(self, **kw): self.kw = kw

class FakeScore:
    def __init__(self, **kw): self.kw = kw; self.question = kw['question']; self.id = kw['id']

def sample(rows=None):
    p = {'0': .1, '1': .2, '2': .3, '3': .2, '4': .1, '__insufficient_evidence__': .1}
    return FakeEngine(rows or [types.SimpleNamespace(id=d, probabilities=dict(p), is_abstention=False) for d in DIMS])

def req():
    return dict(model=MODEL,state={'five': {'question': 'is this enough?'}},questions={d: {'type':'score','instructions':d,'criteria':['none','low','medium','high','very high']} for d in DIMS})

def fmt(q, ctx): return None, ['levels', 'insufficient'], None

def template(question, state, labels): return question + state

class VerdictSidecarTest(unittest.TestCase):
    def test_pinned_source_must_have_no_modified_tracked_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            upstream = root / 'source'; upstream.mkdir()
            model = root / 'model'; model.mkdir()
            (upstream / 'core.py').write_text('trusted\n')
            (model / 'model.safetensors').write_bytes(b'fixture')
            for command in [('init', '-q'), ('config', 'user.name', 'Test'),
                            ('config', 'user.email', 'test@example.invalid'), ('add', 'core.py'),
                            ('commit', '-qm', 'baseline')]:
                subprocess.run(['git', *command], cwd=upstream, check=True, capture_output=True)
            sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=upstream, check=True,
                                 capture_output=True, text=True).stdout.strip()
            previous_sha, previous_files = server.UPSTREAM_REV, server.FILE_HASHES
            try:
                server.UPSTREAM_REV = sha
                server.FILE_HASHES = {'model.safetensors': hashlib.sha256(b'fixture').hexdigest()}
                server.verify_artifacts(model, upstream)
                (upstream / 'core.py').write_text('modified\n')
                with self.assertRaises(server.VerdictRefusal) as cm:
                    server.verify_artifacts(model, upstream)
                self.assertEqual(cm.exception.kind, 'upstream_dirty')
            finally:
                server.UPSTREAM_REV, server.FILE_HASHES = previous_sha, previous_files
    def test_full_state_and_five_scores_are_preserved(self):
        e = sample()
        payload = server.predict(req(), e, FakeScore, FakeLevel, fmt, template, MODEL)
        self.assertEqual(e.calls, 1)
        self.assertEqual(payload['model'], MODEL)
        self.assertEqual(set(payload['answers']), set(DIMS))
        self.assertAlmostEqual(sum(payload['answers']['evidence']['probabilities'].values()), 1)
        self.assertAlmostEqual(payload['answers']['evidence']['abstention_probability'], .1)
        self.assertEqual(payload['answers']['evidence']['confidence_kind'], 'distribution_concentration')
        self.assertAlmostEqual(payload['answers']['evidence']['score'], 2.0)

    def test_fails_before_inference_when_one_question_exceeds_model_capacity(self):
        e = sample(); e.tokenizer.tokens = 513
        with self.assertRaises(server.VerdictRefusal) as cm:
            server.predict(req(), e, FakeScore, FakeLevel, fmt, template, MODEL)
        self.assertEqual(cm.exception.status, 422)
        self.assertEqual(e.calls, 0)

    def test_does_not_silently_drop_abstention_or_return_a_score_when_abstaining(self):
        e = sample(); e.rows[0].is_abstention = True
        with self.assertRaises(server.VerdictRefusal) as cm: server.predict(req(), e, FakeScore, FakeLevel, fmt, template, MODEL)
        self.assertEqual(cm.exception.status, 409)

    def test_rejects_unknown_model_and_missing_dimensions_without_calling_model(self):
        e = sample(); r = req(); r['model'] = 'verdict-latest'
        with self.assertRaises(server.VerdictRefusal): server.predict(r, e, FakeScore, FakeLevel, fmt, template, MODEL)
        r = req(); del r['questions']['reach']
        with self.assertRaises(server.VerdictRefusal): server.predict(r, e, FakeScore, FakeLevel, fmt, template, MODEL)
        self.assertEqual(e.calls, 0)

if __name__ == '__main__': unittest.main()
