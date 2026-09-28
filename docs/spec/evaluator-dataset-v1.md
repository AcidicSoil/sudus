# Sudus evaluator dataset v1: specification

Status: implementation specification, 2026-09-28

## Goal

Build a versioned, auditable evaluation corpus for the local Sudus evaluators
Verdict, Jeff and Kev. The corpus must test semantic decision quality without
confusing transport failures, repeatability, or provider-specific confidence
with correctness.

The first version deliberately does **not** claim that the existing 24-case
benchmark is calibrated gold data. Those cases become a legacy development seed
with route-only labels. New calibration, locked-test, and out-of-distribution
cases require human gold labels under the rules below.

## Method sources

The design follows the strongest applicable references found in PAB X likes,
Chrome `Bookmarks bar/trending`, and current primary sources:

- PAB `2099590541650378856`, "Towards Automating Eval Engineering": mine real
  failures/traces, separate deterministic checks from semantic judges, inspect
  verifier failures and reward hacking, and iterate on eval design.
- PAB `2101470551340421321`, "Jev-as-a-Judge for Agent Evals": replay fixed
  examples, use human oracle labels, and measure accuracy separately from
  repeatability.
- PAB `2101745157846823228`: shadow decisions first, evaluate per decision
  family, track confusion matrices and failure cost, and test whether confidence
  predicts errors rather than trusting an aggregate score.
- PAB `2101005056631881865` and Zhu et al., "Establishing Best Practices for
  Building Rigorous Agentic Benchmarks": benchmark task/scorer defects are part
  of benchmark validity and must be checked explicitly.
- PAB `2095668162624618959`, Stanford CS329Z: keep data for optimization and
  evaluation separate, build datasets from traces, prefer targeted benchmark
  coverage, validate judges, and measure reliability.
- Chrome: NVIDIA NeMo Data Designer trace distillation, Meta Synthetic Data Kit,
  Ragas, TensorZero, and evalstate/fast-agent. These are references for seed
  extraction, augmentation, feedback provenance, and scenario execution, not
  automatic sources of gold labels.
- Anthropic, "Demystifying evals for AI agents": begin with real/manual failure
  cases, keep positive and negative behavior balanced, isolate environments,
  prefer deterministic graders when possible, and use repeated trials for
  reliability.
- OpenAI evaluation best practices: combine production, expert-curated,
  historical, and synthetic cases, including typical, edge, and adversarial
  examples, with human calibration of automated graders.
- Shankar et al., "Who Validates the Validators?": human judgments validate the
  evaluator criteria themselves; rubric disagreement is a rubric problem before
  it is a model problem.
- LLMBar and RewardBench 2: construct near-miss/adversarial cases and test judge
  generalization on fresh prompts rather than recycled benchmark examples.
- Harbor and UK AISI Inspect: keep instruction/state, environment, verifier,
  metadata, and scores separable and reproducible.

## Dataset location and files

A dataset version lives under:

```text
evals/datasets/<dataset-name>/
  manifest.json
  cases.jsonl
```

`manifest.json` declares the dataset contract. `cases.jsonl` contains one case
per line so additions and reviews produce narrow diffs.

The repository tool `scripts/evaluator-dataset.mjs` validates datasets and
prints deterministic statistics. It is the executable contract for this spec.

## Manifest schema

Version 1 manifests contain:

```json
{
  "schema": 1,
  "name": "sudus-routing-v1",
  "dimensions": ["evidence", "reach", "contract", "surface", "ambiguity"],
  "splits": ["development", "calibration", "test", "ood"],
  "suites": ["semantic", "runtime_contract"],
  "rules": {
    "family_disjoint_splits": true,
    "human_gold_splits": ["calibration", "test", "ood"]
  }
}
```

Unknown top-level keys are rejected so changes to the dataset contract require a
schema revision rather than silently changing meaning.

## Case schema

Every JSONL row contains:

```json
{
  "schema": 1,
  "id": "case-id",
  "family_id": "stable-source-family",
  "split": "development",
  "suite": "semantic",
  "track": "core",
  "provenance": {
    "kind": "real_trace|human_authored|synthetic_counterfactual|legacy_benchmark",
    "source": "stable source path or URL",
    "source_id": "source-local id",
    "derived_from": []
  },
  "scenario": {
    "category": "contract-change",
    "draft": {
      "concerns": ["EXP-002"],
      "question": "...",
      "recommendation": "...",
      "because": "...",
      "if_wrong": "...",
      "instead": "...",
      "options": ["..."],
      "paths": ["..."]
    }
  },
  "gold": {
    "route": "agent|developer",
    "dimensions": null,
    "label_status": "route_only|independent|adjudicated",
    "annotators": [],
    "adjudicated": false,
    "rationale": null
  }
}
```

### Tracks

`core` cases are intended for apples-to-apples comparison across Verdict, Jeff,
and Kev. They must fit the smallest supported provider context after Sudus
constructs the five questions. Current Verdict 151M therefore remains the
limiting runtime at 512 model tokens; the runtime preflight is authoritative.

`stress` cases intentionally exercise long context, ambiguity, or provider
limits. A context refusal or abstention on a stress case is not silently turned
into a wrong semantic route.

### Gold-label states

- `route_only`: only the final agent/developer route is trusted. No dimension
  calibration or dimension-error claim may use this case.
- `independent`: at least two human annotators independently supplied the five
  dimension scores and route, but unresolved disagreement remains.
- `adjudicated`: disagreements were resolved and the case has final route,
  dimension scores, rationale, and annotator provenance.

Calibration, locked-test, and OOD cases must be `adjudicated`. Development may
contain route-only legacy cases while the rubric is being built.

Each adjudicated semantic case has all five dimension scores in the closed
interval `[0, 4]`, at least two distinct annotator IDs, `adjudicated: true`, and
a non-empty rationale tied to source evidence.

## Provenance and synthetic data

Real traces and human-authored cases are preferred seeds. Synthetic generation
is augmentation, not an oracle.

A `synthetic_counterfactual` case must name at least one `derived_from` case ID.
All derivatives share the source family unless a reviewer explicitly creates a
new family because the causal scenario changed materially.

Synthetic cases may enter calibration/test/OOD only after human adjudication.
The model that generated a case never establishes its gold label.

## Family isolation and leakage

Every case in one `family_id` must use the same split. A source case, paraphrase,
near-miss, option-order swap, and controlled counterfactual therefore cannot be
split between tuning and evaluation data.

The validator also fingerprints the semantic draft fields. Two identical drafts
with different IDs are rejected even if their metadata differs. This catches
accidental duplicate leakage before a live model run.

## Scenario coverage

Dataset growth should cover these independent axes rather than only adding more
rows of the same type:

- evidence: verified, partial, stale, irrelevant, missing, contradictory;
- reach: local, file, module, subsystem, repository, external system;
- contract: none, internal behavior, public API, schema/data, agreed requirement;
- surface: no new artifact, file/module, command/output, dependency, secret or
  network/external service;
- ambiguity: clear, underspecified, multiple reasonable options, contradictory;
- interactions: one severe dimension, several moderate dimensions, evidence for
  a risky recommendation, and superficially harmless wording hiding high reach;
- adversarial variants: paraphrase, negation, distractors, stale decisions,
  option-order changes, authoritative-sounding unsupported claims;
- runtime-contract cases: unavailable provider, wrong identity, abstention,
  oversized context, malformed output, and fail-closed behavior.

Runtime-contract cases belong to the `runtime_contract` suite and are not route
accuracy examples.

## Split policy

Use four split names:

- `development`: rubric design, tooling development, and legacy route-only seeds;
- `calibration`: threshold/weight/confidence studies after the rubric is frozen;
- `test`: locked semantic evaluation; do not inspect while tuning;
- `ood`: novel scenario families and adversarial forms held out from tuning.

Splitting is by `family_id`, never by row. The validator makes cross-split family
leakage invalid.

## Metrics

Semantic accuracy and runtime availability are reported separately.

For semantic cases report:

- route accuracy and agent/developer confusion matrix;
- per-category route accuracy;
- false-agent and false-developer cases;
- veto incidence;
- per-dimension mean absolute error against adjudicated dimension gold;
- coverage: scorable, unavailable, indeterminate, and abstention counts.

For repeatability, rerun the exact same frozen case and report route consistency
plus per-dimension score variance. Repeatability never substitutes for oracle
agreement.

Provider confidence remains provider-specific:

- Verdict: `distribution_concentration` plus abstention probability;
- Jeff: `distribution_peakedness`;
- Kev: `score_confidence`.

Do not compare those values as if they were the same probability of correctness.
Any later calibration report must be per backend/model/policy and use held-out
human outcomes. Reliability diagrams may be used once a concrete correctness
binary is defined; Brier score alone must not be labeled a calibration score.

## Legacy seed migration

The existing `tests/bench/scenarios.json` contains 24 balanced route examples.
They are retained verbatim as development-only cases:

- provenance kind `legacy_benchmark`;
- one family per existing scenario because no derivative relationship is known;
- `gold.label_status = route_only`;
- no invented dimension labels, annotators, or rationales.

The migration is deterministic and rerunnable. A generated legacy seed must
compare byte-for-byte with the committed cases after normalization.

## Acceptance criteria

1. `npm run dataset:check` validates the committed v1 dataset with no model or
   network access.
2. The validator rejects duplicate IDs, cross-split family leakage, duplicate
   semantic drafts, invalid dimension bounds, synthetic cases without a parent,
   and non-adjudicated calibration/test/OOD semantic cases.
3. `npm run dataset:stats` reports case counts by split, suite, route, category,
   provenance kind, and gold-label status.
4. The current 24 benchmark scenarios exist in the v1 dataset as development,
   route-only legacy seeds with no fabricated dimension gold.
5. The benchmark harness can opt into a dataset directory and split while its
   existing default remains compatible with historical runs.
6. Offline scoring reports per-category route metrics and dimension error only
   for cases that actually carry adjudicated dimension gold.
7. No implementation starts a local model or makes a network call.
