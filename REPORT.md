# Root-cause report: the reasoning-loop stall, and the guard built for it

**Date:** 2026-10-06
**Subject:** `dsh-reasoning-loop-guard` v0.1.0
**Scope:** how the failure was diagnosed, what the guard does, and the evidence that it works.

---

## 1. The problem

A single DSH session (12 turns, 324 steps) ended the same way in **11 of its 12 turns**: the user reported a stall ("卡死 / 又卡了 / 卡思维链") and pressed Stop.

This was not an occasional hiccup. It was the *normal* outcome of that session.

## 2. Root cause (established from the session log)

Decoding the session body — `session.v4.jsonl.zstd`, which turned out to be **1161 concatenated independent zstd frames**, so it must be decompressed frame by frame rather than with a single `zstdDecompressSync()` call — and reading `stopReason` from all 324 `assistant/message` events:

| `stopReason` | Count |
| --- | --- |
| `toolUse` | 312 |
| `stop` | 1 |
| **empty string** | **11** |

The 11 messages with an empty `stopReason` had content consisting of **a single `reasoning` block** — no `text`, no `tool-call`. The model never produced a single executable action.

Three findings pin down the mechanism:

- **The user aborted; nothing crashed.** Every one of the 11 is immediately followed by `{"type":"turn/end","data":{"reason":{"kind":"aborted","reason":{"kind":"user"}}}}`.
- **The repetition is literal.** In all 11 blobs, the final ~400 characters are an endless cycle of the same short phrases (`Emit.` / `OK.` / `Writing.` / `Let me write.` / `Go.` / `Now.`), while the **first ~400 characters are normal, specific engineering reasoning** (reading a screenshot, computing coordinates, choosing which script to patch). The model finished thinking, then got stuck in "about to write the answer" — urging itself onward, never writing.
- **The scale is large and the rate is steady.** turn 1 step 118 ran **208.4 s / 243,997 characters**; turn 2 step 154 ran **200.3 s / 280,888 characters**. Throughput held at 560–1400 chars/s throughout, so this was continuous generation, not a deadlock.

**Conclusion:** not a network fault, not a provider error, not context exhaustion — a **model-side degeneration**, and at the time DSH had **no guard that could notice it and stop early**.

## 3. Mitigation: the guard

Mounted on the `llm/stream` waterfall — the same extension point `dsh-llm`'s own `llm-invariant` gate uses — it measures only the streaming `reasoning-delta` text, **stops pulling from upstream on a verdict**, and emits a terminating chunk:

```js
{ type: "finish", reason: { kind: "error", failure: { message, code: "REASONING_LOOP" } } }
```

Two rules, evaluated every 200 characters over rolling buffers:

| Rule | Definition | Measured (11 positive / 166 negative) | Threshold |
| --- | --- | --- | --- |
| `periodic-run` (primary) | tail holds ≥ `minUnits` consecutive identical units, period ∈ [8, 400] | positives **5..50** units, negatives **0..2** | 4 |
| `kgram-repeat` (secondary) | last 64 characters occur ≥ N times in the window | positives **20..162**, negatives **1..5** | 12 |

The periodic rule carries the detection because its separation margin is far wider; the k-gram rule covers loops whose period falls outside `[minPeriod, maxPeriod]`.

**Only `reasoning-delta` is measured, never `block-end`** — `block-end` replays the whole block text, which would manufacture the very repetition being looked for. `text-delta` is never measured: legitimate long output (tables, code) can repeat, and a missed detection is preferable to a false abort.

**`failureCode` deliberately sits outside the default retryable set** (`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`). Repetition is a property of *the request itself*; an automatic retry re-sends the whole prompt and burns the same tokens to loop again. If retries are wanted, set `failureCode: EMPTY_RESPONSE`.

## 4. Verification (four layers, all passing)

| Layer | Harness | Result |
| --- | --- | --- |
| Detector + stream protocol | `test/test-guard.mjs` | **ALL CHECKS PASSED** |
| Journal + maintenance tool | `test/test-journal.mjs` | **ALL JOURNAL CHECKS PASSED** |
| Host-side half (real `apply()` via stub host) | `test/smoke/smoke.mjs` | **ALL SMOKE CHECKS PASSED** |
| Real stream invariant gate | `test/smoke/real-protocol.mjs` | **ALL REAL-PROTOCOL CHECKS PASSED** |
| **End to end (real CLI + real agent loop)** | `e2e/verify-e2e.ps1` | 11 assertions · **ALL E2E CHECKS PASSED** |

Calibration across six feeding granularities (chunk = 1 / 8 / 40 / 200 / 1000 / 4000): **11/11 detections, 0/166 false positives** at every granularity. First fire lands between ~3000 and ~56000 characters depending on granularity.

The end-to-end rig uses an isolated `DSH_HOME` (`e2e-home/`, rebuilt on every run) plus a test-only provider adapter replaying `test/fixtures/degenerate.json[5]` (7659 characters) through the real `dsh` CLI and a real agent loop. Nothing is a replica — not the loop, not the waterfall, not the invariant gate, not the CLI error surface.

| | Guard armed | Guard off (same stream) |
| --- | --- | --- |
| Exit code | **1** | **0** |
| Upstream actually emitted | **3120 / 7659 chars** | 7659 / 7659 chars |
| Reached its terminal finish | no | yes |
| stderr | `REASONING_LOOP: …（连续重复片段：周期 64 字符，重复 6 次，已读到 3120 字符）` | — |
| stdout | empty | `TG-FAKE-OK` |

The guard **really does cut the upstream generator short** rather than reporting an error after the stream completes; with the guard off, the identical stream runs to completion — ruling out a broken rig.

## 5. Fixtures

The thresholds were calibrated against a real failure, but that session's reasoning text is private. The committed fixtures are therefore **synthetic**, reproducing the *measured shape* of the original data: the same row counts (11 / 166), the same per-row character counts, and the same loop geometry. `tools/make-fixtures.mjs` regenerates them deterministically (seeded), and `tools/scan-fixtures.mjs` is the privacy gate that scans for paths, account identifiers, keys, tokens, phone numbers and e-mail addresses.

## 6. Known limits

- **Not a general-purpose watchdog.** It targets one degenerate shape — contiguous repetition at the tail. A different stall (an infinite tool-call loop, or a model circling semantically without literal repetition) will not trigger it.
- **First-fire position varies** from ~3000 to ~56000 characters with feeding granularity. All eleven recorded failures would have been caught within 10,000 characters.
- **Calibrated on 177 samples from a single session.** The sample is small; if false positives appear in practice, raise `minUnits` / `kgramThreshold` first.
- The user chose to **keep `reasoningEffort: max` unchanged**, so this guard is the only mitigation layer in place.

## 7. Reproducing

```powershell
npm test
pwsh -File e2e/verify-e2e.ps1
```
