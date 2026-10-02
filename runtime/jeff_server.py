"""Verified local launcher for the pinned Jeff runtime used by Sudus."""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

MODEL_ID = 'jeff-gliformer-d0a4e53d'
SOURCE_REV = '34b32f99a727c47b679adde33f4702a001e02979'
MODEL_REV = 'd0a4e53d09cebe6bc963dd9be319d4279084bb2d'
MODEL_REPO_DIR = 'models--knowledgator--gliformer-large-v1'


def attestation() -> dict:
    return {
        'ok': True, 'model': MODEL_ID, 'source_revision': SOURCE_REV, 'model_revision': MODEL_REV,
        'backend': 'torch', 'device': 'cuda', 'dtype': 'bfloat16', 'attn_kernel': 'eager',
        'compiled': False, 'pad_multiple': 0, 'temperature': 1.0, 'isolate': 'all',
    }


def verify_source(upstream: Path) -> None:
    head = subprocess.run(['git', '-C', str(upstream), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    if head != SOURCE_REV:
        raise RuntimeError(f'Jeff source must be exactly {SOURCE_REV}; got {head}')
    dirty = subprocess.run(['git', '-C', str(upstream), 'status', '--porcelain'],
                           capture_output=True, text=True, check=True).stdout.strip()
    if dirty:
        raise RuntimeError('Jeff source worktree is dirty; pinned runtime requires an unmodified checkout')


def verify_model(model_dir: Path) -> Path:
    model = model_dir.resolve(strict=True)
    if model.name != MODEL_REV or model.parent.name != 'snapshots' or model.parent.parent.name != MODEL_REPO_DIR:
        raise RuntimeError('Jeff model must be the pinned Hugging Face snapshot path')
    for name in ('pytorch_model.bin', 'gliner_config.json', 'tokenizer.json', 'tokenizer_config.json'):
        if not (model / name).is_file():
            raise RuntimeError(f'Jeff model artifact missing: {name}')
    return model


def serve(upstream: Path, model_dir: Path, port: int) -> None:
    verify_source(upstream)
    model = verify_model(model_dir)
    sys.path.insert(0, str(upstream.resolve()))
    import uvicorn
    from jeff.server.app import create_app
    from jeff.server.config import Settings

    settings = Settings(
        backend='torch', model_path=str(model), model_name=MODEL_ID, model_aliases=[], device='cuda', dtype='bfloat16',
        attn_kernel='eager', compile_model=False, compile_mode=None, pad_multiple=0, warmup=False,
        api_keys=[], rate_limit_rps=0, noul_mode='yes_no', isolate='all', state_format='kv', temperature=1.0,
        host='127.0.0.1', port=port,
    )
    app = create_app(settings)

    @app.get('/sudus-healthz')
    async def sudus_healthz():
        return attestation()

    uvicorn.run(app, host='127.0.0.1', port=port, log_level='info')


def main() -> None:
    p = argparse.ArgumentParser(description='Pinned local Jeff launcher for Sudus.')
    p.add_argument('--upstream-dir', required=True, type=Path)
    p.add_argument('--model-dir', required=True, type=Path)
    p.add_argument('--port', type=int, default=8000)
    a = p.parse_args()
    if not 1 <= a.port <= 65535:
        p.error('port must be between 1 and 65535')
    serve(a.upstream_dir.resolve(), a.model_dir.resolve(), a.port)


if __name__ == '__main__':
    main()
