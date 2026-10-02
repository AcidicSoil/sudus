# Open-source inference replacement implementation plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development task by task. Mark steps complete only when named evidence exists.

**Goal:** Replace Sudus's optional TypeSafe/Jev inference path with three explicitly selectable open-source implementations, in priority order Verdict → Jeff → Kev, preserving evaluation and decision-record behavior.

**Architecture:** Keep Sudus's five-score state, questions, response validation, deterministic policy math, escalation, and harness review-model workflow. Use one active local backend per measurement with an explicit selector and minimal backend-specific adapters. Never fall back automatically. Preserve past records and explicitly migrate old settings.

**Tech stack:** Node.js 24 ESM, built-in test runner, three individually pinned open-source runtimes, Sudus Git-backed records.

**Spec:** The user's “Sudus — Open-Source Inference Backend Replacement” brief and `docs/spec/sudus-v2.md` section 10. Source and tests establish implementation details.

## Global constraints

- Exactly one explicitly selected active backend (`verdict`, `jeff`, or `kev`); no automatic fallback, open-ended provider registry, hosted TypeSafe API, or mandatory proprietary service.
- Priority is implementation sequence, not automatic model selection or a claim of comparable calibration.
- Five independent 0–4 Score distributions; preserve probability, score, and confidence meaning.
- Preserve floor, veto, composite, suggestion, escalation, audit trail, and existing review-model workflow.
- Treat changed model, request construction, or scoring behavior as a calibration reset.
- Keep historical records readable; do not silently edit protected project settings.
- Check hardware and existing model cache before downloading large weights.

## Verified Verdict artifact identity (2026-09-27)

- The upstream repository contains **two distinct architectures**, not one interchangeable checkpoint. Its public `heman10x/rlcd-modernbert-151m` is the GLiClass/ModernBERT Verdict 151M (v1.4 inference behavior); the separate `verdict2.VerdictModel` expects `artifacts/verdict2-base/model.pt`.
- Pinned public model `heman10x/rlcd-modernbert-151m@8af2496eb63c7fa66d7d234e1f62629380030eb4`: `model.safetensors` 605,529,340 bytes, SHA-256 `d252823994d47a7933217fc86449493299643af6a0c0d83d6bd5a7666d3253ef`. Downloaded and verified to `/tmp/sudus-verdict-151m` with `hf download` and `sha256sum`; calibration and tokenizer files present. This is *not* Verdict 2.0 weights.
- The 2.0 `model.pt` Git LFS pointer references SHA-256 `2201b07ca2389fbcb7ca3428c311776ce50482e48b2dca32bdfaf12f641540f7`, 598,509,338 bytes; `git lfs fetch` returns object-not-found 404. Advertised HF repo `heman10x/openJev-verdict-2.0` is not publicly reachable. See upstream issues #2 and #4; do not silently substitute the GLiClass checkpoint for a 2.0 measurement.
- Upstream `scripts/download_artifacts.py` targets the public 151M variant, but `artifacts/ARTIFACTS.json` is stale for the published `calibrator.json`: manifest says 299 bytes / SHA `9686e84b...`, published pinned file is 1,259 bytes / SHA `af2a8769...`. Use pinned `hf download` and verify exact matching artifacts rather than running that manifest unchecked.
- **Ruling:** Implement the accessible public Verdict 151M variant first under the Verdict option only if full-input, abstention and probability semantics pass. Treat Verdict 2.0 as unavailable until its *own* weight hash and loader are verified. Keep Jeff and Kev at priorities 2 and 3; never automatically switch providers. This is a resource/download gate, not a benchmark parity claim.

## Review focus

- Formally valid but miscalibrated distributions must not be presented as proven parity.
- Missing/extra/NaN probabilities and inconsistent weighted scores fail closed.
- Runtime unavailability records an unavailable outcome; it never silently changes providers.
- Existing projects and historical Jev records remain readable.
- Network-excluded files and credentials never enter inference requests or recorded responses.

---
### Task 1: Freeze contract and validate options in order Verdict → Jeff → Kev

**Read:** `lib/evaluate.mjs`, `bin/typesafeai.mjs`, `lib/settings.mjs`, `lib/records.mjs`, `lib/review.mjs`, `tests/bench/`, current TypeSafe Score/API docs, spec section 10.

- [x] Inventory request/state, five criteria, output types, model identity, error classes, limits, egress, record schemas, and policy digest.
- [x] Select labeled representative cases from the existing benchmark; separate ground-truth labels from prior Jev predictions.
- [x] Screen each listed reference repository for maintained code, license/weight terms, Score API, real distributions, calibration, deployment, hardware, and integration cost. Stop unrelated candidate discovery; verify all three requested providers in the stated order.
- [x] Check available storage and VRAM, existing cache, and actual base-model availability; a cached adapter alone does not count.
- [x] Document each provider’s repository and pin code, model/weights revision, license, API, resource needs, context budget and semantic differences.
- [x] **Gate:** A provider that cannot preserve the complete five-dimensional input/distributions must fail closed or remain unavailable. Verdict 2.0’s documented 512-token encoding must not silently truncate Sudus state.

### Task 2: Prove Verdict first; then Jeff and Kev using one narrow contract

**Create:** `bin/inference.mjs`, `tests/inference.test.mjs` (use repository naming conventions). **Retire after migration:** `bin/typesafeai.mjs`, `tests/typesafeai.test.mjs`.

**Interface:** `post(request, opts = {}) -> Promise<{status: 200, body: string, model: string}>`; classified failures expose `klass`.

- [x] Write failing tests for five Score outputs, model identity, weighted score/distribution consistency, malformed bodies, error classification, timeout, and bounded retry behavior where applicable.
- [x] Implement provider-specific conversion only where required. Verdict’s correctness-head confidence and distribution probability are distinct; do not treat one as the other. Do not fabricate distributions or confidence from a single label.
- [x] Reject unexplained mismatch between reported score and probability-weighted mean.
- [x] Verify no TypeSafe endpoint/key use and no sensitive response/error logging.
- [x] Run `node --test tests/inference.test.mjs` and capture one real response from each available local model. Mark a provider unavailable until its actual pinned weights, tokenizer, and response are verified.

### Task 3: Replace active wiring and transition settings

**Modify as needed:** `lib/evaluate.mjs`, `lib/settings.mjs`, `lib/init.mjs`, directly affected CLI and record readers. **Test:** `tests/evaluate.test.mjs`, `tests/settings.test.mjs`, `tests/records.test.mjs`, `tests/init.test.mjs`, relevant CLI tests.

- [x] Write failing tests for local inference, disabled evaluator's unchanged review path, runtime failure, crash recovery, and policy-digest separation.
- [x] Swap the TypeSafe import, credential handling, model check, and active source identity without changing deterministic floor/veto/composite code.
- [x] Make active configuration name exactly one backend and its pinned local model/runtime; reject obsolete active credentials and non-loopback endpoints.
- [x] Define and test an explicit transition for existing `typesafeai` settings, respecting settings authorization; keep any legacy reader migration-only, not a second runtime.
- [x] Keep old record envelopes and Jev provenance readable; record new backend/model identity without rewriting history.
- [x] Run targeted tests and inspect actual records from an initialized temporary project.

### Task 4: Validate Sudus-specific semantics and authority

**Use:** `tests/bench/` and targeted evaluator integration checks.

- [ ] Run each available pinned backend separately on labeled agent/developer cases, contract conflicts, external-service changes, data changes, uncertain evidence, and ambiguous drafts.
- [x] Compare distributions, weighted score means, confidence, veto incidence, and suggestions against labels; report disagreements and unavailable cases.
- [ ] Check repeatability and whether confidence is calibrated on available labels; schema compliance alone is not accuracy evidence.
- [x] Exercise floor, veto, unavailable, and review-model paths in real Sudus records. Model output cannot expand code-defined authority.
- [x] **Gate:** If representative results are materially unsafe, state truncation occurs, or probability semantics cannot be validated, leave that provider unavailable and do not activate it.

### Task 5: Remove superseded active integration and update guidance

**Inspect/update as relevant:** `README.md`, `docs/manual.md`, `docs/spec/sudus-v2.md`, plugin manifests/skills, examples, scripts, and affected tests.

- [x] Migrate active callers/tests, then remove hosted transport and TypeSafe credentials/config instructions.
- [x] Update active runtime, model-specific limits, error modes, calibration reset, and section 10 while retaining historical decision and benchmark provenance.
- [x] Preserve historical record fixtures rather than rewriting them to resemble new model output.
- [x] Search active paths for TypeSafe endpoint, API key, Jev runtime assumptions, and old imports; justify each remaining historical/migration reference.

### Task 6: Verify and report

- [x] Run targeted adapter/evaluator/settings/records/init/CLI/review tests, then `npm test` and `npm run test:mod` where applicable.
- [ ] Re-run representative cases against each real available pinned model; record command, code/weights revision, resource use, and results.
- [x] Inspect `git diff --check`, full diff, settings transition, and reference scan; confirm unrelated files stayed untouched.
- [x] Report selected implementation, changed/removed files, test totals, actual semantic limits, hardware needs, and remaining risks. Distinguish mock transport tests from live-model validation.

**Execution status:** Priority amended at user request. Implement Verdict → Jeff → Kev in an isolated worktree, one active backend at a time; no silent fallback.

**Baseline:** Prior parallel `npm test` run showed 989 passing / 2 failing tests in push/travel behavior before product changes. Investigate with isolated targeted baseline; do not attribute them to this branch.

**Ruling:** The earlier one-implementation constraint is superseded by the user’s explicit three-option request. This broadens the work and adds separate calibration/availability gates; the deterministic policy and review workflow do not change.
