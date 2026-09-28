import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DatasetError,
  caseFingerprint,
  datasetStats,
  loadDataset,
  validateDataset,
} from '../lib/evaluator-dataset.mjs';

const DIMS = ['evidence', 'reach', 'contract', 'surface', 'ambiguity'];

function manifest() {
  return {
    schema: 1,
    name: 'test-dataset',
    dimensions: DIMS,
    splits: ['development', 'calibration', 'test', 'ood'],
    suites: ['semantic', 'runtime_contract'],
    rules: { family_disjoint_splits: true, human_gold_splits: ['calibration', 'test', 'ood'] },
  };
}

function draft(overrides = {}) {
  return {
    concerns: ['REQ-1'],
    question: 'Should this change happen?',
    recommendation: 'Keep the current behavior.',
    because: 'Observed evidence supports the current behavior.',
    if_wrong: 'A caller may observe a changed contract.',
    instead: 'Change the contract.',
    options: ['Keep the current behavior.', 'Change the contract.'],
    paths: ['src/a.mjs'],
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    schema: 1,
    id: 'C1',
    family_id: 'F1',
    split: 'development',
    suite: 'semantic',
    track: 'core',
    provenance: { kind: 'real_trace', source: 'trace.jsonl', source_id: '1', derived_from: [] },
    scenario: { category: 'internal', draft: draft() },
    gold: { route: 'agent', dimensions: null, label_status: 'route_only', annotators: [], adjudicated: false, rationale: null },
    ...overrides,
  };
}

function adjudicated(id = 'C2', split = 'calibration') {
  return row({
    id,
    family_id: `F-${id}`,
    split,
    scenario: { category: 'contract-change', draft: draft({ question: `Question ${id}?` }) },
    gold: {
      route: 'developer',
      dimensions: { evidence: 1, reach: 2, contract: 4, surface: 2.5, ambiguity: 1.5 },
      label_status: 'adjudicated',
      annotators: ['human:a', 'human:b'],
      adjudicated: true,
      rationale: 'The recommendation changes an agreed contract.',
    },
  });
}

function writeDataset(dir, m, rows) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  writeFileSync(join(dir, 'cases.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

describe('evaluator dataset v1 contract', () => {
  test('accepts development route-only cases and adjudicated calibration cases', () => {
    const data = { manifest: manifest(), cases: [row(), adjudicated()] };
    assert.doesNotThrow(() => validateDataset(data));
    const stats = datasetStats(data);
    assert.equal(stats.total, 2);
    assert.deepEqual(stats.by_split, { calibration: 1, development: 1 });
    assert.deepEqual(stats.by_route, { agent: 1, developer: 1 });
  });

  test('loadDataset reads manifest.json and JSONL rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sudus-eval-dataset-'));
    writeDataset(dir, manifest(), [row(), adjudicated()]);
    const data = await loadDataset(dir);
    assert.equal(data.manifest.name, 'test-dataset');
    assert.deepEqual(data.cases.map((x) => x.id), ['C1', 'C2']);
  });

  test('rejects duplicate ids', () => {
    assert.throws(() => validateDataset({ manifest: manifest(), cases: [row(), row()] }), DatasetError);
  });

  test('rejects a family split across dataset splits', () => {
    const a = row();
    const b = row({ id: 'C2', split: 'test', family_id: a.family_id,
      scenario: { category: 'internal', draft: draft({ question: 'Different question?' }) },
      gold: adjudicated('X', 'test').gold });
    assert.throws(() => validateDataset({ manifest: manifest(), cases: [a, b] }), /family.*split/i);
  });

  test('rejects duplicate semantic drafts under different ids', () => {
    const a = row();
    const b = row({ id: 'C2', family_id: 'F2' });
    assert.equal(caseFingerprint(a), caseFingerprint(b));
    assert.throws(() => validateDataset({ manifest: manifest(), cases: [a, b] }), /duplicate.*draft/i);
  });

  test('rejects adjudicated dimensions outside the closed 0..4 interval', () => {
    const bad = adjudicated();
    bad.gold.dimensions.contract = 4.1;
    assert.throws(() => validateDataset({ manifest: manifest(), cases: [bad] }), /contract.*0.*4/i);
  });

  test('rejects synthetic counterfactuals without a parent', () => {
    const synthetic = row({ provenance: { kind: 'synthetic_counterfactual', source: 'generator', source_id: 's1', derived_from: [] } });
    assert.throws(() => validateDataset({ manifest: manifest(), cases: [synthetic] }), /derived_from/i);
  });

  test('rejects non-adjudicated semantic rows in calibration, test, or ood', () => {
    for (const split of ['calibration', 'test', 'ood']) {
      const bad = row({ id: `C-${split}`, family_id: `F-${split}`, split });
      assert.throws(() => validateDataset({ manifest: manifest(), cases: [bad] }), /adjudicated/i);
    }
  });

  test('runtime-contract rows are not required to invent semantic dimension gold', () => {
    const runtime = row({
      id: 'R1', family_id: 'RF1', split: 'test', suite: 'runtime_contract',
      scenario: { category: 'model-unverified', draft: draft({ question: 'Does the runtime fail closed on identity mismatch?' }) },
      gold: { route: 'developer', dimensions: null, label_status: 'route_only', annotators: [], adjudicated: false, rationale: null },
    });
    assert.doesNotThrow(() => validateDataset({ manifest: manifest(), cases: [runtime] }));
  });
});

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DATASET_CLI = join(REPO, 'scripts', 'evaluator-dataset.mjs');
const LEGACY_SCENARIOS = join(REPO, 'tests', 'bench', 'scenarios.json');

function runDatasetCli(args) {
  return spawnSync(process.execPath, [DATASET_CLI, ...args], { cwd: REPO, encoding: 'utf8' });
}

describe('legacy benchmark seed migration CLI', () => {
  test('seeds all 24 historical cases as development route-only gold without invented dimensions', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sudus-eval-seed-')), 'sudus-routing-v1');
    const r = runDatasetCli(['seed-legacy', 'tests/bench/scenarios.json', dir]);
    assert.equal(r.status, 0, r.stderr);
    const data = await loadDataset(dir);
    assert.equal(data.cases.length, 24);
    assert.equal(data.cases.filter((x) => x.gold.route === 'agent').length, 12);
    assert.equal(data.cases.filter((x) => x.gold.route === 'developer').length, 12);
    assert.ok(data.cases.every((x) => x.split === 'development'));
    assert.ok(data.cases.every((x) => x.suite === 'semantic' && x.track === 'core'));
    assert.ok(data.cases.every((x) => x.provenance.kind === 'legacy_benchmark'));
    assert.ok(data.cases.every((x) => x.gold.label_status === 'route_only' && x.gold.dimensions === null));
    assert.ok(data.cases.every((x) => x.gold.annotators.length === 0 && x.gold.rationale === null));
  });

  test('is byte-stable when rerun against the same generated destination', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sudus-eval-seed-stable-')), 'sudus-routing-v1');
    const first = runDatasetCli(['seed-legacy', 'tests/bench/scenarios.json', dir]);
    assert.equal(first.status, 0, first.stderr);
    const beforeManifest = readFileSync(join(dir, 'manifest.json'));
    const beforeCases = readFileSync(join(dir, 'cases.jsonl'));
    const second = runDatasetCli(['seed-legacy', 'tests/bench/scenarios.json', dir]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(join(dir, 'manifest.json')), beforeManifest);
    assert.deepEqual(readFileSync(join(dir, 'cases.jsonl')), beforeCases);
  });

  test('refuses to overwrite divergent dataset files', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sudus-eval-seed-refuse-')), 'sudus-routing-v1');
    const first = runDatasetCli(['seed-legacy', 'tests/bench/scenarios.json', dir]);
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(join(dir, 'cases.jsonl'), '{"curated":true}\n');
    const second = runDatasetCli(['seed-legacy', 'tests/bench/scenarios.json', dir]);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refus.*overwrite|diverg/i);
  });

  test('check validates and stats reports deterministic dataset counts', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sudus-eval-seed-cli-')), 'sudus-routing-v1');
    assert.equal(runDatasetCli(['seed-legacy', 'tests/bench/scenarios.json', dir]).status, 0);
    const check = runDatasetCli(['check', dir]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /valid sudus-routing-v1: 24 cases/);
    const stats = runDatasetCli(['stats', dir]);
    assert.equal(stats.status, 0, stats.stderr);
    const parsed = JSON.parse(stats.stdout);
    assert.equal(parsed.total, 24);
    assert.deepEqual(parsed.by_split, { development: 24 });
    assert.deepEqual(parsed.by_route, { agent: 12, developer: 12 });
    assert.deepEqual(parsed.by_label_status, { route_only: 24 });
  });
});
