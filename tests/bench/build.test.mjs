// tests/bench/build.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLedgerProject } from './build.mjs';
import { wake } from '../../lib/wake.mjs';
import { readLog } from '../../lib/records.mjs';
import { loadSettings } from '../../lib/settings.mjs';

describe('the ledger project builder', () => {
  test('builds a real, current project with an open commitment and a lease', async () => {
    const p = await buildLedgerProject();
    assert.equal(p.slug, 'ledger');
    assert.equal(p.leaseTarget, 'EXP-002');
    assert.deepEqual(p.requirements, ['EXP-001', 'EXP-002', 'EXP-003', 'EXP-004', 'EXP-005']);
    const log = await readLog(p.dir);
    assert.ok(log.some((r) => r.kind === 'start' && r.payload.slug === 'ledger'));
    const w = await wake(p.dir);
    // Resolvable, not Waiting or Done: the project is mid-implementation, exactly where the
    // benchmark's own scenarios assume a Consequential draft would be raised from. action must be
    // 'run' (a missing requirement receipt), not 'repair' -- a 'repair' verdict would mean a
    // hand-written input (settings, spec, mechanisms, ADR) failed to parse, which this fixture
    // build must never produce; asserting only verdict lets that kind of lint problem pass silently.
    assert.equal(w.verdict, 'Resolvable');
    assert.equal(w.action, 'run');
  });
  test('inference is enabled for pinned Verdict with the composite-design fields (no mode, no old thresholds)', async () => {
    const p = await buildLedgerProject();
    const { settings } = await loadSettings(p.dir);
    assert.equal(settings.inference.enabled, true);
    assert.equal(settings.inference.model, 'verdict-151m-d2528239');
    assert.deepEqual(Object.keys(settings.inference.weights).sort(), ['ambiguity', 'contract', 'evidence', 'reach', 'surface']);
    assert.equal('mode' in settings.inference, false);
    assert.equal(settings.developer, 'present');
  });
  test('the touched paths have a real, non-empty uncommitted diff (so code.diff is not empty)', async () => {
    const p = await buildLedgerProject();
    const src = readFileSync(join(p.dir, 'src/ledger.mjs'), 'utf8');
    assert.match(src, /EXP-002/);
  });
  test('two calls build two independent projects', async () => {
    const a = await buildLedgerProject(), b = await buildLedgerProject();
    assert.notEqual(a.dir, b.dir);
  });
});

test('benchmark fixture can explicitly select Jeff or Kev without auto fallback', async () => {
  const configs = [
    { backend: 'jeff', model: 'jeff-gliformer-d0a4e53d', endpoint: 'http://127.0.0.1:8000/v1/systemone' },
    { backend: 'kev', model: 'kev-4b-485ace87', endpoint: 'http://127.0.0.1:8008/v1/systemone' },
  ];
  for (const cfg of configs) {
    const p = await buildLedgerProject(cfg);
    const { settings } = await loadSettings(p.dir);
    assert.equal(settings.inference.backend, cfg.backend);
    assert.equal(settings.inference.model, cfg.model);
    assert.equal(settings.inference.endpoint, cfg.endpoint);
  }
});
