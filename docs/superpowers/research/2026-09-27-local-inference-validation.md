# Local inference validation — 2026-09-27/28

Scope: this evidence establishes operational integration on this host. It does **not** establish Sudus-specific calibration, model parity, or production readiness. Selection priority remains Verdict → Jeff → Kev, with exactly one explicitly selected backend and no automatic fallback. Live servers are loopback-only and are stopped after each bounded check.

## Verdict 151M (not Verdict 2.0)

- Source: `~/tools/openJev-verdict-2.0` revision `bff28567cff463b833bf044f351a8b7945d53e07`. Public model: `~/.local/share/sudus/models/verdict-151m`, Hugging Face revision `8af2496eb63c7fa66d7d234e1f62629380030eb4`, `model.safetensors` SHA-256 `d252823994d47a7933217fc86449493299643af6a0c0d83d6bd5a7666d3253ef`. The sidecar pins the calibrator/tokenizer/config hashes too.
- A real PyTorch/GLiClass single-Score inference succeeded. A five-dimension HTTP probe returned explicit abstention (409), so no completed five-dimensional Sudus measurement was claimed.
- `runtime/verdict_server.py` refuses tracked-source modifications, verifies artifacts, preflights all five tokenized questions against the 512-token path without truncation, preserves abstention, and labels its confidence as `distribution_concentration` rather than correctness probability.
- The specialized Verdict 2.0 `model.pt` remains unavailable at its documented Git LFS object. The public 151M checkpoint is not substituted for it.

## Jeff

- Source: `~/tools/jeff` revision `34b32f99a727c47b679adde33f4702a001e02979`; model `knowledgator/gliformer-large-v1@d0a4e53d09cebe6bc963dd9be319d4279084bb2d`; Python 3.12 environment installed with mise/uv. The source worktree is clean.
- Earlier direct-runtime validation (before the Sudus attestation wrapper was added) produced five Score distributions through `bin/inference.mjs` at temperature 1 / isolate-all and a real temporary Sudus measurement. That establishes model/protocol compatibility, not current wrapper readiness or calibration.
- Current code requires `runtime/jeff_server.py` and its `/sudus-healthz` attestation before any decision state is posted. A stock Jeff server was deliberately rejected as `model_unverified` on six labeled benchmark cases, proving the fail-closed boundary.
- A subsequent wrapper-specific run on isolated port 18000 was stopped after the promised 120-second startup bound because application startup had not completed. No decision state was posted in that attempt, the server was terminated, and the port was closed. Therefore current wrapper-specific labeled validation remains **blocked**, not silently downgraded to stock Jeff.
- The six labeled cases attempted against the attestation-required path (`A02`, `A07`, `D01`, `D05`, `D06`, `D12`) all recorded `unavailable model_unverified`. With the corrected scorer that is **0 scorable / 6 unavailable**, not a developer-route result; there are no Jeff distribution or accuracy claims from that run.
- The wrapper pins source/model/runtime knobs (torch, CUDA, bf16, eager attention, no compile, pad 0, temperature 1, isolate-all) and now refuses a dirty source worktree. Normalized Jeff confidence is explicitly `distribution_peakedness`, not a correctness probability.

## Kev 4B

- Source: `/tmp/sudus-kev-5920` revision `5920c5fe4ca8e0970ed4209ac2c9b8e18bea5109`, clean worktree. Adapter: `jaredpalmer/kev-4b@485ace8703592fcf405488b262449990824cfed1`. Base: `Qwen/Qwen3.5-4B-Base@1001bb4d826a52d1f399e183466143f4da7b741b`. Both pinned snapshots are present.
- `runtime/kev_server.py` verifies source revision/cleanliness, checkpoint provenance, complete pinned base shards, and fixed runtime knobs. Its `/sudus-healthz` attestation reported torch/CUDA/bf16, SDPA, merged adapter, LoRA scale 1, temperature `2.1435469250725863`, CUDA graphs off, fused kernels off, and date preprocessing off.
- A real Sudus measurement through the current wrapper and default `measure()` transport completed with HTTP 200 and persisted `source: kev`, `model: kev-4b-485ace87`:
  - outcome `composite`, suggested `developer`, composite `0.456`
  - ambiguity `2.5229` / confidence `0.4641`
  - contract `1.9589` / confidence `0`
  - evidence `1.572` / confidence `0`
  - reach `1.3418` / confidence `0`
  - surface `0.8636` / confidence `0.2804`
- The host lacked optional `causal_conv1d` and `flash-linear-attention`, so Transformers used correct but much slower reference PyTorch kernels. This is a performance limitation, not an accuracy result.
- The wrapper shut down cleanly after the smoke. Normalized Kev confidence is explicitly `score_confidence`; the zeros above must not be interpreted as cross-model correctness probabilities.
- A six-case labeled benchmark slice (`A02`, `A07`, `D01`, `D05`, `D06`, `D12`) produced 5/6 scorable route matches: all four developer-expected cases matched, `A02` matched agent, and `A07` was conservatively suggested developer. There were no unavailable rows in that slice. Six cases are evidence for integration behavior, not enough data for calibration or a parity claim.
  - `A02` (internal, expect agent): composite `0.328525`, suggested agent.
  - `A07` (no-evidence, expect agent): composite `0.428475`, suggested developer; this is the sole false downgrade in the slice.
  - `D01` (contract-change): composite `0.490020`, suggested developer.
  - `D05` (data-loss): composite `0.425465`, suggested developer.
  - `D06` (security): `surface` veto with surface level `3.8794`; suggested is null because the veto is code-enforced.
  - `D12` (ambiguous): composite `0.397450`, suggested developer.
  - Mean level separation (`developer - agent`, except evidence shown as raw difference because evidence is inverted by the composite): reach `0.1112`, contract `0.508475`, surface `1.043375`, ambiguity `0.222475`; evidence means were `1.41965` agent vs `1.406025` developer, essentially no separation in this small slice.
  - Confidence values vary by dimension and include zeros; Kev reports `score_confidence`, not empirical P(correct), so no cross-model correctness interpretation is made.

## Verification and remaining gates

- Node targeted integration/evaluator/settings/record/benchmark checks after the latest transport/scoring changes: **302 tests; 301 passed, 0 failed, 1 skipped**.
- Full Node suite after those changes: **1,002 tests; 999 passed, 2 failed, 1 skipped**. The two failures are the same `tests/travel.test.mjs` failures reproduced on the untouched baseline before this feature.
- Benchmark scoring now excludes `unavailable` and `indeterminate` measurements from route accuracy and reports them separately. Re-scoring the six-case Jeff wrapper attempt therefore yields **0 scorable predictions / 6 unavailable**, not the misleading 4/6 that the old forced-developer scoring rule could imply. The six-case Kev slice remains **5/6 scorable, 0 unavailable**.
- Dependency-free Python runtime tests: **9 passed** (Verdict sidecar + Jeff/Kev launcher contracts, including dirty-source refusal).
- `npm run test:mod` remains blocked on both baseline and feature worktrees because the installed Claude CLI rejects `claude plugin test` as an unknown command.
- No statistically adequate Sudus-specific calibration has been completed for any backend. Kev has the six-case labeled slice above, but that sample is far below the configured calibration floor and cannot justify confidence floors or parity. Do not use smoke outputs or upstream benchmark claims as substitutes.
- Jeff's current attested wrapper still needs a successful bounded startup plus labeled run. Verdict 151M still needs a non-abstaining five-dimension labeled sample. Kev has current wrapper/runtime evidence but still needs representative labeled calibration and repeatability checks.

## Implementation report

### Selected implementation

- Active configuration is settings schema 2 under `inference`: exactly one explicit `verdict`, `jeff`, or `kev` backend, one backend-prefixed pinned model ID, and one literal-loopback (`127.0.0.1` or `[::1]`) `/v1/systemone` endpoint. `enabled: false` keeps the existing harness review source. There is no fallback chain or hosted TypeSafe credential path.
- `bin/inference.mjs` is the single bounded transport. It attests the selected runtime before decision state is posted, makes at most one model POST, bounds successful response bytes, rejects redirects/model drift/inconsistent score distributions, and normalizes provider-specific confidence semantics without treating them as P(correct).
- Sudus-owned launchers under `runtime/` pin and attest the verified Verdict 151M, Jeff, and Kev runtimes. Verdict 2.0 is deliberately not substituted by the public Verdict 151M checkpoint.
- Local `evaluation-call` records carry backend source, pinned model, and `transport: local`; review records retain their own declared transport. Historical `jev` provenance remains readable.
- `migrateLegacySettings` converts schema-1 `typesafeai` policy fields into a disabled schema-2 `inference` block without selecting or enabling a replacement and without writing/authorizing the protected settings file.

### Superseded integration

- Removed active hosted transport: `bin/typesafeai.mjs`.
- Removed its dedicated hosted-transport tests: `tests/typesafeai.test.mjs`.
- Active README/manual/spec guidance no longer requires or recommends a TypeSafe endpoint/key. Historical Jev benchmark records and dated design history are retained as history rather than rewritten.

### Verification layers

- **Pure/unit/integration (no model server):** local endpoint/config validation, provider attestation contracts, response-size bounds, no redirect/fallback/retry, model mismatch, confidence-kind contracts, distribution/score consistency, settings migration, policy-digest separation, Git-backed measurement records, crash recovery, benchmark scoring, and package contents.
- **Python launcher contracts (no model load):** 9/9 tests for pinned source/artifact checks and launcher behavior.
- **Latest comprehensive changed-surface Node run:** 302 tests; 301 passed, 0 failed, 1 skipped.
- **Latest full Node run:** 1,002 tests; 999 passed, 2 failed, 1 skipped. The two failures are the same pre-existing travel tests reproduced before this feature.
- **Packaging:** `npm pack --dry-run --json` includes `bin/inference.mjs` and all three `runtime/*_server.py` launchers, not generated Python cache files.
- **External tool blocker:** `npm run test:mod` cannot run because the installed Claude CLI does not provide `claude plugin test`; this is also true on the baseline checkout.

### Live-model evidence and hardware

- Host GPU: NVIDIA GeForce RTX 5070 Ti, 16 GB VRAM.
- **Verdict 151M:** exact public weights/artifacts verified; real single-Score inference succeeded; the five-dimensional HTTP probe abstained, so there is no labeled five-dimension accuracy claim. Verdict 2.0's separate checkpoint remains unavailable upstream.
- **Jeff:** exact source/model and runtime knobs are pinned. Earlier direct-runtime five-Score output was compatible, but the current attestation-wrapper bounded startup did not become ready; its labeled attestation-required attempt is 0 scorable / 6 unavailable. No wrapper accuracy claim is made.
- **Kev 4B:** exact source/checkpoint/base are present and the current Sudus wrapper completed a real measurement. The six-case labeled slice is 5/6 scorable / 0 unavailable, with A07 the one conservative false downgrade and D06 a surface veto. Optional optimized kernels were absent, so live inference used slower reference kernels.

### Remaining risks / gates

- No backend has a statistically adequate Sudus-specific calibration sample. Provider confidence values have different definitions and must not be compared as correctness probabilities.
- Verdict 151M still needs a non-abstaining labeled five-dimension sample; Verdict 2.0 remains blocked by its unavailable checkpoint.
- Jeff's Sudus attestation wrapper still needs a successful bounded startup and labeled run.
- Kev needs repeatability and a substantially larger labeled sample (the configured calibration floor is 60 suggested-agent labels) before any confidence-floor or parity claim.
- All local providers remain disabled by default. A user must deliberately configure and authorize a selected backend; schema validity or a smoke test does not activate it automatically.
