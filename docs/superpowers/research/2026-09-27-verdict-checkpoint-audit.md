# Verdict checkpoint and documentation audit — 2026-09-27

## Identity: two distinct published claims, not one checkpoint

1. General-purpose Verdict 151M / inference v1.4: `Heman10x-NGU/Verdict-open-jev` (`core/engine_encoder.py`), public weights `heman10x/rlcd-modernbert-151m` revision `8af2496eb63c7fa66d7d234e1f62629380030eb4`; GLiClass model, 143 safetensors tensors, no correctness head. The same code and `artifacts/v2/` exist in `Heman10x-NGU/openJev-verdict-2.0`.
2. Specialized Verdict 2.0: `openJev-verdict-2.0/verdict2/model.py`, marker-pointer and separate correctness heads, checkpoint `artifacts/verdict2-base/model.pt`; the 134-byte Git LFS pointer refers to a 598509338-byte object (`2201b07ca2389fbcb7ca3428c311776ce50482e48b2dca32bdfaf12f641540f7`), whose current LFS fetch responds 404. `heman10x/openJev-verdict-2.0` is not publicly discoverable/accesssible via Hugging Face. The README's 77.1% / dual-channel claims concern this different model and cannot be assigned to 151M v1.4.

## Verified acquisition of available 151M variant

```sh
hf download heman10x/rlcd-modernbert-151m model.safetensors config.json tokenizer.json tokenizer_config.json calibrator.json \
  --revision 8af2496eb63c7fa66d7d234e1f62629380030eb4 --local-dir /tmp/sudus-verdict-151m
sha256sum /tmp/sudus-verdict-151m/model.safetensors
# d252823994d47a7933217fc86449493299643af6a0c0d83d6bd5a7666d3253ef
```

Downloaded on this workstation; weight hash equals `artifacts/ARTIFACTS.json` and `artifacts/v2/bundle_manifest.json`. Published HF model checkpoint is 605529340 bytes. The downloaded calibrator is 1259 bytes, sha256 `af2a876993148efa0726b6ccf710fe2303897d20c0ce8c7c9036eb50f64d23de`, whereas the checked-in `artifacts/ARTIFACTS.json` expects 299 bytes, sha256 `9686e84bb6fb90a8ceabb6994fb9c18ac6a64272d5c413c5f12bed1ee4ccb1b3`. Thus `scripts/download_artifacts.py` (hard-coded `resolve/main`) has a stale manifest and may reject the current calibration artifact; use pinned snapshot and verify each file from the same revision until manifest is repaired. A subsequent local Python smoke test loaded the pinned 143-tensor GLiClass checkpoint with published temperature 2.8039 and produced an actual Score response. This does not validate Sudus-specific semantics.

## Loading/inference cautions from source

- README `DecisionEngine()` defaults to `knowledgator/gliclass-modern-base-v2.0`, not the fine-tuned checkpoint. `scripts/evaluate.py` demonstrates explicit `safetensors.torch.load_file` + `model.load_state_dict(...)` on a GLiClass model; enforce strict checkpoint loading and a matching calibrator and revision.
- The README quickstart omits mandatory `Choice.id` and reads fields not present on `ChoiceResult` (`selected_option_id`, `confidence`); source schemas have `selected_id`, `selected_probability`, `concentration`.
- General-purpose Verdict Score adds `__insufficient_evidence__`; `ScoreResult` has `expected_score`, `probabilities`, `abstention_probability`, but not the 2.0 `correctness` head or Sudus-compatible `confidence` scalar. Do not turn abstention into a silent 0–4 renormalization or invent confidence.
- Both inference engines default to `max_length=512` / truncation; Sudus must preflight true token length and refuse an oversize request without silently dropping evidence.
- `verdict2/evaluate.py` loads a `.pt` checkpoint and cannot consume the published v1 safetensors. Its runbook offers a training procedure, not a verified alternative download route. No GitHub releases with a 2.0 checkpoint were found. `openJev-verdict-2.0` issues #2/#4 independently report the missing LFS object; ask maintainer to publish correct weights with checksum or train/recalibrate distinctly.
- The `openJev-verdict-2.0` repository LICENSE has been challenged as nonstandard/abbreviated Apache terms (issue #2); get license clarity before redistribution.

## Decision for Sudus

Priority `Verdict → Jeff → Kev` stays. Keep `verdict2` unavailable pending a verifiable checkpoint. The publicly downloadable 151M variant can be investigated under an accurately versioned identity and its own Sudus-specific calibration; it is not the Verdict 2.0 model or an automatic fallback. No product-code cutover until the five-dimension distribution, confidence, abstention, no-truncation, and policy invariants pass.

Primary documents: https://github.com/Heman10x-NGU/openJev-verdict-2.0/blob/main/README.md ; https://github.com/Heman10x-NGU/openJev-verdict-2.0/blob/main/RUNBOOK.md ; https://github.com/Heman10x-NGU/openJev-verdict-2.0/blob/main/scripts/download_artifacts.py ; https://github.com/Heman10x-NGU/openJev-verdict-2.0/blob/main/artifacts/ARTIFACTS.json ; https://github.com/Heman10x-NGU/openJev-verdict-2.0/issues/2 ; https://github.com/Heman10x-NGU/openJev-verdict-2.0/issues/4 ; https://huggingface.co/heman10x/rlcd-modernbert-151m ; https://huggingface.co/docs/huggingface_hub/en/guides/download

## Follow-up live implementation evidence

- `gliclass==0.1.20` was installed into isolated `/tmp/sudus-verdict-deps` using mise-managed `uv`; no writes to the read-only Kev Python environment. Actual public Verdict 151M model load and one inference succeeded offline from `/tmp/sudus-verdict-151m` with CPU PyTorch. The single smoke Score response had `expected_score=3.247533620645265` and `abstention_probability=0.22053349862295776` (one prompt; not a benchmark).
- Sudus's new `runtime/verdict_server.py` requires the pinned source commit and exact weights/config/tokenizer/calibrator hashes, preflights five model-tokenized questions against 512 tokens, and publishes `/healthz` on IPv4 loopback. Python isolated contract tests: four passed.
- Actual HTTP `/healthz` returned the expected checkpoint/calibrator hashes; the real five-dimension request returned HTTP 409 due to a model abstention. The complete Sudus measurement must be recorded unavailable and must not invent a missing score or silently switch providers. This is a substantive current readiness limitation for Verdict 151M, not a missing-file failure.
- Jeff and Kev native endpoints were audited from source but no live weights were downloaded for them: root filesystem had approximately 6.4 GiB free, Jeff's published full checkpoint is 2.3 GB, and the cached Kev-4B adapter lacks the larger Qwen base shard. No live semantic accuracy claims are made for them.
- Source-model metadata probes reject a Jeff service unless the configured model ID, HF snapshot path, `JEFF_TEMPERATURE=1`, and `JEFF_ISOLATE=all` match. Kev's native server echoes arbitrary request model names, so the transport probes the resolved snapshot path and declared base from `/v1/models` before sending state.
