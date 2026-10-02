// tests/bench/scoring.mjs
//
// The offline benchmark scorer (plan 18 Task 2). Pure data in, pure data/text out: this module
// imports nothing from lib/, so a scoring change never needs a rerun of any recorded results
// file. `predictedRoute` is the one piece of routing logic this plan needs outside
// lib/evaluate.mjs: it only reads a measurement's already-computed outcome/suggested fields
// (lib/records.mjs's 'measurement' schema, plan 15 Task 2/9), mirroring lib/wake.mjs's own
// reading of that outcome -- it never reimplements the veto or composite math itself.
import { readFile } from 'node:fs/promises';

const DIMENSIONS = ['evidence', 'reach', 'contract', 'surface', 'ambiguity'];
const CLASSES = ['agent', 'developer'];

// Task 2 review, Minors: named so a caller can assert.throws/assert.rejects against it
// specifically, rather than a bare Error a malformed-input bug could equally throw.
export class ScoringError extends Error {}

// A 'composite' outcome predicts its own `suggested` route; floor/veto are deterministic
// forced-developer decisions. `unavailable` and `indeterminate` are transport/execution failures,
// not route predictions: scoring them as developer would inflate developer accuracy when a model
// never produced a usable measurement.
//
// Task 2 review Minor: the real finalizeMeasurement (lib/evaluate.mjs) always sets `suggested`
// for a 'composite' outcome, so a null suggested here only ever comes from a hand-built or
// corrupted results row. Returning it as-is used to hand scoreRun a bare `null` predicted value,
// which confusion[expect][predicted]++ would then record as a stray 'null' key never seen in the
// fixed agent/developer confusion matrix, rather than surfacing the bad data.
export function predictedRoute(measurement) {
  if (measurement.outcome === 'composite') {
    if (measurement.suggested == null) throw new ScoringError('predictedRoute: a composite measurement has no suggested route');
    return measurement.suggested;
  }
  if (measurement.outcome === 'floor' || measurement.outcome === 'veto') return 'developer';
  if (measurement.outcome === 'unavailable' || measurement.outcome === 'indeterminate') return null;
  throw new ScoringError(`predictedRoute: unknown measurement outcome ${JSON.stringify(measurement.outcome)}`);
}

function accuracyOf(pairs) {
  return { correct: pairs.filter((p) => p.predicted === p.expect).length, total: pairs.length };
}

// rows: [{id, expect, category, measurement}] -> {overall, byExpect, confusion, misrouted, dimensionSeparation}
export function scoreRun(rows) {
  const pairs = [], unavailable = [];
  for (const r of rows) {
    const predicted = predictedRoute(r.measurement);
    const item = { id: r.id, expect: r.expect, predicted, deciding: r.measurement.outcome, category: r.category };
    if (predicted === null) unavailable.push(item);
    else pairs.push(item);
  }

  const overall = accuracyOf(pairs);
  const byExpect = Object.fromEntries(CLASSES.map((c) => [c, accuracyOf(pairs.filter((p) => p.expect === c))]));

  const confusion = Object.fromEntries(CLASSES.map((e) => [e, Object.fromEntries(CLASSES.map((p) => [p, 0]))]));
  for (const p of pairs) confusion[p.expect][p.predicted]++;

  const misrouted = pairs.filter((p) => p.predicted !== p.expect);

  const categories = [...new Set(rows.map((r) => r.category).filter((x) => x !== undefined))].sort();
  const byCategory = Object.fromEntries(categories.map((category) => [category, accuracyOf(pairs.filter((p) => p.category === category))]));
  const coverage = {
    rows: rows.length,
    scorable: pairs.length,
    unavailable: rows.filter((r) => r.measurement.outcome === 'unavailable').length,
    indeterminate: rows.filter((r) => r.measurement.outcome === 'indeterminate').length,
    abstention: rows.filter((r) => r.measurement.outcome === 'unavailable' && /\babstention\b/.test(r.measurement.reason ?? '')).length,
  };

  // Mean level per dimension, split by expected class, over rows that actually carry levels
  // (a floor/unavailable/indeterminate outcome has an empty levels list and is excluded from the
  // mean rather than treated as a zero).
  const dimensionSeparation = Object.fromEntries(DIMENSIONS.map((d) => {
    const meanFor = (expectClass) => {
      const values = rows
        .filter((r) => r.expect === expectClass && r.measurement.levels.length > 0)
        .map((r) => r.measurement.levels.find((l) => l.dimension === d)?.level)
        .filter((v) => v !== undefined);
      return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
    };
    const agentMean = meanFor('agent');
    const developerMean = meanFor('developer');
    const separation = agentMean !== null && developerMean !== null ? Math.abs(agentMean - developerMean) : null;
    return [d, { agentMean, developerMean, separation }];
  }));

  const dimensionError = Object.fromEntries(DIMENSIONS.map((dimension) => {
    const errors = [];
    for (const row of rows) {
      if (row.gold?.label_status !== 'adjudicated' || typeof row.gold?.dimensions?.[dimension] !== 'number') continue;
      const level = row.measurement.levels.find((item) => item.dimension === dimension)?.level;
      if (typeof level === 'number' && Number.isFinite(level)) errors.push(Math.abs(level - row.gold.dimensions[dimension]));
    }
    return [dimension, { count: errors.length, mae: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null }];
  }));

  return { overall, byExpect, byCategory, confusion, misrouted, unavailable, coverage, dimensionSeparation, dimensionError };
}

// resultsPath -> {meta, rows, scored}: reads a recorded results JSON file ({meta, rows}, the
// shape harness.mjs (Task 3) writes) and scores it. No network call: readFile only.
//
// Task 2 review Minor: a file with no `rows` array (truncated write, wrong file, a meta-only
// stub) refuses here, by name, instead of reaching scoreRun and failing later on `rows.map is
// not a function` or (with a nullish-coalesced rows) silently scoring as zero rows.
export async function scoreFromFile(resultsPath) {
  const raw = JSON.parse(await readFile(resultsPath, 'utf8'));
  if (!Array.isArray(raw.rows)) throw new ScoringError(`scoreFromFile: ${resultsPath} has no rows array`);
  const rows = raw.rows;
  return { meta: raw.meta, rows, scored: scoreRun(rows) };
}

function pct(correct, total) {
  return total === 0 ? 'n/a' : `${((correct / total) * 100).toFixed(1)}% (${correct}/${total})`;
}
function num(v) { return v === null || v === undefined ? 'n/a' : v.toFixed(2); }

// {meta, scored} -> text: mirrors .superpowers/bench/results.md's round-3 table shape (route
// accuracy, confusion matrix, misrouted list, per-dimension separation), scaled down to this
// scorer's own two-way (agent/developer) route rather than the round-3 sweep's grid search.
export function renderResultsMd({ meta, scored }) {
  const lines = [
    '# Sudus evaluator benchmark: results',
    '',
    `Model: ${meta?.model ?? 'n/a'}. ${meta?.note ?? ''}`.trim(),
    '',
    '## Route accuracy',
    '',
    `Overall: ${pct(scored.overall.correct, scored.overall.total)}`,
    '',
    '| expect | accuracy |',
    '|---|---|',
    `| agent | ${pct(scored.byExpect.agent.correct, scored.byExpect.agent.total)} |`,
    `| developer | ${pct(scored.byExpect.developer.correct, scored.byExpect.developer.total)} |`,
    '',
    '## Confusion matrix (rows = expect, cols = predicted)',
    '',
    '| expect \\ predicted | agent | developer |',
    '|---|---|---|',
    `| agent | ${scored.confusion.agent.agent} | ${scored.confusion.agent.developer} |`,
    `| developer | ${scored.confusion.developer.agent} | ${scored.confusion.developer.developer} |`,
    '',
    '## Misrouted',
    '',
    '| id | expect | predicted | deciding |',
    '|---|---|---|---|',
    ...scored.misrouted.map((m) => `| ${m.id} | ${m.expect} | ${m.predicted} | ${m.deciding} |`),
    '',
    '## Unavailable / indeterminate',
    '',
    `Unavailable: ${scored.unavailable.length}`,
    '',
    '| id | expect | outcome |',
    '|---|---|---|',
    ...scored.unavailable.map((m) => `| ${m.id} | ${m.expect} | ${m.deciding} |`),
    '',
    '## Coverage',
    '',
    `Rows: ${scored.coverage.rows}; scorable: ${scored.coverage.scorable}; unavailable: ${scored.coverage.unavailable}; indeterminate: ${scored.coverage.indeterminate}; abstention: ${scored.coverage.abstention}`,
    '',
    '## Route accuracy by category',
    '',
    '| category | accuracy |',
    '|---|---|',
    ...Object.entries(scored.byCategory).map(([category, value]) => `| ${category} | ${pct(value.correct, value.total)} |`),
    '',
    '## Dimension error against adjudicated human gold',
    '',
    '| dimension | gold rows | MAE |',
    '|---|---:|---:|',
    ...Object.entries(scored.dimensionError).map(([dimension, value]) => `| ${dimension} | ${value.count} | ${num(value.mae)} |`),
    '',
    '## Per-dimension separation (mean level, agent-expected vs developer-expected)',
    '',
    '| dimension | agent mean | developer mean | separation |',
    '|---|---|---|---|',
    ...Object.entries(scored.dimensionSeparation).map(([d, s]) =>
      `| ${d} | ${num(s.agentMean)} | ${num(s.developerMean)} | ${num(s.separation)} |`),
    '',
  ];
  return lines.join('\n');
}
