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

## Verification and remaining gates

- Node targeted integration/evaluator/settings/record/benchmark checks after the latest transport/scoring changes: **302 tests; 301 passed, 0 failed, 1 skipped**.
- Full Node suite after those changes: **1,002 tests; 999 passed, 2 failed, 1 skipped**. The two failures are the same `tests/travel.test.mjs` failures reproduced on the untouched baseline before this feature.
- Benchmark scoring now excludes `unavailable` and `indeterminate` measurements from route accuracy and reports them separately. Re-scoring the six-case Jeff wrapper attempt therefore yields **0 scorable predictions / 6 unavailable**, not the misleading 4/6 that the old forced-developer scoring rule could imply. The six-case Kev slice remains **5/6 scorable, 0 unavailable**.
- Dependency-free Python runtime tests: **9 passed** (Verdict sidecar + Jeff/Kev launcher contracts, including dirty-source refusal).
- `npm run test:mod` remains blocked on both baseline and feature worktrees because the installed Claude CLI rejects `claude plugin test` as an unknown command.
- No statistically adequate Sudus-specific calibration has been completed for any backend. Kev has the six-case labeled slice above, but that sample is far below the configured calibration floor and cannot justify confidence floors or parity. Do not use smoke outputs or upstream benchmark claims as substitutes.
- Jeff's current attested wrapper still needs a successful bounded startup plus labeled run. Verdict 151M still needs a non-abstaining five-dimension labeled sample. Kev has current wrapper/runtime evidence but still needs representative labeled calibration and repeatability checks.
