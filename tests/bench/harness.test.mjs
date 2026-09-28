// tests/bench/harness.test.mjs -- this file never spawns a real `sudus measure` process and never
// opens a socket. Every test that exercises the scenario loop supplies its own fake spawnImpl
// (an async function standing in for node:child_process's spawnSync), so an unavailable result, a
// crash, or a full run can all be proven without the live transport (bin/inference.mjs) ever
// running. buildLedgerProject() itself is real but 100% local (git plus lib/ calls, no network),
// the same project-building function build.test.mjs already exercises.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBenchEnabled, BenchGuardError, runBenchmark, runScenarios, childEnv, buildMeta } from './harness.mjs';
import { buildLedgerProject } from './build.mjs';
import { appendRecord } from '../../lib/records.mjs';

// A minimal, schema-valid 'measurement' payload (lib/records.mjs SCHEMAS.measurement) a fake
// spawnImpl can append directly to a real project's log, standing in for what a real `sudus
// measure` child process would have written.
function measurementPayload({ outcome, reason, suggested = null }) {
  return {
    intent: 'a'.repeat(40), call: null, draft_digest: 'sha256:' + 'a'.repeat(64), source: 'verdict',
    model: outcome === 'composite' ? 'verdict-151m-d2528239' : null,
    levels: outcome === 'composite' ? [{ dimension: 'evidence', level: 1, confidence: 0.9 }] : [],
    composite: outcome === 'composite' ? 0.1 : null, veto: null, suggested, outcome, reason,
  };
}
const RATE_LIMITED = measurementPayload({ outcome: 'unavailable', reason: 'unavailable overloaded' });
const SUCCESS = (suggested) => measurementPayload({ outcome: 'composite', reason: 'composite 0.100 <= 0.35, confidences ok', suggested });

function fakeScenario(id, expect, concern) {
  return { id, expect, category: 'dry', draft: { concerns: [concern], question: 'q', recommendation: 'r', because: 'b', if_wrong: 'w', instead: 'i', options: ['r'], paths: ['p'] } };
}

describe('the explicit local benchmark opt-in', () => {
  test('refuses unless SUDUS_BENCH=1', () => {
    for (const env of [{}, { SUDUS_BENCH: 'true' }]) assert.throws(() => assertBenchEnabled(env), BenchGuardError);
    assert.doesNotThrow(() => assertBenchEnabled({ SUDUS_BENCH: '1' }));
  });
  test('refuses before building or spawning', async () => {
    let built = false;
    await assert.rejects(runBenchmark({ env: {}, buildImpl: async () => { built = true; throw Error('unexpected'); } }), BenchGuardError);
    assert.equal(built, false);
  });
});

describe('childEnv: the controlled env a spawned sudus measure gets (pure function, no I/O)', () => {
  test('keeps PATH and HOME only', () => {
    const out = childEnv({ PATH: '/usr/bin:/bin', HOME: '/home/x' });
    assert.deepEqual(out, { PATH: '/usr/bin:/bin', HOME: '/home/x' });
  });
  test('strips the parent shell harness markers (CLAUDECODE, CODEX_HOME, MUSE_SESSION) and everything else not on the allowlist', () => {
    const out = childEnv({
      PATH: '/usr/bin', HOME: '/home/x', TYPESAFEAI_API_KEY: 'k',
      CLAUDECODE: '1', CODEX_HOME: '/somewhere', MUSE_SESSION: 'abc', SHELL: '/bin/bash', RANDOM_VAR: 'x',
    });
    assert.deepEqual(Object.keys(out).sort(), ['HOME', 'PATH']);
  });
  test('omits PATH or HOME entirely when the parent env lacks them, rather than setting them to undefined', () => {
    const out = childEnv({});
    assert.deepEqual(out, {});
    assert.equal('PATH' in out, false);
    assert.equal('HOME' in out, false);
  });
});

describe('buildMeta: the results.json meta shape (pure function, no I/O)', () => {
  test('carries model, agent_ceiling, confidence_floors, weights, a policy digest and the run bounds', () => {
    const settings = {
      inference: { backend: 'verdict', endpoint: 'http://127.0.0.1:8011/v1/systemone',
        model: 'verdict-151m-d2528239', agent_ceiling: 0.35,
        confidence_floors: { evidence: 0, reach: 0, contract: 0, surface: 0, ambiguity: 0 },
        weights: { evidence: 0.2, reach: 0.2, contract: 0.2, surface: 0.2, ambiguity: 0.2 },
        request_cap_bytes: 48000,
      },
      network_exclude: [],
    };
    const meta = buildMeta({ settings, started: 'S', finished: 'F', sudusHead: 'b'.repeat(40), scenarioCount: 24, usableCount: 22, projectDir: '/tmp/x' });
    assert.equal(meta.model, 'verdict-151m-d2528239'); assert.equal(meta.backend, 'verdict');
    assert.equal(meta.agent_ceiling, 0.35);
    assert.deepEqual(meta.confidence_floors, settings.inference.confidence_floors);
    assert.deepEqual(meta.weights, settings.inference.weights);
    assert.match(meta.policy_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(meta.started, 'S');
    assert.equal(meta.finished, 'F');
    assert.equal(meta.sudus_head, 'b'.repeat(40));
    assert.equal(meta.scenario_count, 24);
    assert.equal(meta.usable_count, 22);
    assert.equal(meta.project_dir, '/tmp/x');
  });
});

describe('runScenarios: sequential, single-attempt local measurements (dry: fake spawn, no socket)', () => {
  test('runs scenarios once each in order, retaining a rate-limited result', async () => {
    const project = await buildLedgerProject();
    const scenarios = [fakeScenario('X1', 'agent', 'EXP-001'), fakeScenario('X2', 'developer', 'EXP-002')];
    const calls = [], sleeps = [];
    let n = 0;
    const spawnImpl = async (cmd, args, opts) => {
      const i = n++;
      calls.push(args[args.indexOf('--concern') + 1]);
      // X1 comes back rate-limited; X2 succeeds. No retry or provider fallback occurs.
      await appendRecord(opts.cwd, 'measurement', project.slug, i === 0 ? RATE_LIMITED : SUCCESS('agent'));
      return { status: 0, stderr: '' };
    };
    const sleepImpl = async (ms) => { sleeps.push(ms); };
    const rows = await runScenarios(project, scenarios, { SUDUS_BENCH: '1', TYPESAFEAI_API_KEY: 'k' }, { spawnImpl, sleepImpl });

    // Exactly two spawns, in scenario order: one attempt per scenario.
    assert.deepEqual(calls, ['EXP-001', 'EXP-002']);
    assert.deepEqual(sleeps, []);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'X1'); assert.equal(rows[0].measurement.outcome, 'unavailable');
    assert.equal(rows[1].id, 'X2'); assert.equal(rows[1].measurement.outcome, 'composite');
  });

  test('a rate-limited scenario is recorded unavailable after one attempt', async () => {
    const project = await buildLedgerProject();
    const scenarios = [fakeScenario('X1', 'agent', 'EXP-001')];
    let n = 0; const sleeps = [];
    const spawnImpl = async (cmd, args, opts) => { n++; await appendRecord(opts.cwd, 'measurement', project.slug, RATE_LIMITED); return { status: 0, stderr: '' }; };
    const sleepImpl = async (ms) => { sleeps.push(ms); };
    const rows = await runScenarios(project, scenarios, { SUDUS_BENCH: '1', TYPESAFEAI_API_KEY: 'k' }, { spawnImpl, sleepImpl });
    assert.equal(n, 1); // one attempt, no retries
    assert.deepEqual(sleeps, []);
    assert.equal(rows[0].measurement.outcome, 'unavailable');
    assert.equal(rows[0].measurement.reason, 'unavailable overloaded');
  });

  test('a non-rate-limited unavailable outcome (e.g. auth, malformed) is recorded as-is, never retried', async () => {
    const project = await buildLedgerProject();
    const scenarios = [fakeScenario('X1', 'agent', 'EXP-001')];
    let n = 0;
    const spawnImpl = async (cmd, args, opts) => { n++; await appendRecord(opts.cwd, 'measurement', project.slug, measurementPayload({ outcome: 'unavailable', reason: 'unavailable auth' })); return { status: 0, stderr: '' }; };
    const rows = await runScenarios(project, scenarios, { SUDUS_BENCH: '1', TYPESAFEAI_API_KEY: 'k' }, { spawnImpl, sleepImpl: async () => { throw new Error('must not sleep'); } });
    assert.equal(n, 1);
    assert.equal(rows[0].measurement.reason, 'unavailable auth');
  });

  test('a scenario whose child writes no measurement at all is recorded with an error, not thrown, and not retried', async () => {
    const project = await buildLedgerProject();
    const scenarios = [fakeScenario('X1', 'agent', 'EXP-001')];
    let n = 0;
    const spawnImpl = async () => { n++; return { status: 1, stderr: 'boom' }; };
    const rows = await runScenarios(project, scenarios, { SUDUS_BENCH: '1', TYPESAFEAI_API_KEY: 'k' }, { spawnImpl, sleepImpl: async () => { throw new Error('must not sleep'); } });
    assert.equal(n, 1);
    assert.equal(rows[0].measurement, undefined);
    assert.match(rows[0].error, /no measurement record written \(exit 1\): boom/);
  });

  test('passes each spawned command the controlled env, never the caller-supplied harness markers', async () => {
    const project = await buildLedgerProject();
    const scenarios = [fakeScenario('X1', 'agent', 'EXP-001')];
    let seenEnv = null;
    const spawnImpl = async (cmd, args, opts) => { seenEnv = opts.env; await appendRecord(opts.cwd, 'measurement', project.slug, SUCCESS('developer')); return { status: 0, stderr: '' }; };
    await runScenarios(project, scenarios,
      { SUDUS_BENCH: '1', TYPESAFEAI_API_KEY: 'k', PATH: '/bin', HOME: '/home/x', CLAUDECODE: '1', CODEX_HOME: '/y', MUSE_SESSION: 'z' },
      { spawnImpl, sleepImpl: async () => {} });
    assert.deepEqual(Object.keys(seenEnv).sort(), ['HOME', 'PATH']);
  });
});

describe('runBenchmark: guard, build, run, score and write (dry: fake spawn, no socket)', () => {
  test('does not count unavailable measurements as usable benchmark predictions', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'sudus-bench-test-unavailable-'));
    const scenarios = [fakeScenario('X1', 'developer', 'EXP-001')];
    const spawnImpl = async (_cmd, _args, opts) => {
      await appendRecord(opts.cwd, 'measurement', 'ledger', RATE_LIMITED);
      return { status: 0, stderr: '' };
    };
    const result = await runBenchmark({ env: { SUDUS_BENCH: '1' }, scenarios, spawnImpl, outDir });
    assert.equal(result.meta.scenario_count, 1);
    assert.equal(result.meta.usable_count, 0);
    assert.deepEqual(result.scored.overall, { correct: 0, total: 0 });
    assert.deepEqual(result.scored.unavailable.map((x) => x.id), ['X1']);
  });

  test('writes results.json (meta + rows) and results.md under outDir, and returns the same data', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'sudus-bench-test-out-'));
    const scenarios = [fakeScenario('X1', 'agent', 'EXP-001'), fakeScenario('X2', 'developer', 'EXP-002')];
    const spawnImpl = async (cmd, args, opts) => {
      const slug = args[args.indexOf('--commitment') + 1];
      const suggested = args[args.indexOf('--concern') + 1] === 'EXP-001' ? 'agent' : 'developer';
      await appendRecord(opts.cwd, 'measurement', slug, SUCCESS(suggested));
      return { status: 0, stderr: '' };
    };
    const result = await runBenchmark({
      env: { SUDUS_BENCH: '1', TYPESAFEAI_API_KEY: 'k' },
      scenarios, spawnImpl, sleepImpl: async () => { throw new Error('must not sleep'); }, outDir,
    });

    assert.equal(result.rows.length, 2);
    assert.equal(result.scored.overall.total, 2);
    assert.equal(result.scored.overall.correct, 2);
    assert.equal(result.meta.scenario_count, 2);
    assert.equal(result.meta.usable_count, 2);
    assert.match(result.meta.sudus_head, /^[0-9a-f]{40}$/);
    assert.match(result.meta.policy_digest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(result.meta.started <= result.meta.finished);

    const written = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8'));
    assert.deepEqual(written.rows.map((r) => r.id), ['X1', 'X2']);
    assert.equal(written.meta.model, 'verdict-151m-d2528239');

    const md = readFileSync(join(outDir, 'results.md'), 'utf8');
    assert.match(md, /Route accuracy/);
    assert.match(md, /2\/2/);
    assert.ok(!/[^\x00-\x7f]/.test(md));
  });
});
