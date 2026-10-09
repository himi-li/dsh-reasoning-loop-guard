# dsh-reasoning-loop-guard

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="DSH Reasoning Loop Guard" width="150">
  </picture>
</p>

[![tests](https://img.shields.io/badge/tests-8%20suites%20passing-brightgreen)](#testing)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[简体中文](README.md) | **English**

> **AI disclosure** — This project was written with AI assistance: the source code, tests, documentation and commit messages were drafted by an AI agent (DSH Agent, running on DeepSeek Harness) under human direction. The human author defined the requirements, made the design decisions and performed the final review.

Detects and aborts **repeating reasoning** in [DSH](https://github.com/deepseek-ai/deepseek-harness) — the "thinking-loop stall" where a model finishes its actual reasoning and then spins forever on *"about to write the answer"*, burning minutes and hundreds of thousands of characters before the user gives up and hits Stop.

It turns a multi-minute silent hang into an immediate, visible error.

## Why you need it

**The problem.** The model has already finished the real engineering work — reading screenshots, computing coordinates, deciding which script to patch — and then stalls on "preparing to output", urging itself on without ever writing: `Let me write. Go. OK. Emit. Now.` A single step emits **240,000–280,000 characters** over **200+ seconds**, ending only when the user presses Stop. Those turns end with an **empty `stopReason`** and **a single `reasoning` block** — no `text`, no `tool-call`: no executable action was ever produced, the model was idling inside its own thinking. DSH had no guard that could notice and stop early.

**The approach.** The plugin mounts on the `llm/stream` waterfall (the same extension point DSH's own `llm-invariant` gate uses), **measures only the streaming reasoning text**, and every 200 characters evaluates five criteria over a rolling buffer. The moment one fires it **stops pulling from upstream** and emits a terminating chunk carrying `code: "REASONING_LOOP_GUARD"`, which DSH then handles through its existing provider-error path.

**The result.** All 11 recorded real failures were **caught within 10,000 characters**; across 2,799 real reasoning streams from this machine (19.2 M characters) it fires 7 times, and **every one is a real loop**. For how the thresholds were derived, see [The problem it solves](#the-problem-it-solves) and [Why `line-repeat` needs two conditions](#why-line-repeat-needs-two-conditions).

## Contents

- [Why you need it](#why-you-need-it) · [The problem it solves](#the-problem-it-solves) · [How it works](#how-it-works)
- [Install](#install) · [Configuration](#configuration) · [Feature switches](#feature-switches)
- [The fire journal and GUI panel](#the-fire-journal-gui-panel-and-the-reasoning_loop_log-tool)
- [Key design decisions](#key-design-decisions) · [Testing](#testing) · [Known limits](#known-limits)

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
{ type: "finish", reason: { kind: "error", failure: { message, code: "REASONING_LOOP_GUARD" } } }
```

DSH then handles it through its existing provider-error path: the step ends with a visible error instead of idling silently.

Five rules are evaluated every `every` characters over rolling buffers:

| Rule | Definition | Measured peak (11 positive / 166 negative) | Threshold |
| --- | --- | --- | --- |
| `periodic-run` (primary) | The buffer tail holds ≥ `minUnits` **consecutive identical units** of period p ∈ [8, 400] | positives **0..8** units, negatives **0..2** | 4 |
| `block-repeat` | The same `blockMin`-character block occurs ≥ `blockCount` times in the window (across lines and formatting) | positives **0..2**, negatives **0..0** | 4 |
| `line-repeat` | The same line (≥ `lineMin` characters) occurs ≥ `lineCount` times **and** those repeats occupy ≥ `lineShare` of the window | positives **2..2**, negatives **0..0** | 3 + 10% |
| `kgram-repeat` | The last `kgram` characters occur ≥ `kgramThreshold` times in the window | positives **1..5**, negatives **1..1** | 12 |
| `filler-run` (last resort) | The **raw** text ends with ≥ `fillerRun` consecutive decoration characters (whitespace / punctuation / symbols) | see "Decoration is not a loop" below | 400 |

The rules are **disjunctive**: a positive need not trip any particular one, only reach any threshold. Of the 11 recorded failures, **2 were caught by `periodic-run` and 9 by `line-repeat`**; the best ratio across negatives only reaches **0.50** while the lowest positive reaches **1.00**.

### Why `line-repeat` needs two conditions

"The same line twice" is normal when reasoning while writing code or docs — a refactor puts one identifier on two lines, a changelog draft writes `## Unreleased` twice — and either one aborts the user's stream. The 177-sample calibration set **could not show this**, because its 11 positives and 166 negatives are **all prose** and contain none of the "reasoning while writing code" failure shape: on that shape, `0/166` proves nothing at all.

The real calibration was therefore redone on **2,799 reasoning streams from this machine** (19.2M characters, including the 11 known loops). The old defaults fire **180 times** on that corpus (`line-repeat` 177, `block-repeat` 3); the new defaults fire **7 times, all of them real loops**. What the numbers said:

- **Count alone does not separate.** The commonest healthy tic, `Let me write.`, reaches 17 occurrences while the weakest real loop reaches 29 — only a 1.7× margin, too thin to justify interrupting a user.
- **Share is the discriminator.** Repeats occupy at most **6.1%** of a healthy window and at least **10.2%** of a looping one. 8% lets two false positives through, 12% misses real loops, so the default is 10%.
- **Count cannot go back to 2 either.** A single 41-character identifier occurring **twice** already pushes the share to 19.5%, which no share floor can catch. 3 and 4 are exactly equivalent on the corpus; 3 keeps the margin.
- **`block-repeat` only needed `blockCount` 3 → 4.** At 3 it fires whenever healthy reasoning *quotes long text* (a hex dump, a plugin-name listing, a restatement of the system prompt); at 4 the corpus yields 3 fires, all real loops. No share floor is applied here on purpose — every value from 0% to 25% gives the same answer, so one would be complexity without evidence.

This also fixed a semantic defect: both rules used to return at the first qualifying unit, so the `count` in the journal always equalled the threshold and never reported the real repetition count. Both now scan the whole buffer for the largest repeating unit, so `count` is a true measurement.

### Why the text is normalized first

The first four rules count on the **normalized** text: whitespace, punctuation and symbols are stripped before anything is measured. That is not cosmetic — it fixes a real false positive. The original implementation ran the periodic rule on the raw buffer, so a model drawing a `________` rule became "8 characters repeated 6 times", the guard really did abort that stream, and the journal kept a record with an eight-underscore preview.

The strip class is `[\s\p{P}\p{S}]`. It is a **strict superset** of the hand-written list it replaced: `_` is `\p{Pc}` (connector punctuation) and `─` / `▁` are `\p{So}`, both of which the old list missed. On all 11 real degenerate blobs the two classes produce **byte-identical output** — so widening it removed decoration only, never a character any real loop depended on.

### Decoration is not a loop, but drawing decoration forever is

Normalization costs one thing: a stream emitting **nothing but** decoration leaves the four counting rules with an empty text and could run forever. `filler-run` exists for exactly that case, and is deliberately dull:

- **It is anchored to the end of the text.** A model may legitimately draw a wide table or an ASCII diagram; once it moves on to prose the decoration is no longer at the tail and stops counting. Only an *ongoing* decoration stream can fire — scanning the whole window would fire on any diagram the model had already finished.
- **The bar sits far above legitimate formatting.** Measured over real shapes, the longest decoration run is **151** characters (a 150-wide ASCII box), then **142** (a 20-column markdown table row), **62** (a setext underline), **5** (a `---` rule); the false positive that motivated the rule was only **8** underscores. The default 400 is 2.6× the widest legitimate shape found, and a genuinely stuck stream crosses it within one `every` interval.

Across six feeding granularities (chunk = 1 / 8 / 40 / 200 / 1000 / 4000) the five rules still score **11/11 detections and 0/166 false positives**.

**Only `reasoning-delta` is measured, never `block-end`** — the latter replays the whole block text, which would manufacture the very repetition being looked for. **`text-delta` is never measured**: ordinary long output (tables, code) can legitimately repeat, and a missed detection is better than a false abort.

## Installation

This package is not published to npm yet — install it from GitHub. DSH isolates profiles: **the desktop build uses `desktop`, the web build uses `web`**, and a plugin only runs in the profile it was installed into. The two commands differ by one name.

### Desktop (`desktop`)

```powershell
# run this from DSH Desktop's bundled command runtime (the standalone npm dsh CLI rejects --profile desktop)
# launch Desktop once to initialize its profile, fully quit the app, then run
dsh plugin --profile desktop add github:himi-li/dsh-reasoning-loop-guard
```

The bundled runtime refuses an uninitialized Desktop profile and will not create an ordinary CLI profile in its place — hence the required "launch once, then fully quit". Reopen Desktop after installing.

### Web (`web`)

```powershell
# any dsh CLI works; the web profile is created and initialized from the shipped template on first use
dsh plugin --profile web add github:himi-li/dsh-reasoning-loop-guard
```

**For the web build, change `desktop` in the command to `web`.** The general form is `dsh plugin --profile <name> add <package>`: `web`, `headless`, `sdk`, `sdk-minimal` and `acp` are initialized from the shipped template on first use, while only `desktop` needs the "launch once, then fully quit" step. The same package can be installed into several profiles independently.

The command records the package in the profile's `dependencies` and automatically appends any package that declares `dsh.bundle` to `dsh.profile.bundles` — both places are written for you, so there is no need to edit `package.json` by hand.

**This package needs no `allowBuilds` approval.** Plugins installed from git usually run a `prepare` build script, which pnpm ≥10 refuses by default until you add `allowBuilds` to the profile's `pnpm-workspace.yaml` and retry. This package ships prebuilt plain JavaScript (`lib/` is committed) and declares no `prepare` script, so the first `add` succeeds as-is. Uninstall with `dsh plugin --profile <name> remove dsh-reasoning-loop-guard`.

If you would rather not use `dsh plugin`, write both places in the profile's `package.json` yourself:

```json
{
  "dependencies": {
    "dsh-reasoning-loop-guard": "github:himi-li/dsh-reasoning-loop-guard"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-reasoning-loop-guard"]
    }
  }
}
```

**Both `dependencies` and `bundles` matter.** DSH's Plugins page only lists packages present in the profile's `dependencies` (that is how "installed" is decided), while `bundles` decides whether it is loaded at all. Registering only in `bundles` still runs the guard, but no card appears on the Plugins page.

When editing by hand there are two ways to mount it: the `dependencies` line above (plus `pnpm install`), or mounting it directly in the profile's `cordis.patch.yml` (which is what this package ships):

```yaml
- insert:
    - id: reasoning-loop-guard
      name: dsh-reasoning-loop-guard
      config: {}
```

**A DSH restart is required after installing or upgrading — refreshing the page is not enough.** Two independent reasons:

1. The host's HMR ignores `node_modules` entirely (`dsh-hmr`'s `ignored` defaults to `**/node_modules`), so file changes inside a package are never noticed.
2. Node's ESM resolver caches each package's `exports` map for the lifetime of the process. After a package adds an export such as `locale/*.json`, that export stays unresolvable **in the running host** — the visible symptom is a card that keeps showing the bare English package name while its icon (read straight from disk, bypassing `exports`) renders fine. Only a restart makes the host re-read the manifest.

**A verification one-liner for package authors**, confirming the metadata resolves without starting DSH:

```powershell
node --input-type=module -e "import { readPluginMeta } from '@deepseek-ai/dsh-app-boot'; console.log(readPluginMeta('dsh-reasoning-loop-guard', 'file:///' + process.argv[1].replace(/\\/g,'/') + '/'))" "$PWD"
```

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
        lineCount: 3               # line-repeat: occurrences of the repeated line
        lineShare: 0.1             # line-repeat: minimum share of the window
        blockCount: 4              # block-repeat: occurrences of the same block
        fillerRun: 400             # filler-run: trailing decoration characters
        minChars: 800              # do not judge below this many characters
        every: 200                 # evaluate every N characters
        failureCode: REASONING_LOOP_GUARD

        # fire journal (see below)
        journal: true
        journalPath: ""            # default: $DSH_HOME/dsh-reasoning-loop-guard/fires.jsonl
        journalMaxBytes: 524288
        journalPreviewChars: 120
        logTool: true              # register the reasoning_loop_log tool

        # feature switches (see "Feature switches" below)
        settingsPath: ""           # default: $DSH_HOME/dsh-reasoning-loop-guard/config.json (patch only)
        recovery:
          enabled: false           # append a corrective message and retry the step
          message: ""              # empty means the built-in wording
          maxRetries: 2            # retries per step (0–10)
        effort:
          enabled: false           # write reasoningEffort back, at the chosen level
          value: low               # off | low | high | max
        stripHistory:
          enabled: false           # strip past turns' thinking, keep the active turn
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. With `false` in the patch the plugin registers no stream hook at all (read once, so changing it needs a restart); the same-named key in the settings file is read per request by the stream listener, so **turning it off takes effect on the next request** (see "Feature switches"). |
| `minChars` | `800` | Reasoning shorter than this is never judged. |
| `every` | `200` | Evaluation cadence, in characters. |
| `window` | `4096` | Rolling window for the k-gram rule. |
| `kgram` | `64` | Length of the tail fragment the k-gram rule tracks. |
| `kgramThreshold` | `12` | Occurrences within `window` needed to fire. |
| `periodTail` | `1200` | Rolling window for the periodic rule. |
| `minPeriod` / `maxPeriod` | `8` / `400` | Period range searched by the periodic rule. |
| `minUnits` | `4` | Consecutive identical units needed to fire. |
| `blockMin` / `blockCount` | `100` / `4` | Block length and occurrence count for `block-repeat`. |
| `lineMin` / `lineCount` / `lineShare` | `10` / `3` / `0.1` | Line length, occurrence count, and the minimum share of the window the repeats must occupy for `line-repeat` (see "Why `line-repeat` needs two conditions"). |
| `fillerRun` | `400` | `filler-run`: trailing decoration characters needed to call it a stall. |
| `failureCode` | `REASONING_LOOP_GUARD` | Failure code carried by the terminating chunk. **Deliberately namespaced** so a third-party plugin's loop recovery cannot cross-talk with this guard (see "Key design decisions"). |
| `journal` | `true` | Record every fire to a JSONL journal. |
| `journalPath` | `""` | Journal location; empty means the default under `$DSH_HOME`. |
| `journalMaxBytes` | `524288` | Rotate to `<path>.1` once the journal exceeds this. |
| `journalPreviewChars` | `120` | Characters of the offending tail stored per record. |
| `logTool` | `true` | Register the `reasoning_loop_log` tool. |
| `settingsPath` | `""` | Where the feature-switch config file lives; empty means the default under `$DSH_HOME`. |
| `enabled` (settings file) | `true` | The GUI's core-guard switch. **Only an explicit `false` turns it off**; once off the plugin watches no stream at all and the three arms go inert with it. |
| `recovery.enabled` | `false` | After a stream is aborted, append a corrective message and retry the same step. |
| `recovery.message` | `""` | Corrective message body; empty means the built-in wording. |
| `recovery.maxRetries` | `2` | Automatic recoveries per step (0–10). |
| `effort.enabled` | `false` | Write the request's `reasoningEffort` back, at the chosen level. |
| `effort.value` | `low` | Effort level: `off` / `low` / `high` / `max`. |
| `stripHistory.enabled` | `false` | Strip past turns' thinking, keeping only the active turn. |

`validateConfig()` rejects configurations that would **silently fail to work** — `kgram > window`, `minPeriod >= maxPeriod`, `periodTail < 2 * maxPeriod`, an empty `failureCode`, a non-positive `every`, and so on — with a message naming the offending field. The feature switches add their own checks: `settingsPath` must be a string, `recovery.maxRetries` a non-negative integer, and `effort.value` one of `off` / `low` / `high` / `max`.

### Feature switches

The last seven rows above (`settingsPath` plus the three switches' six fields) **plus `enabled`** are also editable **in the GUI** — except `settingsPath` itself, which is set only in the patch and merely shown **read-only** in the GUI: open this plugin on the Plugins page and, below the trigger-log panel, the detail view gains five blocks — **loop guard** (the core switch), **automatic recovery** (switch + corrective message + retries per step), **lower reasoning effort** (switch + level), **strip past thinking** (switch), and a read-only **config file** path. Save and it says "Settings saved", writing to `$DSH_HOME/dsh-reasoning-loop-guard/config.json`.

**The core guard defaults to on; all three arms default to off**, in the patch and in the GUI alike. The core switch is the only key whose default is `true` — it *is* the plugin; the three arms each change behaviour beyond the guard itself, so the default takes the conservative side: installing the plugin gets you "detect and abort" and nothing more until you ask for it.

**Turn the core guard off and the three arms go inert with it.** They can only ever react to a failure the guard itself raised, and once the guard watches no stream it raises none — so `recovery` / `effort` do nothing even when they are still on.

**The core switch is not the same thing as the patch key of the same name, but the two never fight.** `enabled: false` in the patch means "register no hooks at all"; it is read once at load, so changing it needs a restart. The `enabled` in the settings file is read **per request** by the stream listener, so **turning it off takes effect on the next request**. The test is "**only an explicit `false` turns it off**": a missing key means "as shipped", i.e. on — so an older `config.json`, or any file that writes only some of the keys, can never be misread as a shutdown.

**Saving needs no restart.** `config.json` overrides the patch **key by key**, and every read folds again, so the change takes effect on the **next request**. That is unlike a code change — code under `node_modules` does not hot-reload (see "Known limits").

**The GUI can write those seven keys and nothing else; detection thresholds always stay in the patch.** That keeps "which file did this fire's threshold come from?" from becoming a question you have to guess at — the `thresholds` snapshot in the journal always corresponds to the patch. Writes are atomic (temp file + rename), and the read side falls back to the baseline on a missing or malformed `config.json` and **never throws**: the worst a broken settings file can do is send the switches back to their defaults, never make the guard inactive.

What each switch does, and what it costs:

- **Automatic recovery** (`recovery.*`). After the guard aborts a stream, it appends a corrective message to the session and retries the same step. **Why the message has to come first**: a retry re-sends **the identical request** (`buildRequest` re-derives messages from the session log, and the aborted `assistant/attempt` does not take part), so a bare retry with no new message necessarily reproduces the same loop. The retry budget is counted **per step** (`sessionId:turn:step`) — per session would disable the arm forever after one bad turn, per attempt would make `maxRetries` meaningless. The message carries the **producer's own `source.kind`** (session format v4 rejects `kind: "plugin"`), which has the side effect that the chat UI renders it as a context note rather than a user bubble. Any internal failure in this arm falls through to `next()`, so a failure stays as terminal as it would be without the plugin.
- **Lower reasoning effort** (`effort.*`). Writes the request's `reasoningEffort` back at the chosen level. This is the arm that addresses the **cause** — repetition is a symptom of too high an effort level, and the guard itself only mitigates the symptom — so if your provider offers a lower level, this arm is more fundamental than the guard. It has to run outside `dsh-agent`'s own `agent/request` listener (the core re-derives provider / model / `reasoningEffort` and drops whatever we set), so it registers with `{ prepend: true }` and writes back after `next()`.
- **Strip past thinking** (`stripHistory.enabled`). The DeepSeek adapter passes historical assistant messages' `reasoning` back as wire-level `thinking` blocks, so on turn *n* the model reads its own thinking from turns 1..n-1 — including the sentence that opened the loop ("let me verify once more") — and replaying that history also inflates the prompt prefix and hurts KV-cache reuse. **The boundary is drawn at the last genuine user turn**: reasoning before it is history and is dropped, reasoning after it belongs to the active turn and is kept. Getting this wrong is not a cosmetic bug — DeepSeek rejects a thinking request whose active-turn reasoning was removed (`The reasoning_content in the thinking mode must be passed back to the API.`), and DSH delivers tool results as `user`-role messages, so the naive "last user message" boundary lands in the middle of a tool loop and strips the active turn. **Its cost should be stated plainly**: the request object handed to `llm/stream` is frozen and `next()` takes no arguments, so changing `messages` means re-entering the runtime with a new options object — and that object is not in the `AGENT_LOOP_REQUESTS` weak set, so `dsh-agent-loop`'s "request still matches what the session log derives" invariant is skipped for it. **That is precisely why it defaults to off**, and why this arm only ever removes content, never invents it.

## Fire journal, the GUI log panel, and the `reasoning_loop_log` tool

### The "Trigger log" panel in the GUI

Open this plugin on DSH's **Plugins** page and its detail view gains a trigger-log panel: recent fires (time, rule, model, characters read, a preview of the offending tail), totals by rule and by model, a one-click clear, and a copy button for the journal path. With no fires yet it says so explicitly instead of rendering a blank box.

The list shows one page of at most **100** records, newest first. Each row keeps its header line (time, rule, measure, where, model) always visible and folds the detail — the full measure, the origin (`turn` / `step` / attempt), the preview, and the thresholds in force — behind a click. The newest record starts expanded, since that is usually the one being explained, and the toolbar carries **Expand all** / **Collapse all**; a row you opened or closed yourself keeps that choice until a bulk action overrides it. The **Collapse list** / **Expand list** button at the far left of the toolbar is a coarser fold: it puts the whole list away, header lines included, leaving only the toolbar and the totals — use it when you want the stats first, or want the panel out of the way for a while. The two folds work on separate levels and never override each other.

Two halves, both shipped in this package:

| File | Role |
| --- | --- |
| [`lib/log-route.js`](lib/log-route.js) | Registers `GET /reasoning-loop-guard/log` on the host's `webServer`, returning `{ path, enabled, version, settings, stats, total, matched, entries }`; supports `limit` / `rule` / `sessionId` / `since`, and `POST` accepts two explicit mutations only — `{"action":"clear"}` and `{"action":"set","patch":{…}}` (both destructive, and deliberately **not** reachable by a link or a prefetch). |
| [`lib/client.js`](lib/client.js) | A hand-written lazy-CJS bundle (**no build step**) that registers the `plugins.bundle.config` slot keyed by package name and renders the card. At runtime it `require`s exactly two platform seed words: `react` and `@deepseek-ai/dsh-client-ui-primitives`. |

**The route carries its own same-origin fence.** The host's `webServer` provides no authentication, so the plugin writes one: a non-loopback `Host`, `Sec-Fetch-Site: cross-site`, or an `Origin` that does not match `Host` all get `403`. Request bodies are capped at 16 KiB (beyond that: `413` and a dropped socket), and any method other than `GET`/`POST` gets `405`. Your browser already carries DSH's renderer access token, so the fence never gets in the way of normal use — but another program that happens to reach the port is kept out.

> If your host provides no `webServer` service at all, `ctx.inject(["webServer"], …)` **silently skips** route registration and the guard itself keeps working. That is deliberate: a diagnostic panel should never be able to make the guard inactive.

### Fire journal

Every time the guard fires it appends one JSON line to `$DSH_HOME/dsh-reasoning-loop-guard/fires.jsonl`:

```json
{"v":1,"at":1760000000000,"iso":"2026-10-06T15:20:00.000Z","rule":"periodic-run",
 "atChars":3120,"failureCode":"REASONING_LOOP_GUARD","pluginVersion":"0.2.0",
 "sessionId":"...","provider":"...","model":"...","purpose":"...",
 "reasoningEffort":"max","turn":17,"step":2,"attemptId":"...","cwd":"...",
 "units":6,"period":64,"elapsedMs":4210,"fromStartMs":18730,"ttftMs":14520,
 "reasoningChars":3120,"aborted":false,
 "preview":"Let me write. Go. OK. Emit. Now. …","previewRaw":"…",
 "thresholds":{"minChars":800,"every":200,"window":4096,"kgram":64,"kgramThreshold":12,
   "periodTail":1200,"minPeriod":8,"maxPeriod":400,"minUnits":4,"blockMin":100,
   "blockCount":4,"lineMin":10,"lineCount":3,"lineShare":0.1,"fillerRun":400}}
```

Fields are omitted when they are unknown, so an older record simply carries fewer of them. The ones worth knowing: `ttftMs` separates "slow model that then started spinning" from "spinning from the first token"; `aborted` records whether the caller had already given up before the verdict landed; `thresholds` is the exact configuration that produced the verdict, which is what you need to reason about a false positive months later; `previewRaw` is the untruncated tail whenever `preview` clipped it; a `line-repeat` record also carries `share`, without which a modest `count` looks unjustified.

**`iso` is stored in UTC; every surface shows local time.** The persisted `iso` is the canonical UTC form (`…Z`), because it has to be unambiguous. What you *read*, though, is always local wall-clock time — the panel's row stamps and its time-span stat, and the `list` rows and `stats` `span:` line of `reasoning_loop_log`, all go through the same `localStamp()`. That is what keeps a fire at 16:25 from looking like one at 08:25. The `stats` "by day" table buckets by **local** day for the same reason, so it can never disagree with the rows above it.

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

**`failureCode` deliberately sits outside the default retryable set.** The retryable codes are `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`; `REASONING_LOOP_GUARD` is not among them, so `dsh-llm-retry` will not retry automatically. The reason: repetition is a property of the *request itself*, so an automatic retry re-sends the whole prompt and burns the same tokens to loop again. If you do want retries, set `failureCode: EMPTY_RESPONSE`.

**`failureCode` is namespaced by default so it cannot cross-talk with another plugin.** Before 0.2.0 the default was the generic `REASONING_LOOP`, and **other plugins ship their own loop detection and drive their own recovery off the failure code**. One real collision measured on this machine: `dsh-our-free-model` v2.0.0 bundles its own `loop-recovery` in `vendor/channel-pack/pack.js`, and it matches `error.code === "REASONING_LOOP"` exactly to decide whether to **auto-resume** — so this guard's aborts were captured as that plugin's own failures, and it responded by calling `agent.followup()` with a message stamped `source.kind: "user"` (indistinguishable from the user typing "continue") to queue a whole new turn. Two consequences, both hard to trace: **(1)** with all three of this plugin's switches off, it still looked like it "fired automatically", because the resume did not come from this plugin at all; **(2)** pressing the stop button did not stop it — the button only aborts the current stream, while the already-queued resume message runs anyway. With `REASONING_LOOP_GUARD` the exact match no longer hits, and this guard's failures go back to being handled purely by `dsh-llm-retry`'s set semantics. If you used this plugin before 0.2.0 and matched on `REASONING_LOOP` somewhere else, you need to follow the rename.

**This cross-talk cannot be rooted out in principle.** The namespace only blocks third-party recovery that matches the generic code **exactly**. If some plugin switches to a prefix match, or also claims `REASONING_LOOP_GUARD`, the collision is back — and the only remaining move is to set `failureCode` to a value neither side claims. Note the reverse direction too: **a loop that another plugin detects on its own still takes that plugin's recovery path**, and this plugin's switches cannot reach it.

**Emergency stopgap: environment variables.** The namespace fixed the **exact-match** collision, but the same class of conflict cannot be rooted out in principle (see the note above). If "every switch is off yet it resumed by itself, and Stop would not stop it" happens again, you can shut down the third party's half with environment variables instead of waiting for a new release of this plugin:

| Variable | Set to | Effect |
| --- | --- | --- |
| `DSH_REASONING_LOOP_GUARD` | `0` | Turns off the third-party plugin's **own** loop detection (it ships its own `createReasoningLoopDetector`, the same one that drives its recovery decision). |
| `DSH_REASONING_LOOP_AUTO_RESUME` | `0` | Turns off the third-party plugin's **automatic resume**. |

Both are read by that plugin as "**on unless set**" (`resolveReasoningLoopGuardFlag()` only treats `0` / `false` / `no` / `off` as off), so you must set them to `0` explicitly. **They only affect that plugin's own behaviour, not this guard** — this plugin reads no `DSH_*` environment variable.

Set them as **system/user environment variables**, not in `~/.dsh/.env`: DSH's launcher reserves the `DSH_` prefix as "settable only by the launching environment", so a value written to `.env` is rejected outright.

```powershell
# Current user, persistent
[Environment]::SetEnvironmentVariable('DSH_REASONING_LOOP_GUARD', '0', 'User')
[Environment]::SetEnvironmentVariable('DSH_REASONING_LOOP_AUTO_RESUME', '0', 'User')
```

**You must sign out and back in (or reboot) for these to take effect; restarting DSH alone is not enough.** Environment variables are broadcast once to process environment blocks by `explorer.exe` at sign-in; processes that already exist — the DSH desktop app and its Host child process included — never receive the later write. Right after setting them, `Get-EnvironmentVariable(...,'User')` or `reg query HKCU\Environment` already reads back `0` while the current process's `$env:` is still empty, which is expected. To verify immediately, quit DSH completely and start it from a **freshly opened** terminal.

**A fresh detector per stream.** An automatic retry starts counting from zero, so a previous attempt's repetition never accumulates into the next one.

**No hard dependency on the tool service.** The tool is registered through `ctx.inject(["tools"], …)` — an *optional* injection. A hard `inject` would leave the plugin inactive on any host without the tools service, disabling the guard itself for the sake of a diagnostic.

**The two optional arms inject `agents`, not `agent`.** `@deepseek-ai/dsh-agent` registers its registry as `super(ctx, "agents")`, so `ctx.inject(["agent"], …)` **never resolves**: Cordis does not call the callback while a dependency is missing, and it raises no warning either. 0.2.2 and earlier asked for the singular `agent`, and the result was that the automatic-recovery and reasoning-effort arms **were never registered** while the GUI switches still read as "on" — turning recovery on left the abort failing terminally with not a single `recovery` line in the log. The singular `agent` is only that plugin's typert **wire type** name, not a Cordis service name; `dsh-llm-retry` sits on the same `agent/request-error` event and injects `["agents", …]`. Two assertions in `test/smoke/smoke.mjs` pin this down (the inject list must contain `agents` and must not contain `agent`; and once `agents` resolves both arms must register).

**Zero runtime dependencies.** The plugin imports nothing outside the DSH host packages it declares as peers.

## Testing

```powershell
npm test
```

Eight suites, all of which must pass:

| Suite | What it covers |
| --- | --- |
| [`test/test-guard.mjs`](test/test-guard.mjs) | Detector calibration across six chunk sizes, separation margins, `guardStream` protocol conformance (exactly one terminating `finish`, early stop, aborted-signal handling, healthy streams untouched), message rendering. |
| [`test/test-journal.mjs`](test/test-journal.mjs) | `$DSH_HOME` resolution, preview clipping, record shape, parse tolerance, filtering, `stats` aggregation, rotation, and the guarantee that journal failures never throw. |
| [`test/test-settings.mjs`](test/test-settings.mjs) | The feature switches' two load-bearing properties: a save is visible to the **next** `get()` (every read folds again), and a malformed file behaves like a fresh install rather than a crash; plus the core switch's default and the boundary that no threshold is writable from the GUI. |
| [`test/test-recovery.mjs`](test/test-recovery.mjs) | The recovery arm's contract is all about **when** it acts: it stands aside when disabled, honours only the guard's own failures, must append a well-formed message before returning `{kind:"retry"}`, must exhaust its per-step budget, and must fall through to `next()` on any internal fault. |
| [`test/test-strip.mjs`](test/test-strip.mjs) | The strip arm's boundary decisions — every check in it exists because removing the active turn's reasoning gets the request rejected by DeepSeek. |
| [`test/test-card.mjs`](test/test-card.mjs) | The log route's same-origin fence decisions, method and query handling, limits and the disabled state, registration through the service, plus the client bundle's protocol shape (actually imported under a `window.__ModuleLoader__` facade) and the card's pure functions. |
| [`test/smoke/smoke.mjs`](test/smoke/smoke.mjs) | The real `apply()` driven through a stub host: config validation, exactly one `llm/stream` listener registered globally, tool registration, the tool's behaviour end to end, and **the optional injects' service names** (it must ask for `agents` and never for the singular `agent`; and once `agents` resolves both arms must register, the effort arm carrying `{ prepend: true }`). |
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
| stderr | `REASONING_LOOP_GUARD: … 周期 64 字符，重复 6 次，已读到 3120 字符` | — |
| stdout | empty | `TG-FAKE-OK` |

That is: the guard **really did cut the upstream generator short** (it did not merely report an error after the stream finished), and with the guard off the identical stream completed untouched — ruling out a broken test rig.

> The end-to-end harness is development scaffolding and is not part of the published package. The eight suites above are the ones that ship.

## Fixtures

The guard's thresholds were calibrated against a real failure, but that session's reasoning text is private, so the committed fixtures in [`test/fixtures/`](test/fixtures/) are **synthetic**. They reproduce the *measured shape* of the original data — the same row counts (11 / 166), the same per-row character counts (a 244k-character blob, down to 502 characters), and the same loop geometry (unit periods chosen so the k-gram rule counts 20..162 matches and the periodic rule 5..50 units).

The generator is seeded and deterministic, so regenerating reproduces byte-identical files and any diff is a real change.

## Known limits

- **Not a general-purpose watchdog.** The rules target one specific degenerate shape — contiguous repetition at the tail. A different kind of stall (an infinite tool-call loop, or a model circling semantically without repeating itself literally) will not trigger it.
- **Where it first fires** depends on feeding granularity: as early as ~3000 characters, as late as ~56000. All eleven recorded failures would have been caught within 10,000 characters.
- **The original calibration was 177 samples from a single session — and it has a known blind spot.** All of them are prose and none of them is the "reasoning while writing code" shape, so the `0/166` measured there **cannot** be extrapolated. The `line-repeat` / `block-repeat` thresholds were later recalibrated on 2,799 real streams (see "Why `line-repeat` needs two conditions"). If false positives still appear in practice, raise `lineShare` (the proportion floor) or `minUnits` / `kgramThreshold` first; if they come from decoration (say your model draws very wide diagrams), raise `fillerRun`.
- **A stream emitting only decoration is caught by the last-resort rule, and its bar is tunable.** See "Decoration is not a loop" above: the default 400 already sits above the widest legitimate formatting measured (151), but raise it if your scenario draws wider.
- **The guard itself only mitigates the symptom.** If your provider offers a lower reasoning effort, that addresses the cause — either turn on the **lower reasoning effort** switch above (see "Feature switches") or lower it directly in your DSH configuration.
- **The core guard and the three arms have different switch semantics — do not conflate them.** The core guard (`enabled`) defaults to **on**; it *is* the plugin. The three arms default to **off**, and each one's cost is spelled out in its own section. `stripHistory` in particular makes `dsh-agent-loop`'s "request still matches what the session log derives" invariant be skipped (see "Feature switches"), and `recovery` appends a message to the session. Those are the reasons for the default, not details to skim past.
- **Cross-talk with a third-party plugin is fixed by the namespace, but this class of collision cannot be eliminated in principle.** Since 0.2.0 this plugin defaults to `REASONING_LOOP_GUARD` (see "Key design decisions"), so third-party recovery logic that exact-matches the generic `REASONING_LOOP` will no longer capture this guard's aborts. But if some plugin switches to prefix matching, or starts claiming `REASONING_LOOP_GUARD` too, the cross-talk comes back — at that point the only remedy is to set `failureCode` to a value neither side recognises. The reverse also holds: **a loop that another plugin detects on its own still goes through that plugin's recovery path**, and this plugin's switches do not reach it. If the cross-talk does recur, `DSH_REASONING_LOOP_GUARD=0` / `DSH_REASONING_LOOP_AUTO_RESUME=0` are an immediate stopgap (see "Key design decisions").

## License

[MIT](LICENSE)
