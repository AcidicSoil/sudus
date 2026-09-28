import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIMENSIONS = Object.freeze(['evidence', 'reach', 'contract', 'surface', 'ambiguity']);
const SPLITS = new Set(['development', 'calibration', 'test', 'ood']);
const SUITES = new Set(['semantic', 'runtime_contract']);
const TRACKS = new Set(['core', 'stress']);
const ROUTES = new Set(['agent', 'developer']);
const PROVENANCE_KINDS = new Set(['real_trace', 'human_authored', 'synthetic_counterfactual', 'legacy_benchmark']);
const LABEL_STATUSES = new Set(['route_only', 'independent', 'adjudicated']);

export class DatasetError extends Error {}

function fail(message) { throw new DatasetError(`evaluator dataset: ${message}`); }
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function nonempty(v) { return typeof v === 'string' && v.trim().length > 0; }
function uniqueStrings(v) { return Array.isArray(v) && v.every(nonempty) && new Set(v).size === v.length; }

function closed(obj, keys, at) {
  if (!object(obj)) fail(`${at} must be an object`);
  const allowed = new Set(keys);
  for (const key of Object.keys(obj)) if (!allowed.has(key)) fail(`${at} has unknown key ${key}`);
  for (const key of keys) if (!(key in obj)) fail(`${at} is missing ${key}`);
}

function count(items) {
  const out = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function validateManifest(manifest) {
  closed(manifest, ['schema', 'name', 'dimensions', 'splits', 'suites', 'rules'], 'manifest');
  if (manifest.schema !== 1) fail(`manifest schema must be 1; got ${JSON.stringify(manifest.schema)}`);
  if (!nonempty(manifest.name)) fail('manifest name must be a non-empty string');
  if (!Array.isArray(manifest.dimensions) || manifest.dimensions.length !== DIMENSIONS.length ||
      !DIMENSIONS.every((d, i) => manifest.dimensions[i] === d)) {
    fail(`manifest dimensions must be exactly ${DIMENSIONS.join(',')}`);
  }
  if (!uniqueStrings(manifest.splits) || manifest.splits.some((x) => !SPLITS.has(x))) fail('manifest splits contain an unsupported value');
  if (!uniqueStrings(manifest.suites) || manifest.suites.some((x) => !SUITES.has(x))) fail('manifest suites contain an unsupported value');
  closed(manifest.rules, ['family_disjoint_splits', 'human_gold_splits'], 'manifest.rules');
  if (manifest.rules.family_disjoint_splits !== true) fail('manifest.rules.family_disjoint_splits must be true');
  if (!uniqueStrings(manifest.rules.human_gold_splits) || manifest.rules.human_gold_splits.some((x) => !manifest.splits.includes(x))) {
    fail('manifest.rules.human_gold_splits must name declared splits');
  }
}

function validateDraft(draft, at) {
  closed(draft, ['concerns', 'question', 'recommendation', 'because', 'if_wrong', 'instead', 'options', 'paths'], at);
  if (!uniqueStrings(draft.concerns) || draft.concerns.length === 0) fail(`${at}.concerns must contain at least one unique string`);
  for (const key of ['question', 'recommendation', 'because', 'if_wrong', 'instead']) if (!nonempty(draft[key])) fail(`${at}.${key} must be a non-empty string`);
  if (!uniqueStrings(draft.options) || draft.options.length === 0) fail(`${at}.options must contain at least one unique string`);
  if (!uniqueStrings(draft.paths) || draft.paths.length === 0) fail(`${at}.paths must contain at least one unique string`);
}

function validateDimensions(dimensions, at) {
  closed(dimensions, DIMENSIONS, at);
  for (const d of DIMENSIONS) {
    const value = dimensions[d];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 4) fail(`${at}.${d} must be a finite number in the closed 0..4 interval`);
  }
}

function validateGold(gold, row, manifest, at) {
  closed(gold, ['route', 'dimensions', 'label_status', 'annotators', 'adjudicated', 'rationale'], at);
  if (!ROUTES.has(gold.route)) fail(`${at}.route must be agent or developer`);
  if (!LABEL_STATUSES.has(gold.label_status)) fail(`${at}.label_status is unsupported`);
  if (!uniqueStrings(gold.annotators)) fail(`${at}.annotators must contain unique non-empty strings`);
  if (typeof gold.adjudicated !== 'boolean') fail(`${at}.adjudicated must be boolean`);
  if (!(gold.rationale === null || typeof gold.rationale === 'string')) fail(`${at}.rationale must be string or null`);

  const requiresHumanGold = row.suite === 'semantic' && manifest.rules.human_gold_splits.includes(row.split);
  if (requiresHumanGold && gold.label_status !== 'adjudicated') fail(`${at} must be adjudicated for semantic split ${row.split}`);

  if (gold.label_status === 'route_only') {
    if (gold.dimensions !== null) fail(`${at}.dimensions must be null for route_only labels`);
    if (gold.adjudicated) fail(`${at}.adjudicated must be false for route_only labels`);
    return;
  }

  if (row.suite !== 'semantic') fail(`${at}.label_status ${gold.label_status} is only valid for semantic cases`);
  validateDimensions(gold.dimensions, `${at}.dimensions`);
  if (gold.annotators.length < 2) fail(`${at}.annotators must contain at least two humans for ${gold.label_status} labels`);

  if (gold.label_status === 'adjudicated') {
    if (!gold.adjudicated) fail(`${at}.adjudicated must be true for adjudicated labels`);
    if (!nonempty(gold.rationale)) fail(`${at}.rationale must be non-empty for adjudicated labels`);
  } else if (gold.adjudicated) {
    fail(`${at}.adjudicated must be false while label_status is independent`);
  }
}

function validateCase(row, manifest, index) {
  const at = `cases[${index}]`;
  closed(row, ['schema', 'id', 'family_id', 'split', 'suite', 'track', 'provenance', 'scenario', 'gold'], at);
  if (row.schema !== 1) fail(`${at}.schema must be 1`);
  if (!nonempty(row.id)) fail(`${at}.id must be a non-empty string`);
  if (!nonempty(row.family_id)) fail(`${at}.family_id must be a non-empty string`);
  if (!manifest.splits.includes(row.split)) fail(`${at}.split ${JSON.stringify(row.split)} is not declared by the manifest`);
  if (!manifest.suites.includes(row.suite)) fail(`${at}.suite ${JSON.stringify(row.suite)} is not declared by the manifest`);
  if (!TRACKS.has(row.track)) fail(`${at}.track must be core or stress`);

  closed(row.provenance, ['kind', 'source', 'source_id', 'derived_from'], `${at}.provenance`);
  if (!PROVENANCE_KINDS.has(row.provenance.kind)) fail(`${at}.provenance.kind is unsupported`);
  if (!nonempty(row.provenance.source)) fail(`${at}.provenance.source must be a non-empty string`);
  if (!nonempty(row.provenance.source_id)) fail(`${at}.provenance.source_id must be a non-empty string`);
  if (!uniqueStrings(row.provenance.derived_from)) fail(`${at}.provenance.derived_from must contain unique non-empty strings`);
  if (row.provenance.kind === 'synthetic_counterfactual' && row.provenance.derived_from.length === 0) fail(`${at}.provenance.derived_from is required for synthetic_counterfactual cases`);

  closed(row.scenario, ['category', 'draft'], `${at}.scenario`);
  if (!nonempty(row.scenario.category)) fail(`${at}.scenario.category must be a non-empty string`);
  validateDraft(row.scenario.draft, `${at}.scenario.draft`);
  validateGold(row.gold, row, manifest, `${at}.gold`);
}

export function caseFingerprint(row) {
  if (!object(row?.scenario?.draft)) fail('caseFingerprint requires scenario.draft');
  const draft = row.scenario.draft;
  const canonical = JSON.stringify({
    concerns: draft.concerns,
    question: draft.question,
    recommendation: draft.recommendation,
    because: draft.because,
    if_wrong: draft.if_wrong,
    instead: draft.instead,
    options: draft.options,
    paths: draft.paths,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function validateDataset({ manifest, cases }) {
  validateManifest(manifest);
  if (!Array.isArray(cases)) fail('cases must be an array');

  const ids = new Set();
  const familySplits = new Map();
  const semanticFingerprints = new Map();

  cases.forEach((row, index) => {
    validateCase(row, manifest, index);
    if (ids.has(row.id)) fail(`duplicate case id ${row.id}`);
    ids.add(row.id);

    const priorSplit = familySplits.get(row.family_id);
    if (priorSplit !== undefined && priorSplit !== row.split) fail(`family ${row.family_id} crosses split ${priorSplit} -> ${row.split}`);
    familySplits.set(row.family_id, row.split);

    if (row.suite === 'semantic') {
      const fp = caseFingerprint(row);
      const prior = semanticFingerprints.get(fp);
      if (prior !== undefined) fail(`duplicate semantic draft ${row.id} matches ${prior}`);
      semanticFingerprints.set(fp, row.id);
    }
  });

  for (const row of cases) {
    for (const parent of row.provenance.derived_from) if (!ids.has(parent)) fail(`case ${row.id} derived_from unknown case ${parent}`);
  }
  return true;
}

export function datasetStats(data) {
  validateDataset(data);
  const rows = data.cases;
  return {
    total: rows.length,
    by_split: count(rows.map((x) => x.split)),
    by_suite: count(rows.map((x) => x.suite)),
    by_route: count(rows.map((x) => x.gold.route)),
    by_category: count(rows.map((x) => x.scenario.category)),
    by_provenance: count(rows.map((x) => x.provenance.kind)),
    by_label_status: count(rows.map((x) => x.gold.label_status)),
  };
}

export async function loadDataset(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const text = await readFile(join(dir, 'cases.jsonl'), 'utf8');
  const cases = text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line, i) => {
    try { return JSON.parse(line); }
    catch (err) { fail(`cases.jsonl line ${i + 1} is not valid JSON: ${err.message}`); }
  });
  const data = { manifest, cases };
  validateDataset(data);
  return data;
}
