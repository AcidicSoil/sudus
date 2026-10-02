# Evaluator Dataset v1 Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned, leakage-checked, human-gold-aware evaluation dataset workflow for Verdict, Jeff, and Kev without changing provider activation or starting a model.

**Architecture:** Keep dataset authoring and validation separate from runtime inference. A pure dataset module owns schema checks, family isolation, semantic fingerprints, dataset loading, and statistics; a small repository CLI exposes validation/stats/migration. The existing benchmark harness can opt into a validated dataset split while preserving its historical default.

**Tech Stack:** Node.js >=24 ESM, JSON/JSONL, Node test runner, existing Sudus benchmark modules.

## Global Constraints

- Real traces and human-authored cases are preferred seeds; synthetic generation is augmentation, never automatic gold.
- Calibration/test/OOD semantic rows require adjudicated five-dimension human gold with at least two annotators.
- Existing 24 benchmark cases remain development-only route labels; do not invent missing dimension labels or human provenance.
- Split by `family_id`; reject a family appearing in more than one split and reject duplicate semantic drafts.
- Semantic accuracy, runtime availability, repeatability, and provider confidence semantics stay separate.
- Verdict/Jeff/Kev share one canonical case representation; provider-specific context/abstention/confidence behavior remains in the inference adapters.
- Existing `npm run bench` behavior remains unchanged unless `SUDUS_BENCH_DATASET` is explicitly set.
- No task starts a model or performs a network request.

---

### Task 1: Dataset contract and validator

**Files:**
- Create: `lib/evaluator-dataset.mjs`
- Create: `tests/evaluator-dataset.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `DatasetError`, `loadDataset(dir)`, `validateDataset({manifest,cases})`, `datasetStats({manifest,cases})`, `caseFingerprint(caseRow)`.
- Consumes: a directory containing `manifest.json` and `cases.jsonl`.

- [x] **Step 1: Add focused failing tests** for a valid minimal dataset and for duplicate IDs, family cross-split leakage, duplicate semantic drafts, invalid dimension values, synthetic-without-parent, and non-adjudicated calibration semantic rows.
- [x] **Step 2: Run `node --test tests/evaluator-dataset.test.mjs`** and verify failure because `lib/evaluator-dataset.mjs` does not exist.
- [x] **Step 3: Implement the minimum pure validator/loader/stats functions.** Reject unknown manifest/case contract values, require five dimensions only for adjudicated semantic gold, require at least two distinct annotators for adjudicated rows, and keep runtime-contract rows out of semantic-gold requirements.
- [x] **Step 4: Re-run the focused test** and expect all dataset contract tests to pass.
- [x] **Step 5: Run `node --test tests/settings.test.mjs tests/bench/scoring.test.mjs`** to ensure no existing contract changed.
- [x] **Step 6: Commit the passing deliverable** as `feat: add evaluator dataset contract`.

### Task 2: Deterministic legacy seed migration and dataset CLI

**Files:**
- Create: `scripts/evaluator-dataset.mjs`
- Create: `evals/datasets/sudus-routing-v1/manifest.json`
- Create: `evals/datasets/sudus-routing-v1/cases.jsonl`
- Modify: `tests/evaluator-dataset.test.mjs`
- Modify: `package.json`

**Interfaces:**
- CLI: `node scripts/evaluator-dataset.mjs check <dataset-dir>`; `stats <dataset-dir>`; `seed-legacy <scenarios.json> <dataset-dir>`.
- Migration output: one development/semantic/core/legacy case per existing scenario, route-only gold, no fabricated dimension labels or annotators.

- [x] **Step 1: Add failing tests** that seed a temporary dataset from `tests/bench/scenarios.json`, assert 24 rows, balanced 12/12 routes, development-only split, route-only gold, and byte-stable rerun output.
- [x] **Step 2: Run the focused test** and verify the CLI/migration behavior is absent.
- [x] **Step 3: Implement the CLI and deterministic migration**, then generate the committed v1 manifest/cases with the tool itself.
- [x] **Step 4: Run `npm run dataset:check` and `npm run dataset:stats`** and verify the committed dataset is valid and reports 24 legacy development cases.
- [x] **Step 5: Re-run `node --test tests/evaluator-dataset.test.mjs tests/bench/build.test.mjs`**.
- [x] **Step 6: Commit the passing deliverable** as `feat: seed evaluator dataset from benchmark cases`.

### Task 3: Dataset-backed benchmark selection

**Files:**
- Modify: `tests/bench/harness.mjs`
- Modify: `tests/bench/harness.test.mjs`
- Modify: `README.md`
- Modify: `docs/manual.md`

**Interfaces:**
- New explicit environment inputs: `SUDUS_BENCH_DATASET=<dir>`, optional `SUDUS_BENCH_SPLIT=<development|calibration|test|ood>`.
- Dataset cases map to the existing benchmark scenario shape while retaining `family_id`, `split`, and gold dimension metadata in result rows.

- [x] **Step 1: Add failing harness tests** proving an explicit dataset+split selects only matching semantic cases, preserves family/gold metadata, and rejects an invalid dataset before spawning any measure process.
- [x] **Step 2: Run `node --test tests/bench/harness.test.mjs`** and verify the missing dataset-selection behavior fails.
- [x] **Step 3: Implement dataset selection** using `loadDataset`; keep the current hard-coded scenario default when `SUDUS_BENCH_DATASET` is absent.
- [x] **Step 4: Re-run the focused harness tests** and expect pass.
- [x] **Step 5: Run `node --test tests/bench/*.test.mjs tests/evaluator-dataset.test.mjs`**.
- [x] **Step 6: Commit the passing deliverable** as `feat: run benchmarks from evaluator datasets`.

### Task 4: Gold-aware offline scoring

**Files:**
- Modify: `tests/bench/scoring.mjs`
- Modify: `tests/bench/scoring.test.mjs`
- Modify: `docs/spec/evaluator-dataset-v1.md`

**Interfaces:**
- `scoreRun(rows)` additionally returns `byCategory`, `coverage`, and `dimensionError`.
- `dimensionError[dimension]` is `{count, mae}` and only uses rows with numeric adjudicated gold for that dimension and a produced model level.

- [x] **Step 1: Add failing scorer tests** for per-category route counts, unavailable/indeterminate coverage, and exact hand-computed dimension MAE while proving route-only cases do not enter dimension error.
- [x] **Step 2: Run `node --test tests/bench/scoring.test.mjs`** and verify the new metrics are absent.
- [x] **Step 3: Implement the minimum pure scoring additions** without redefining provider confidence as correctness probability.
- [x] **Step 4: Re-run the scorer tests** and expect pass.
- [x] **Step 5: Run `node --test tests/evaluator-dataset.test.mjs tests/bench/*.test.mjs`** and `git diff --check`.
- [x] **Step 6: Commit the passing deliverable** as `feat: score evaluator gold by category and dimension`.

### Task 5: Final verification and research handoff

**Files:**
- Modify: `docs/superpowers/research/2026-09-27-local-inference-validation.md`
- Modify: `docs/superpowers/plans/2026-09-28-evaluator-dataset.md`

**Interfaces:**
- No new runtime interface; records the implemented dataset capability and remaining human-data work.

- [x] **Step 1: Run `npm run dataset:check` and `npm run dataset:stats`**.
- [x] **Step 2: Run the full changed-surface test set**: `node --test tests/evaluator-dataset.test.mjs tests/bench/*.test.mjs tests/inference*.test.mjs tests/evaluate.test.mjs`.
- [x] **Step 3: Run `npm test`** and compare any failures with the known two baseline travel failures.
- [x] **Step 4: Run `npm pack --dry-run --json` and `git diff --check`**; verify the dataset/dev script is not accidentally required at runtime and no generated cache is packaged.
- [x] **Step 5: Update the validation research note** with exact test counts, dataset statistics, and the explicit limitation that v1 currently contains route-only legacy development seeds, not calibration/test gold.
- [x] **Step 6: Commit the verified documentation checkpoint** as `docs: record evaluator dataset workflow`.

## Unresolved product decisions

None block v1. The number and composition of new human-adjudicated calibration/test/OOD families is an evidence-collection decision, not a code-interface decision. V1 intentionally makes that future work explicit instead of manufacturing labels.
