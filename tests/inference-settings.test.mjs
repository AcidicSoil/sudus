import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../lib/init.mjs';
import { validateSettings, migrateLegacySettings } from '../lib/settings.mjs';

const configured = (backend, model, endpoint) => ({ ...DEFAULT_SETTINGS(null, null), inference: {
  ...DEFAULT_SETTINGS(null, null).inference, enabled: true, backend, model, endpoint,
} });

test('a new project has a disabled local evaluator with one explicitly configurable backend', () => {
  const s = DEFAULT_SETTINGS(null, null);
  assert.equal(Object.hasOwn(s, 'typesafeai'), false);
  assert.equal(s.schema, 2, 'the breaking settings-shape migration must bump its schema');
  assert.deepEqual({ enabled: s.inference.enabled, backend: s.inference.backend, model: s.inference.model, endpoint: s.inference.endpoint },
    { enabled: false, backend: null, model: null, endpoint: null });
  assert.deepEqual(validateSettings(s), []);
});

test('accepts each explicitly pinned local backend', () => {
  for (const [backend, model, port] of [['verdict', 'verdict-151m-d2528239', 8011], ['jeff', 'jeff-gliformer-d0a4e53d', 8000], ['kev', 'kev-4b-485ace87', 8008]]) {
    assert.deepEqual(validateSettings(configured(backend, model, `http://127.0.0.1:${port}/v1/systemone`)), []);
  }
});

test('rejects remote hosts, credentials, alias, model mismatch and omitted selection', () => {
  for (const [backend, model, endpoint] of [
    ['verdict', 'verdict-151m', 'https://api.typesafe.ai/v1/systemone'],
    ['jeff', 'jeff-gliformer-d0a4e53d', 'http://localhost:8000/v1/systemone'],
    ['jeff', 'jev-latest', 'http://127.0.0.1:8000/v1/systemone'],
    ['kev', 'kev-latest', 'http://127.0.0.1:8008/v1/systemone'],
    ['verdict', 'jeff-v1', 'http://127.0.0.1:8011/v1/systemone'],
    ['jeff', 'jeff-unpinned-v1', 'http://127.0.0.1:8000/v1/systemone'],
    ['unknown', 'unknown-v1', 'http://127.0.0.1:8000/v1/systemone'],
    ['verdict', 'verdict-151m', 'http://user:key@127.0.0.1:8011/v1/systemone'],
    [null, null, null],
  ]) assert.notDeepEqual(validateSettings(configured(backend, model, endpoint)), []);
});

test('migration does not enable a hosted legacy evaluator or silently pick a backend', () => {
  const s = DEFAULT_SETTINGS(null, null);
  const { inference, ...rest } = s;
  const legacy = { ...rest, schema: 1, typesafeai: { ...inference, enabled: true, model: 'jev-1.13.0' } };
  delete legacy.typesafeai.backend; delete legacy.typesafeai.endpoint;
  assert.match(validateSettings(legacy).join(' '), /migrat|legacy|inference/);
  const migrated = migrateLegacySettings(legacy);
  assert.deepEqual(validateSettings(migrated), []);
  assert.equal(migrated.schema, 2);
  assert.equal(migrated.inference.enabled, false);
  assert.equal(migrated.inference.model, null);
  assert.equal(migrated.inference.backend, null);
  assert.equal(migrated.inference.endpoint, null);
  assert.deepEqual(migrated.inference.weights, legacy.typesafeai.weights);
  assert.deepEqual(legacy.typesafeai.model, 'jev-1.13.0', 'migration does not mutate input');
});

test('legacy migration refuses unrecognized fields, credentials, and non-v1 inputs', () => {
  const s = DEFAULT_SETTINGS(null, null);
  const { inference, ...rest } = s;
  const legacy = { ...rest, schema: 1, typesafeai: { enabled: true, model: 'jev-1.13.0',
    weights: inference.weights, agent_ceiling: inference.agent_ceiling,
    confidence_floors: inference.confidence_floors, min_calibration_agent_predictions: 60,
    request_cap_bytes: 48000 } };
  for (const [name, value] of [['backend', 'kev'], ['endpoint', 'http://127.0.0.1:8008/v1/systemone'],
    ['api_key', 'placeholder'], ['mode', 'live']]) {
    assert.throws(() => migrateLegacySettings({ ...legacy, typesafeai: { ...legacy.typesafeai, [name]: value } }), /legacy|field|settings/i);
  }
  assert.throws(() => migrateLegacySettings({ ...legacy, schema: 2 }), /legacy|schema/i);
  assert.throws(() => migrateLegacySettings({ ...legacy, typesafeai: { ...legacy.typesafeai, weights: {} } }), /weight|settings/i);
});
