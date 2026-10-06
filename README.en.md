# dsh-reasoning-loop-guard

[![tests](https://img.shields.io/badge/tests-4%20suites%20passing-brightgreen)](#testing)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[简体中文](README.md) | **English**

> **AI disclosure** — This project was written with AI assistance: the source code, tests, documentation and commit messages were drafted by an AI agent (DSH Agent, running on DeepSeek Harness) under human direction. The human author defined the requirements, made the design decisions and performed the final review.

Detects and aborts **repeating reasoning** in [DSH](https://github.com/deepseek-ai/deepseek-harness) — the "thinking-loop stall" where a model finishes its actual reasoning and then spins forever on *"about to write the answer"*, burning minutes and hundreds of thousands of characters before the user gives up and hits Stop.

It turns a multi-minute silent hang into an immediate, visible error.

## The problem it solves

In one recorded session (12 turns, 324 steps), **11 of the 12 turns** ended the same way:

- The model **had already finished the real engineering work** — reading screenshots, computing coordinates, deciding which script to patch.
- It then stalled on "preparing to output", repeatedly urging itself on without ever writing:
  `Let me write. Go. OK. Emit. Now.` / `Writing. OK. Let me write. Go.`
- A single step emitted **240,000–280,000 characters** over **208 seconds**, ending only when the user pressed Stop.

Those 11 assistant messages had an **empty `stopReason`**, and their content was **a single `reasoning` block** — no `text`, no `tool-call`. The model never produced a single executable action; it was idling inside its own thinking.

DSH had no guard that could notice this and stop early.

## How it works

The plugin mounts on the `llm/stream` waterfall — the same extension point DSH's own `llm-invariant` gate uses — measures only the streaming reasoning text, and **stops pulling from upstream the moment a verdict fires**, then emits a terminating chunk:

```js
{ type: "finish", reason: { kind: "error", failure: { message, code: "REASONING_LOOP" } } }
```

DSH then handles it through its existing provider-error path: the step ends with a visible error instead of idling silently.

Two rules are evaluated every `every` characters over rolling buffers:

| Rule | Definition | Measured (11 positive / 166 negative) | Threshold |
| --- | --- | --- | --- |
| `periodic-run` (primary) | The buffer tail holds ≥ `minUnits` **consecutive identical units** of period p ∈ [8, 400] | positives **5..50** units, negatives **0..2** | 4 |
| `kgram-repeat` (secondary) | The last `kgram` characters occur ≥ `kgramThreshold` times in the window | positives **20..162**, negatives **1..5** | 12 |

The periodic rule is primary because it separates the two populations far more sharply; the k-gram rule catches loops whose period falls outside `[minPeriod, maxPeriod]`.

Both rules score **11/11 detections and 0/166 false positives** across six feeding granularities (chunk = 1 / 8 / 40 / 200 / 1000 / 4000).

**Only `reasoning-delta` is measured, never `block-end`** — the latter replays the whole block text, which would manufacture the very repetition being looked for. **`text-delta` is never measured**: ordinary long output (tables, code) can legitimately repeat, and a missed detection is better than a false abort.

## Installation

```powershell
# from your DSH profile directory (e.g. ~/.dsh/profiles/desktop)
npm install dsh-reasoning-loop-guard
```

Then register the bundle in the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-reasoning-loop-guard"]
    }
  }
}
```

Or mount it directly in the profile's `cordis.patch.yml` (this is what the package ships):

```yaml
- insert:
    - id: reasoning-loop-guard
      name: dsh-reasoning-loop-guard
      config: {}
```

The patch reloads live; no DSH restart is required.

## Configuration

Every field can be overridden in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: reasoning-loop-guard
      name: dsh-reasoning-loop-guard
      config:
        enabled: true
        minUnits: 4                # periodic-run: consecutive repeated units
        kgramThreshold: 12         # kgram-repeat: occurrences of the tail k-gram
        minChars: 1500             # do not judge below this many characters
        every: 200                 # evaluate every N characters
        failureCode: REASONING_LOOP

        # fire journal (see below)
        journal: true
        journalPath: ""            # default: $DSH_HOME/dsh-reasoning-loop-guard/fires.jsonl
        journalMaxBytes: 524288
        journalPreviewChars: 120
        logTool: true              # register the reasoning_loop_log tool
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When false the plugin registers no stream hook at all. |
| `minChars` | `1500` | Reasoning shorter than this is never judged. |
| `every` | `200` | Evaluation cadence, in characters. |
| `window` | `4096` | Rolling window for the k-gram rule. |
| `kgram` | `64` | Length of the tail fragment the k-gram rule tracks. |
| `kgramThreshold` | `12` | Occurrences within `window` needed to fire. |
| `periodTail` | `1200` | Rolling window for the periodic rule. |
| `minPeriod` / `maxPeriod` | `8` / `400` | Period range searched by the periodic rule. |
| `minUnits` | `4` | Consecutive identical units needed to fire. |
| `failureCode` | `REASONING_LOOP` | Failure code carried by the terminating chunk. |
| `journal` | `true` | Record every fire to a JSONL journal. |
| `journalPath` | `""` | Journal location; empty means the default under `$DSH_HOME`. |
| `journalMaxBytes` | `524288` | Rotate to `<path>.1` once the journal exceeds this. |
| `journalPreviewChars` | `120` | Characters of the offending tail stored per record. |
| `logTool` | `true` | Register the `reasoning_loop_log` tool. |

`validateConfig()` rejects configurations that would **silently fail to work** — `kgram > window`, `minPeriod >= maxPeriod`, `periodTail < 2 * maxPeriod`, an empty `failureCode`, a non-positive `every`, and so on — with a message naming the offending field.

## Fire journal and the `reasoning_loop_log` tool

Every time the guard fires it appends one JSON line to `$DSH_HOME/dsh-reasoning-loop-guard/fires.jsonl`:

```json
{"v":1,"at":1760000000000,"iso":"2026-10-06T15:20:00.000Z","rule":"periodic-run",
 "atChars":3120,"failureCode":"REASONING_LOOP","pluginVersion":"0.1.0",
 "sessionId":"...","provider":"...","model":"...","units":6,"period":64,
 "preview":"Let me write. Go. OK. Emit. Now. …"}
```

The journal is bounded (`journalMaxBytes`, default 512 KiB → rotates to `fires.jsonl.1`), every write is wrapped in try/catch, and a journal failure **only warns — it never disturbs the stream**. Set `journal: false` to disable it entirely.

The plugin also registers a read-only maintenance tool, `reasoning_loop_log`:

| `action` | Returns |
| --- | --- |
| `list` (default) | Recent fires, newest first. Filter by `rule`, `sessionId`, `since` (epoch ms), and cap with `limit`. |
| `stats` | Totals: count, by rule, by model, by day, plus earliest/latest timestamps. |
| `path` | The resolved journal path. |
| `clear` | Deletes the journal (and its rotated `.1`). |

So "has this been firing, and on which model?" is one tool call away, rather than a hunt through session logs.

## Key design decisions

**`failureCode` deliberately sits outside the default retryable set.** The retryable codes are `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`; `REASONING_LOOP` is not among them, so `dsh-llm-retry` will not retry automatically. The reason: repetition is a property of the *request itself*, so an automatic retry re-sends the whole prompt and burns the same tokens to loop again. If you do want retries, set `failureCode: EMPTY_RESPONSE`.

**A fresh detector per stream.** An automatic retry starts counting from zero, so a previous attempt's repetition never accumulates into the next one.

**No hard dependency on the tool service.** The tool is registered through `ctx.inject(["tools"], …)` — an *optional* injection. A hard `inject` would leave the plugin inactive on any host without the tools service, disabling the guard itself for the sake of a diagnostic.

**Zero runtime dependencies.** The plugin imports nothing outside the DSH host packages it declares as peers.

## Testing

```powershell
npm test
```

Four suites, all of which must pass:

| Suite | What it covers |
| --- | --- |
| [`test/test-guard.mjs`](test/test-guard.mjs) | Detector calibration across six chunk sizes, separation margins, `guardStream` protocol conformance (exactly one terminating `finish`, early stop, aborted-signal handling, healthy streams untouched), message rendering. |
| [`test/test-journal.mjs`](test/test-journal.mjs) | `$DSH_HOME` resolution, preview clipping, record shape, parse tolerance, filtering, `stats` aggregation, rotation, and the guarantee that journal failures never throw. |
| [`test/smoke/smoke.mjs`](test/smoke/smoke.mjs) | The real `apply()` driven through a stub host: config validation, exactly one `llm/stream` listener registered globally, tool registration, and the tool's behaviour end to end. |
| [`test/smoke/real-protocol.mjs`](test/smoke/real-protocol.mjs) | The real `@deepseek-ai/dsh-llm` invariant gate, asserting the guard's output is a *legal* stream. |

The smoke suites resolve `@deepseek-ai/*` to the app and profile install locations through [`test/smoke/resolve-hook.mjs`](test/smoke/resolve-hook.mjs), so the host-side half can be exercised without launching DSH.

### End-to-end verification record

During development the guard was additionally verified end to end against the **real `dsh` CLI driving a real agent loop**, on an isolated profile whose default model was a test-only adapter replaying a degenerate reasoning stream. Nothing was a replica: not the loop, not the waterfall, not the invariant gate, not the CLI error surface.

Two arms, eleven assertions:

| | Guard armed | Guard off (same stream) |
| --- | --- | --- |
| Exit code | **1** | **0** |
| Upstream actually emitted | **3120 / 7659 chars** | 7659 / 7659 chars |
| Upstream reached its finish | no | yes |
| stderr | `REASONING_LOOP: … 周期 64 字符，重复 6 次，已读到 3120 字符` | — |
| stdout | empty | `TG-FAKE-OK` |

That is: the guard **really did cut the upstream generator short** (it did not merely report an error after the stream finished), and with the guard off the identical stream completed untouched — ruling out a broken test rig.

> The end-to-end harness is development scaffolding and is not part of the published package. The four suites above are the ones that ship.

## Fixtures

The guard's thresholds were calibrated against a real failure, but that session's reasoning text is private, so the committed fixtures in [`test/fixtures/`](test/fixtures/) are **synthetic**. They reproduce the *measured shape* of the original data — the same row counts (11 / 166), the same per-row character counts (a 244k-character blob, down to 502 characters), and the same loop geometry (unit periods chosen so the k-gram rule counts 20..162 matches and the periodic rule 5..50 units).

The generator is seeded and deterministic, so regenerating reproduces byte-identical files and any diff is a real change.

## Known limits

- **Not a general-purpose watchdog.** The rules target one specific degenerate shape — contiguous repetition at the tail. A different kind of stall (an infinite tool-call loop, or a model circling semantically without repeating itself literally) will not trigger it.
- **Where it first fires** depends on feeding granularity: as early as ~3000 characters, as late as ~56000. All eleven recorded failures would have been caught within 10,000 characters.
- **Calibrated on 177 samples from a single session.** The sample is small. If false positives appear in practice, raise `minUnits` / `kgramThreshold` first.
- The plugin only mitigates the symptom. If your provider offers a lower reasoning effort, that addresses the cause and can be used alongside this guard.

## License

[MIT](LICENSE)
