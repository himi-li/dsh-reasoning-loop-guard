/**
 * dsh-reasoning-loop-guard — host half (Cordis plugin).
 *
 * Middleware over the `llm/stream` waterfall: it watches streamed reasoning
 * deltas and, when the model starts repeating itself instead of finishing,
 * stops pulling the upstream stream and terminates it with a terminal `finish`
 * chunk carrying an error. DSH then behaves exactly as it does for any provider
 * failure: the step ends with a visible error instead of hanging for minutes.
 *
 * Around that core sit three *optional* arms, all off by default:
 *
 *  - **recovery** (`./recovery.js`): on `agent/request-error`, append a
 *    corrective message and retry the step, so a stuck model gets a nudge
 *    instead of a dead turn.
 *  - **effort downgrade**: lower `reasoningEffort` for the retry, on the theory
 *    that a shorter chain of thought is less likely to re-enter the loop.
 *  - **history strip** (`./strip.js`): stop replaying finished turns' reasoning
 *    back to the provider, removing an input that provokes loops.
 *
 * The stream logic itself lives in `./guard.js` (dependency-free, unit-tested
 * against real session fixtures); this file only wires it into Cordis. Firing
 * telemetry goes to the journal in `./journal.js`, which is exposed for
 * maintenance as the `reasoning_loop_log` tool built by `./log-tool.js`, to the
 * `/reasoning-loop-guard/log` route in `./log-route.js`, and — through that
 * route — to the Plugins-page card in `./client.js`. The GUI writes the three
 * arm switches through `./settings.js`.
 */
import { readFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { DEFAULTS } from "./detector.js";
import { FAILURE_CODE, guardStream, thresholdSnapshot } from "./guard.js";
import { buildRecord, createJournal, defaultConfigPath, defaultJournalPath } from "./journal.js";
import { createLogTool } from "./log-tool.js";
import { registerLogRoute } from "./log-route.js";
import { DEFAULT_RECOVERY_MESSAGE, RECOVERY_DEFAULTS, createRecoveryListener } from "./recovery.js";
import { EFFORT_VALUES, createSettingsStore, readSettingsFile } from "./settings.js";
import { createStripArm } from "./strip.js";

/** Cordis companion plugin name. */
const name = "reasoning-loop-guard";

/** Read our own version for journal records; never fatal. */
function readPluginVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return undefined;
  }
}

/** The three optional arms, shared by the patch config and the GUI settings. */
const recoverySchema = z.object({
  /** Take over `agent/request-error` and retry the step. */
  enabled: z.boolean().default(RECOVERY_DEFAULTS.enabled),
  /** Text of the corrective message appended before the retry. */
  message: z.string().default(DEFAULT_RECOVERY_MESSAGE),
  /** Retries per step before the failure is left terminal. */
  maxRetries: z.number().default(RECOVERY_DEFAULTS.maxRetries),
});

const effortSchema = z.object({
  /** Lower `reasoningEffort` on the request that follows a loop. */
  enabled: z.boolean().default(false),
  /** Target effort level. */
  value: z.string().default("low"),
});

const stripHistorySchema = z.object({
  /** Stop replaying finished turns' reasoning to the provider. */
  enabled: z.boolean().default(false),
});

/** Plugin configuration. */
const Config = z.object({
  /** Arm the guard. */
  enabled: z.boolean().default(true),
  /** Do not judge before this much reasoning text has streamed. */
  minChars: z.number().default(DEFAULTS.minChars),
  /** Evaluate the buffer once every N characters. */
  every: z.number().default(DEFAULTS.every),
  /** Rolling buffer (characters) used by the block and k-gram rules. */
  window: z.number().default(DEFAULTS.window),
  /** Tail length of the repeated k-gram. */
  kgram: z.number().default(DEFAULTS.kgram),
  /** Occurrences of the tail k-gram inside the window that count as a loop. */
  kgramThreshold: z.number().default(DEFAULTS.kgramThreshold),
  /** Rolling buffer (characters) used by the periodic-run rule. */
  periodTail: z.number().default(DEFAULTS.periodTail),
  /** Shortest repeated unit considered by the periodic-run rule. */
  minPeriod: z.number().default(DEFAULTS.minPeriod),
  /** Longest repeated unit considered by the periodic-run rule. */
  maxPeriod: z.number().default(DEFAULTS.maxPeriod),
  /** Consecutive identical units that count as a loop. */
  minUnits: z.number().default(DEFAULTS.minUnits),
  /** Shortest block considered by the block-repeat rule (normalized chars). */
  blockMin: z.number().default(DEFAULTS.blockMin),
  /** Occurrences of the same block that count as a loop. */
  blockCount: z.number().default(DEFAULTS.blockCount),
  /** Shortest line considered by the line-repeat rule (normalized chars). */
  lineMin: z.number().default(DEFAULTS.lineMin),
  /** Occurrences of the same line that count as a loop. */
  lineCount: z.number().default(DEFAULTS.lineCount),
  /** Fraction of the window the repeated line must occupy to count as a loop. */
  lineShare: z.number().default(DEFAULTS.lineShare),
  /** Consecutive decoration characters in the raw text that count as a loop. */
  fillerRun: z.number().default(DEFAULTS.fillerRun),
  /** Failure code reported to the agent loop (drives the retry policy). */
  failureCode: z.string().default(FAILURE_CODE),
  /** Append one bounded record per firing to the fire journal. */
  journal: z.boolean().default(true),
  /** Journal file path; empty means `$DSH_HOME/dsh-reasoning-loop-guard/fires.jsonl`. */
  journalPath: z.string().default(""),
  /** Rotate the journal to a single `.1` backup past this size. */
  journalMaxBytes: z.number().default(512 * 1024),
  /** Characters of the repeating unit kept in a record. */
  journalPreviewChars: z.number().default(120),
  /** Register the `reasoning_loop_log` maintenance tool. */
  logTool: z.boolean().default(true),
  /** GUI-editable settings file; empty means the default under the DSH home. */
  settingsPath: z.string().default(""),
  /** Recovery arm (default off). */
  recovery: recoverySchema,
  /** Effort downgrade arm (default off). */
  effort: effortSchema,
  /** Historical-reasoning strip arm (default off). */
  stripHistory: stripHistorySchema,
});

/**
 * Reject a configuration that would silently disarm or misjudge the guard.
 * @param config - resolved plugin configuration.
 * @throws {Error} on any out-of-range tunable.
 */
export function validateConfig(config) {
  const integer = (key, min) => {
    const value = config[key];
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`reasoning-loop-guard: ${key} must be an integer >= ${min}, got ${String(value)}`);
  };
  integer("minChars", 0);
  integer("every", 16);
  integer("window", 64);
  integer("kgram", 8);
  integer("kgramThreshold", 2);
  integer("periodTail", 64);
  integer("minPeriod", 2);
  integer("maxPeriod", 3);
  integer("minUnits", 2);
  integer("blockMin", 2);
  integer("blockCount", 2);
  integer("lineMin", 2);
  integer("lineCount", 2);
  if (!Number.isFinite(config.lineShare) || config.lineShare < 0 || config.lineShare > 1) {
    throw new Error(`reasoning-loop-guard: lineShare must be a number in [0, 1], got ${String(config.lineShare)}`);
  }
  integer("fillerRun", 2);
  integer("journalMaxBytes", 1024);
  integer("journalPreviewChars", 0);
  if (config.kgram > config.window) throw new Error("reasoning-loop-guard: kgram must not exceed window");
  if (config.minPeriod >= config.maxPeriod) throw new Error("reasoning-loop-guard: minPeriod must be smaller than maxPeriod");
  if (config.periodTail < 2 * config.maxPeriod) throw new Error("reasoning-loop-guard: periodTail must be at least twice maxPeriod");
  if (config.blockMin * config.blockCount > config.window) throw new Error("reasoning-loop-guard: blockMin * blockCount must not exceed window, or the block rule can never fire");
  if (typeof config.failureCode !== "string" || config.failureCode.length === 0) throw new Error("reasoning-loop-guard: failureCode must be a non-empty string");
  if (typeof config.journalPath !== "string") throw new Error("reasoning-loop-guard: journalPath must be a string");
  if (typeof config.settingsPath !== "string") throw new Error("reasoning-loop-guard: settingsPath must be a string");
  if (config.recovery !== undefined) {
    if (!Number.isSafeInteger(config.recovery.maxRetries) || config.recovery.maxRetries < 0) throw new Error("reasoning-loop-guard: recovery.maxRetries must be an integer >= 0");
    if (typeof config.recovery.message !== "string") throw new Error("reasoning-loop-guard: recovery.message must be a string");
  }
  if (config.effort !== undefined && !EFFORT_VALUES.includes(config.effort.value)) {
    throw new Error(`reasoning-loop-guard: effort.value must be one of ${EFFORT_VALUES.join(", ")}`);
  }
}

/**
 * Register the guard on the `llm/stream` waterfall, plus its optional surfaces.
 * @param ctx - Cordis context.
 * @param config - resolved plugin configuration.
 */
function apply(ctx, config) {
  validateConfig(config);
  if (!config.enabled) return;
  const warn = (message) => {
    if (ctx.logger?.warn !== undefined) ctx.logger.warn(message);
  };
  const log = (message) => {
    if (ctx.logger?.info !== undefined) ctx.logger.info(message);
    else warn(message);
  };

  // Settings live beside the journal and take precedence over the patch config,
  // key by key. Reading the file once here also means a broken settings file is
  // reported at load rather than at the first firing.
  const settingsPath = config.settingsPath !== "" ? config.settingsPath : defaultConfigPath();
  readSettingsFile(settingsPath, warn);
  const settings = createSettingsStore({ config, path: settingsPath, warn });
  /** The configuration in force right now — read per call, so saves apply live. */
  const effective = () => settings.get();

  const journal = createJournal({
    path: config.journalPath !== "" ? config.journalPath : defaultJournalPath(),
    enabled: config.journal,
    maxBytes: config.journalMaxBytes,
    previewChars: config.journalPreviewChars,
    warn,
  });
  const pluginVersion = readPluginVersion();

  // `agent/assistant-stream` is the only place the agent loop tells us *which*
  // attempt a delta belongs to (turn, step, attemptId), and the frame also
  // carries the session, whose header holds the working directory. The stream
  // middleware sees `GenerateOptions` but not the loop's bookkeeping, so the two
  // are correlated by session id: the frame with the highest revision wins,
  // which is the attempt currently streaming.
  //
  // The correlation is read lazily, at fire time, and that is load-bearing: the
  // agent loop calls `llm.stream(request)` *before* `live.start()` emits the
  // opening frame, so anything sampled while this listener runs would describe
  // the previous attempt of the same session.
  const attempts = new Map();
  ctx.on("agent/assistant-stream", (payload) => {
    try {
      const frame = payload?.frame;
      const session = payload?.agent?.session;
      if (frame === undefined || session?.id === undefined) return;
      if (frame.type !== "start") return;
      attempts.set(String(session.id), {
        attemptId: frame.attemptId,
        turn: frame.turn,
        step: frame.step,
        cwd: session.header?.cwd ?? null,
      });
    } catch {
      // Diagnostic context only; never let it interfere with the stream.
    }
  }, { global: true });

  /**
   * Best-effort context for one stream, resolved when the guard fires.
   *
   * Returned as a thunk rather than a value because the attempt it describes is
   * announced after this listener has already run — see the comment above.
   * @param options - the `GenerateOptions` of the stream.
   * @returns a supplier of `{ attempt, cwd }` for the journal record.
   */
  const probeFor = (options) => () => {
    const sessionId = options?.sessionId;
    if (sessionId === undefined) return { attempt: null, cwd: null };
    const key = String(sessionId);
    const live = attempts.get(key);
    if (live !== undefined) {
      return {
        attempt: { attemptId: live.attemptId, turn: live.turn, step: live.step },
        cwd: live.cwd,
      };
    }
    // No frame seen for this session yet (an aborted first attempt, or a host
    // that never emits one): fall back to the session service for the cwd.
    let cwd = null;
    try {
      cwd = ctx.get?.("sessions")?.get?.(key)?.header?.cwd ?? null;
    } catch {
      cwd = null;
    }
    return { attempt: null, cwd };
  };

  // The history-strip arm decides whether this request should be re-sent with
  // finished turns' reasoning removed. It is folded into the guard's listener
  // rather than registered as a second `llm/stream` listener on purpose:
  // re-entering the runtime would otherwise re-run every listener, and the guard
  // would journal one loop twice.
  const planStrip = createStripArm({
    read: effective,
    getRuntime: () => ctx.get?.("llm"),
    log,
    warn,
  });

  ctx.on("llm/stream", (options, next) => {
    // `config.enabled` above is the patch-level gate and is read exactly once,
    // at registration. The SAME name is also an editable setting, and that one
    // has to be honored per request — otherwise the GUI switch could only take
    // effect after a restart, which is the opposite of what the panel promises.
    // Only an explicit `false` stands the core down; an absent key means "as
    // shipped", which is armed.
    const current = effective();
    if (current.enabled === false) return next();
    const rewritten = planStrip(options);
    if (rewritten !== null) return ctx.get("llm").stream(rewritten);
    return guardStream(
      next(),
      options,
      current,
      warn,
      (verdict, firedOptions, firedConfig, facts) => {
        journal.record(buildRecord({
          verdict,
          options: firedOptions,
          config: firedConfig,
          pluginVersion,
          now: Date.now(),
          facts,
          thresholds: thresholdSnapshot(firedConfig),
        }));
      },
      probeFor(options),
    );
  }, { global: true });

  // The two recovery-side arms hang off `agent/request-error`, the extension
  // point the agent loop consults before it settles a failed attempt. Returning
  // `{ kind: "retry" }` re-runs the step; `dsh-llm-retry` sits on the same event
  // but passes our failures through, because our failure code is deliberately
  // not in its retryable set.
  //
  // Both are wired through `ctx.inject` on the services they need rather than
  // declared in `inject`, so a profile without them keeps the guard working.
  //
  // The service is `agents`, NOT `agent`: `@deepseek-ai/dsh-agent` registers its
  // `AgentRegistry` as `super(ctx, "agents")`, so a request for `agent` never
  // resolves and the callback below would never run — silently leaving BOTH
  // arms unregistered while the settings switches still read as "on". (`agent`
  // is only the typert *wire type* name registered inside that plugin.) The
  // agent-scoped events themselves need no scope tag here: an untagged listener
  // is admitted globally by `scopeTarget`, so a plain `ctx.inject` child is fine.
  if (typeof ctx.inject === "function") {
    ctx.inject(["agents"], (scope) => {
      try {
        scope.on("agent/request-error", createRecoveryListener({ read: effective, log, warn }));
      } catch (error) {
        warn(`reasoning-loop-guard: recovery arm skipped: ${String(error?.message ?? error)}`);
      }
      // Effort downgrade changes the call config the loop asks for. It must run
      // OUTSIDE the core's own `agent/request` listener (dsh-agent re-derives
      // provider/model/reasoningEffort there and would drop our value), which
      // means `{ prepend: true }` plus writing the result back after `next()`.
      try {
        scope.on("agent/request", async (payload, next) => {
          const resolved = await next();
          try {
            const live = effective();
            // The whole guard is off: an arm must not act on the back of a
            // failure the core would no longer have produced.
            if (live.enabled === false) return resolved;
            const arm = live.effort ?? {};
            if (arm.enabled !== true) return resolved;
            if (!EFFORT_VALUES.includes(arm.value)) return resolved;
            if (resolved?.reasoningEffort === arm.value) return resolved;
            return { ...resolved, reasoningEffort: arm.value };
          } catch (error) {
            warn(`reasoning-loop-guard: effort arm skipped: ${String(error?.message ?? error)}`);
            return resolved;
          }
        }, { prepend: true });
      } catch (error) {
        warn(`reasoning-loop-guard: effort arm skipped: ${String(error?.message ?? error)}`);
      }
    });
  }

  // Optional dependency: the guard is useful without a tool registry, so this
  // must never be a hard `export const inject = ["tools"]` (that would leave the
  // whole plugin INACTIVE wherever `tools` is absent).
  //
  // Each optional surface is registered inside its own try/catch, and they run
  // in independent `ctx.inject` calls: a throw here propagates out of `apply()`
  // and takes every later registration down with it. That is not hypothetical —
  // a rejected `output.schema` (see `./log-tool.js`) killed the tool AND the log
  // route registered twenty lines below it, while leaving the guard itself
  // looking installed.
  if (config.logTool) {
    ctx.inject(["tools"], (childCtx) => {
      try {
        childCtx.tools.register(createLogTool({ journal }));
      } catch (error) {
        warn(`reasoning-loop-guard: log tool skipped: ${String(error?.message ?? error)}`);
      }
    });
  }

  // Same reasoning for the log route: `webServer` exists only under the web
  // profile, and this cordis has no optional-inject form, so the route rides a
  // scoped ctx.inject — the closure runs when the service appears and never
  // runs where it does not. A headless or tui profile therefore keeps exactly
  // the plugin it had before the card existed, and the plugin itself never
  // waits on a server.
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (scope) => {
      try {
        registerLogRoute(scope, { journal, pluginVersion, settings });
      } catch (error) {
        warn(`reasoning-loop-guard: log route skipped: ${String(error?.message ?? error)}`);
      }
    });
  }
}

export { Config, apply, name };
