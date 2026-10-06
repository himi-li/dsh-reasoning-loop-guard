# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-06

Initial release.

### Added

- **Reasoning-loop detection** on the `llm/stream` waterfall. Two rules, evaluated every 200 characters over rolling buffers:
  - `periodic-run` (primary) — the tail holds ≥ 4 consecutive identical units with a period in [8, 400].
  - `kgram-repeat` (secondary) — the last 64 characters occur ≥ 12 times in the window.
- **Early stream termination.** On a verdict the guard stops pulling from upstream and emits a terminating `finish` chunk with `code: REASONING_LOOP`, so the step fails visibly instead of idling.
- **Fire journal.** Every fire is appended as one JSON line to `$DSH_HOME/dsh-reasoning-loop-guard/fires.jsonl`, size-bounded and rotated to `.1`. Journal failures only warn — they never disturb the stream.
- **`reasoning_loop_log` maintenance tool** with `list` / `stats` / `path` / `clear` actions, registered through an optional `ctx.inject(["tools"], …)` so a host without the tools service still gets the guard itself.
- **Config validation** that rejects settings which would silently fail to work (`kgram > window`, `minPeriod >= maxPeriod`, `periodTail < 2 * maxPeriod`, empty `failureCode`, non-positive `every`).
- **Four test suites** (`test/test-guard.mjs`, `test/test-journal.mjs`, `test/smoke/smoke.mjs`, `test/smoke/real-protocol.mjs`) and an **end-to-end harness** (`e2e/verify-e2e.ps1`) that drives the real DSH CLI and a real agent loop in both armed and disarmed arms.
- **Deterministic synthetic fixtures** (`tools/make-fixtures.mjs`) reproducing the measured shape of the original failure, plus a **privacy gate** (`tools/scan-fixtures.mjs`) for release checks.

### Notes

- `failureCode` defaults to `REASONING_LOOP`, which is deliberately **not** in the retryable set (`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`). Repetition is a property of the request itself, so an automatic retry would re-send the same prompt and loop again. Set `failureCode: EMPTY_RESPONSE` to opt into retries.
- Calibrated on 177 samples (11 positive / 166 negative) from a single session; 11/11 detections and 0/166 false positives across six feeding granularities.
