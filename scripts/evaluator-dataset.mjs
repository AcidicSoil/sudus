import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { datasetStats, loadDataset, validateDataset } from '../lib/evaluator-dataset.mjs';

function sourceRef(path) {
  const rel = relative(process.cwd(), resolve(path)).replaceAll('\\', '/');
  return rel && !rel.startsWith('../') ? rel : path;
}

export function legacyDatasetFromScenarios(raw, { name = 'sudus-routing-v1', source = 'tests/bench/scenarios.json' } = {}) {
  if (!raw || !Array.isArray(raw.scenarios)) throw new Error('legacy scenarios file must contain a scenarios array');
  const manifest = {
    schema: 1,
    name,
    dimensions: ['evidence', 'reach', 'contract', 'surface', 'ambiguity'],
    splits: ['development', 'calibration', 'test', 'ood'],
    suites: ['semantic', 'runtime_contract'],
    rules: { family_disjoint_splits: true, human_gold_splits: ['calibration', 'test', 'ood'] },
  };
  const cases = raw.scenarios.map((sc) => ({
    schema: 1,
    id: sc.id,
    family_id: `legacy:${sc.id}`,
    split: 'development',
    suite: 'semantic',
    track: 'core',
    provenance: { kind: 'legacy_benchmark', source, source_id: sc.id, derived_from: [] },
    scenario: { category: sc.category, draft: sc.draft },
    gold: { route: sc.expect, dimensions: null, label_status: 'route_only', annotators: [], adjudicated: false, rationale: null },
  }));
  const data = { manifest, cases };
  validateDataset(data);
  return data;
}

export function renderDataset(data) {
  validateDataset(data);
  return {
    manifest: JSON.stringify(data.manifest, null, 2) + '\n',
    cases: data.cases.map((row) => JSON.stringify(row)).join('\n') + (data.cases.length ? '\n' : ''),
  };
}

async function writeIfAbsentOrSame(path, expected) {
  let current = null;
  try { current = await readFile(path, 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (current !== null && current !== expected) throw new Error(`refusing to overwrite divergent dataset file ${path}`);
  if (current === null) await writeFile(path, expected);
}

export async function seedLegacy(inputPath, outDir) {
  const raw = JSON.parse(await readFile(inputPath, 'utf8'));
  const data = legacyDatasetFromScenarios(raw, { name: basename(resolve(outDir)), source: sourceRef(inputPath) });
  const rendered = renderDataset(data);
  await mkdir(outDir, { recursive: true });
  await writeIfAbsentOrSame(join(outDir, 'manifest.json'), rendered.manifest);
  await writeIfAbsentOrSame(join(outDir, 'cases.jsonl'), rendered.cases);
  return data;
}

async function main(argv) {
  const [command, a, b] = argv;
  if (command === 'check' && a && !b) {
    const data = await loadDataset(a);
    console.log(`valid ${data.manifest.name}: ${data.cases.length} cases`);
    return;
  }
  if (command === 'stats' && a && !b) {
    console.log(JSON.stringify(datasetStats(await loadDataset(a)), null, 2));
    return;
  }
  if (command === 'seed-legacy' && a && b) {
    const data = await seedLegacy(a, b);
    console.log(`seeded ${data.manifest.name}: ${data.cases.length} cases`);
    return;
  }
  throw new Error('usage: evaluator-dataset.mjs check <dataset-dir> | stats <dataset-dir> | seed-legacy <scenarios.json> <dataset-dir>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}
