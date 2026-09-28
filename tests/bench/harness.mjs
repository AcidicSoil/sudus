// Local inference benchmark. Historical TypeSafe results remain immutable fixtures.
import { writeFile, readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildLedgerProject } from './build.mjs';
import { scoreRun, renderResultsMd } from './scoring.mjs';
import { readLog } from '../../lib/records.mjs';
import { loadSettings } from '../../lib/settings.mjs';
import { policyDigest } from '../../lib/evaluate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const KERNEL = join(REPO_ROOT, 'bin', 'sudus.mjs');
const GIT = '/usr/bin/git'; // Global constraint: /usr/bin/git for every git command this file runs itself.
const SCENARIOS = JSON.parse(await readFile(join(HERE, 'scenarios.json'), 'utf8'));


export class BenchGuardError extends Error {}

export function assertBenchEnabled(env) {
  if (env.SUDUS_BENCH !== '1') throw new BenchGuardError('sudus bench: set SUDUS_BENCH=1 to run the live benchmark (it makes real network calls)');
}

// Only forward process execution essentials, never hosted credentials or harness markers.
export function childEnv(env) {
  const out = {};
  if (env.PATH) out.PATH = env.PATH;
  if (env.HOME) out.HOME = env.HOME;
  return out;
}

function draftArgs(slug, sc) {
  const argv = ['--commitment', slug];
  for (const c of sc.draft.concerns) argv.push('--concern', c);
  argv.push('--question', sc.draft.question, '--recommendation', sc.draft.recommendation, '--because', sc.draft.because,
    '--if-wrong', sc.draft.if_wrong, '--instead', sc.draft.instead);
  for (const o of sc.draft.options) argv.push('--option', o);
  for (const p of sc.draft.paths) argv.push('--path', p);
  return argv;
}

function defaultSpawn(cmd, args, opts) { return spawnSync(cmd, args, opts); }
// One attempt at one scenario: spawn `sudus measure` for it and read back whatever measurement
// record landed on the project's log as a result (readLog before/after, same diffing approach the
// brief's own reference implementation uses).
async function measureScenarioOnce(project, sc, env, spawnImpl) {
  const before = (await readLog(project.dir)).length;
  const r = await spawnImpl(process.execPath, [KERNEL, 'measure', ...draftArgs(project.slug, sc)],
    { cwd: project.dir, encoding: 'utf8', env: childEnv(env) });
  const log = await readLog(project.dir);
  const added = log.slice(before);
  const measurement = added.find((x) => x.kind === 'measurement');
  return { r, measurement };
}

// One attempt per scenario. A recorded unavailable result is never silently retried.
export async function runScenarios(project, scenarios, env, { spawnImpl = defaultSpawn } = {}) {
  const rows = [];
  for (const sc of scenarios) {
    const { r, measurement } = await measureScenarioOnce(project, sc, env, spawnImpl);
    rows.push(measurement ? { id: sc.id, expect: sc.expect, category: sc.category, measurement: measurement.payload }
      : { id: sc.id, expect: sc.expect, category: sc.category, error: `no measurement record written (exit ${r.status}): ${r.stderr}` });
  }
  return rows;
}

function sudusHeadSha() {
  const r = spawnSync(GIT, ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sudus bench: git rev-parse HEAD failed: ${r.stderr}`);
  return r.stdout.trim();
}

// Ruling 2: results.json's meta -- model, agent_ceiling, confidence_floors, weights, the policy
// digest, started/finished timestamps and the sudus kernel's own HEAD SHA -- so the controller can
// judge a run (which kernel commit produced it, under which policy) before committing it. Pure
// function of its inputs, exported for a direct test independent of any I/O.
export function buildMeta({ settings, started, finished, sudusHead, scenarioCount, usableCount, projectDir }) {
  const t = settings.inference;
  return {
    backend: t.backend, model: t.model, agent_ceiling: t.agent_ceiling, confidence_floors: t.confidence_floors, weights: t.weights,
    policy_digest: policyDigest(settings), started, finished, sudus_head: sudusHead,
    scenario_count: scenarioCount, usable_count: usableCount, project_dir: projectDir,
  };
}

// Explicit benchmark source, local-only. Default reports go to a temporary directory
// rather than overwrite the immutable historical Jev benchmark receipts.
export async function runBenchmark({ env = process.env, scenarios = SCENARIOS.scenarios, spawnImpl = defaultSpawn, buildImpl = buildLedgerProject, outDir = null } = {}) {
  assertBenchEnabled(env);
  const startedWallMs = Date.now();
  const startedMonotonicMs = performance.now();
  const started = new Date(startedWallMs).toISOString();
  const project = await buildImpl({ backend: env.SUDUS_BENCH_BACKEND ?? 'verdict',
    model: env.SUDUS_BENCH_MODEL, endpoint: env.SUDUS_BENCH_ENDPOINT });
  const { settings } = await loadSettings(project.dir);
  const rows = await runScenarios(project, scenarios, env, { spawnImpl });
  const finished = new Date(startedWallMs + Math.max(0, performance.now() - startedMonotonicMs)).toISOString();
  const measured = rows.filter((r) => r.measurement);
  const scored = scoreRun(measured);
  const meta = buildMeta({ settings, started, finished, sudusHead: sudusHeadSha(), scenarioCount: scenarios.length, usableCount: scored.overall.total, projectDir: project.dir });
  const outputDir = outDir ?? mkdtempSync(join(tmpdir(), 'sudus-bench-results-'));
  await writeFile(join(outputDir, 'results.json'), JSON.stringify({ meta, rows }, null, 2) + '\n');
  await writeFile(join(outputDir, 'results.md'), renderResultsMd({ meta, rows: measured, scored }));
  return { meta, rows, scored, outputDir };
}

// `node tests/bench/harness.mjs` (and `npm run bench`) runs the live benchmark directly. Node has
// no `import.meta.main`; this is the same "am I the entry module" check scripts/release.mjs and
// scripts/cutlist.mjs already use (already committed, so already proven correct on this Node
// version).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBenchmark().then((r) => { console.log(`wrote ${r.outputDir}/results.md: ${r.scored.overall.correct}/${r.scored.overall.total}`); })
    .catch((e) => { console.error(e instanceof BenchGuardError ? e.message : (e.stack || e.message)); process.exit(1); });
}
