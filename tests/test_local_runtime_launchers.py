"""Contract tests for Sudus-owned launchers around upstream Jeff and Kev runtimes."""
import importlib.util
import pathlib
import tempfile
import unittest
import json
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'runtime' / f'{name}.py')
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

class RuntimeLauncherTest(unittest.TestCase):
    def _source_fixture(self):
        td = tempfile.TemporaryDirectory()
        root = pathlib.Path(td.name)
        (root / 'tracked.py').write_text('trusted\n')
        for command in [('init', '-q'), ('config', 'user.name', 'Test'),
                        ('config', 'user.email', 'test@example.invalid'), ('add', 'tracked.py'),
                        ('commit', '-qm', 'baseline')]:
            subprocess.run(['git', *command], cwd=root, check=True, capture_output=True)
        sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, check=True,
                             capture_output=True, text=True).stdout.strip()
        return td, root, sha

    def test_jeff_and_kev_source_verification_refuses_dirty_tracked_files(self):
        for name in ('jeff_server', 'kev_server'):
            module = load(name)
            td, root, sha = self._source_fixture()
            previous = module.SOURCE_REV
            try:
                module.SOURCE_REV = sha
                module.verify_source(root)
                (root / 'tracked.py').write_text('modified\n')
                with self.assertRaisesRegex(RuntimeError, 'dirty|modified'):
                    module.verify_source(root)
            finally:
                module.SOURCE_REV = previous
                td.cleanup()

    def test_jeff_attestation_pins_source_model_and_every_runtime_knob(self):
        jeff = load('jeff_server')
        self.assertEqual(jeff.attestation(), {
            'ok': True, 'model': 'jeff-gliformer-d0a4e53d',
            'source_revision': '34b32f99a727c47b679adde33f4702a001e02979',
            'model_revision': 'd0a4e53d09cebe6bc963dd9be319d4279084bb2d',
            'backend': 'torch', 'device': 'cuda', 'dtype': 'bfloat16', 'attn_kernel': 'eager',
            'compiled': False, 'pad_multiple': 0, 'temperature': 1.0, 'isolate': 'all',
        })

    def test_kev_attestation_pins_source_checkpoint_base_and_runtime(self):
        kev = load('kev_server')
        self.assertEqual(kev.attestation(), {
            'ok': True, 'model': 'kev-4b-485ace87',
            'source_revision': '5920c5fe4ca8e0970ed4209ac2c9b8e18bea5109',
            'checkpoint_revision': '485ace8703592fcf405488b262449990824cfed1',
            'base_revision': '1001bb4d826a52d1f399e183466143f4da7b741b',
            'backend': 'torch', 'device': 'cuda', 'dtype': 'bfloat16', 'attn': 'sdpa',
            'merge': True, 'lora_scale': 1.0, 'temperature': 2.1435469250725863,
            'cuda_graphs': False, 'fused': False, 'date_facts': False,
        })

    def test_kev_checkpoint_preflight_refuses_missing_base_shards(self):
        kev = load('kev_server')
        with tempfile.TemporaryDirectory() as td:
            cache = pathlib.Path(td)
            run = cache / 'models--jaredpalmer--kev-4b' / 'snapshots' / kev.CHECKPOINT_REV
            run.mkdir(parents=True)
            (run / 'head.pt').write_bytes(b'x'); (run / 'adapter_model.safetensors').write_bytes(b'x')
            (run / 'provenance.json').write_text(json.dumps({'config': {'base': kev.BASE_ID, 'base_revision': kev.BASE_REV}}))
            base = cache / 'models--Qwen--Qwen3.5-4B-Base' / 'snapshots' / kev.BASE_REV
            base.mkdir(parents=True)
            (base / 'model.safetensors.index.json').write_text(json.dumps({'weight_map': {'a': 'one.safetensors', 'b': 'two.safetensors'}}))
            (base / 'config.json').write_text('{}'); (base / 'tokenizer.json').write_text('{}'); (base / 'one.safetensors').write_bytes(b'x')
            with self.assertRaisesRegex(RuntimeError, 'base artifact'):
                kev.verify_checkpoint(run)
            (base / 'two.safetensors').write_bytes(b'x')
            self.assertEqual(kev.verify_checkpoint(run), base)

if __name__ == '__main__': unittest.main()
