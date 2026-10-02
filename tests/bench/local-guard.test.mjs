import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBenchEnabled, childEnv, buildMeta } from './harness.mjs';
import { DEFAULT_SETTINGS } from '../../lib/init.mjs';

test('local benchmark uses an explicit opt-in, not a hosted credential', () => {
  assert.throws(() => assertBenchEnabled({}));
  assert.doesNotThrow(() => assertBenchEnabled({ SUDUS_BENCH: '1' }));
  assert.deepEqual(childEnv({ PATH: '/bin', HOME: '/home/x', TYPESAFEAI_API_KEY: 'unsafe' }), { PATH: '/bin', HOME: '/home/x' });
});

test('new benchmark metadata identifies the local backend as well as model', () => {
  const s = DEFAULT_SETTINGS(null, null);
  s.inference.backend = 'jeff'; s.inference.model = 'jeff-gliformer-v1';
  const meta = buildMeta({ settings: s, started: 'x', finished: 'y', sudusHead: 'a'.repeat(40), scenarioCount: 1, usableCount: 1, projectDir: '/tmp/x' });
  assert.equal(meta.backend, 'jeff');
  assert.equal(meta.model, 'jeff-gliformer-v1');
});
