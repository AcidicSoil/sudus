"""Verified local launcher for the pinned Kev 4B runtime used by Sudus."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

MODEL_ID = 'kev-4b-485ace87'
SOURCE_REV = '5920c5fe4ca8e0970ed4209ac2c9b8e18bea5109'
CHECKPOINT_REV = '485ace8703592fcf405488b262449990824cfed1'
BASE_ID = 'Qwen/Qwen3.5-4B-Base'
BASE_REV = '1001bb4d826a52d1f399e183466143f4da7b741b'
CHECKPOINT_REPO_DIR = 'models--jaredpalmer--kev-4b'
BASE_REPO_DIR = 'models--Qwen--Qwen3.5-4B-Base'
TEMPERATURE = 2.1435469250725863


def attestation() -> dict:
    return {
        'ok': True, 'model': MODEL_ID, 'source_revision': SOURCE_REV,
        'checkpoint_revision': CHECKPOINT_REV, 'base_revision': BASE_REV,
        'backend': 'torch', 'device': 'cuda', 'dtype': 'bfloat16', 'attn': 'sdpa',
        'merge': True, 'lora_scale': 1.0, 'temperature': TEMPERATURE,
        'cuda_graphs': False, 'fused': False, 'date_facts': False,
    }


def verify_source(upstream: Path) -> None:
    head = subprocess.run(['git', '-C', str(upstream), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    if head != SOURCE_REV:
        raise RuntimeError(f'Kev source must be exactly {SOURCE_REV}; got {head}')
    dirty = subprocess.run(['git', '-C', str(upstream), 'status', '--porcelain'],
                           capture_output=True, text=True, check=True).stdout.strip()
    if dirty:
        raise RuntimeError('Kev source worktree is dirty; pinned runtime requires an unmodified checkout')


def _json(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise RuntimeError(f'invalid metadata file: {path.name}')
    return json.loads(path.read_text(encoding='utf-8'))


def verify_checkpoint(checkpoint_dir: Path) -> Path:
    run = checkpoint_dir.resolve(strict=True)
    if run.name != CHECKPOINT_REV or run.parent.name != 'snapshots' or run.parent.parent.name != CHECKPOINT_REPO_DIR:
        raise RuntimeError('Kev checkpoint must be the pinned Hugging Face snapshot path')
    provenance = _json(run / 'provenance.json')
    if provenance.get('config', {}).get('base') != BASE_ID or provenance.get('config', {}).get('base_revision') != BASE_REV:
        raise RuntimeError('Kev checkpoint provenance does not pin the expected base revision')
    for name in ('head.pt', 'adapter_model.safetensors'):
        if not (run / name).is_file():
            raise RuntimeError(f'Kev checkpoint artifact missing: {name}')

    cache = run.parents[2]
    base = cache / BASE_REPO_DIR / 'snapshots' / BASE_REV
    index = _json(base / 'model.safetensors.index.json')
    weight_map = index.get('weight_map')
    if not isinstance(weight_map, dict) or not weight_map:
        raise RuntimeError('Kev base artifact index is invalid')
    shards = set(weight_map.values())
    if any(not isinstance(name, str) or '/' in name or '\\' in name for name in shards):
        raise RuntimeError('Kev base artifact index contains an invalid shard path')
    for name in ('config.json', 'tokenizer.json', *sorted(shards)):
        if not (base / name).is_file():
            raise RuntimeError(f'Kev base artifact missing: {name}')
    return base


def serve(upstream: Path, checkpoint_dir: Path, port: int) -> None:
    verify_source(upstream)
    verify_checkpoint(checkpoint_dir)
    if os.environ.get('KEV_API_KEY') or os.environ.get('KEV_DATE_FACTS') not in (None, '', '0'):
        raise RuntimeError('Sudus Kev launcher refuses auth and date preprocessing')
    os.environ['KEV_DATE_FACTS'] = '0'
    os.environ['KEV_PREFIX_CACHE'] = '0'
    sys.path.insert(0, str(upstream.resolve()))

    import torch
    import uvicorn
    from kev.checkpoint import Checkpoint, LoadOptions
    from kev.device import default_device
    from kev.serve import Server, app

    if default_device() != 'cuda':
        raise RuntimeError('pinned Kev runtime requires CUDA')
    ck = Checkpoint(str(checkpoint_dir.resolve()))
    if ck.meta.base != BASE_ID or ck.meta.base_revision != BASE_REV:
        raise RuntimeError('loaded Kev metadata does not match the pinned base')
    opts = LoadOptions(dtype=torch.bfloat16, merge=True, attn='sdpa', lora_scale=1.0, temperature=TEMPERATURE,
                       backend='torch', cuda_graphs=False, fused=False)
    tok, model = ck.load('cuda', opts)
    server = Server(ck, tok, model, 'cuda')
    app.state.server = server

    @app.get('/sudus-healthz')
    def sudus_healthz():
        return attestation()

    try:
        uvicorn.run(app, host='127.0.0.1', port=port, log_level='info')
    finally:
        server.close()


def main() -> None:
    p = argparse.ArgumentParser(description='Pinned local Kev 4B launcher for Sudus.')
    p.add_argument('--upstream-dir', required=True, type=Path)
    p.add_argument('--checkpoint-dir', required=True, type=Path)
    p.add_argument('--port', type=int, default=8008)
    a = p.parse_args()
    if not 1 <= a.port <= 65535:
        p.error('port must be between 1 and 65535')
    serve(a.upstream_dir.resolve(), a.checkpoint_dir.resolve(), a.port)


if __name__ == '__main__':
    main()
