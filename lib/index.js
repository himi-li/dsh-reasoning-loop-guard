/**
 * dsh-reasoning-loop-guard — host half (Cordis plugin).
 *
 * Middleware over the `llm/stream` waterfall: it watches streamed reasoning
 * deltas and, when the model starts repeating itself instead of finishing,
 * stops pulling the upstream stream and terminates it with a terminal `finish`
 * chunk carrying an error. DSH then behaves exactly as it does for any provider
 * failure: the step ends with a visible error instead of hanging for minutes.
 *
 * The stream logic itself lives in `./guard.js` (dependency-free, unit-tested
 * against real session fixtures); this file only wires it into Cordis. Firing
 * telemetry goes to the journal in `./journal.js`, which is exposed for
 * maintenance as the `reasoning_loop_log` tool built by `./log-tool.js`, to the
 * `/reasoning-loop-guard/log` route in `./log-route.js`, and — through that
 * route — to the Plugins-page card in `./client.js`.
 */
import { readFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { DEFAULTS } from "./detector.js";
import { guardStream } from "./guard.js";
import { buildRecord, createJournal, defaultJournalPath } from "./journal.js";
import { createLogTool } from "./log-tool.js";
import { registerLogRoute } from "./log-route.js";

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

/** Plugin configuration. */
const Config = z.object({
  /** Arm the guard. */
  enabled: z.boolean().default(true),
  /** Do not judge before this much reasoning text has streamed. */
  minChars: z.number().default(DEFAULTS.minChars),
  /** Evaluate the buffer once every N characters. */
  every: z.number().default(DEFAULTS.every),
  /** Rolling buffer (characters) used by the k-gram rule. */
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
  /** Failure code reported to the agent loop (drives the retry policy). */
  failureCode: z.string().default("REASONING_LOOP"),
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
  integer("journalMaxBytes", 1024);
  integer("journalPreviewChars", 0);
  if (config.kgram > config.window) throw new Error("reasoning-loop-guard: kgram must not exceed window");
  if (config.minPeriod >= config.maxPeriod) throw new Error("reasoning-loop-guard: minPeriod must be smaller than maxPeriod");
  if (config.periodTail < 2 * config.maxPeriod) throw new Error("reasoning-loop-guard: periodTail must be at least twice maxPeriod");
  if (typeof config.failureCode !== "string" || config.failureCode.length === 0) throw new Error("reasoning-loop-guard: failureCode must be a non-empty string");
  if (typeof config.journalPath !== "string") throw new Error("reasoning-loop-guard: journalPath must be a string");
}

/**
 * Register the guard on the `llm/stream` waterfall, plus the maintenance tool.
 * @param ctx - Cordis context.
 * @param config - resolved plugin configuration.
 */
function apply(ctx, config) {
  validateConfig(config);
  if (!config.enabled) return;
  const warn = (message) => {
    if (ctx.logger?.warn !== undefined) ctx.logger.warn(message);
  };

  const journal = createJournal({
    path: config.journalPath !== "" ? config.journalPath : defaultJournalPath(),
    enabled: config.journal,
    maxBytes: config.journalMaxBytes,
    previewChars: config.journalPreviewChars,
    warn,
  });
  const pluginVersion = readPluginVersion();

  ctx.on("llm/stream", (options, next) => guardStream(
    next(),
    options,
    config,
    warn,
    (verdict) => {
      journal.record(buildRecord({ verdict, options, config, pluginVersion, now: Date.now() }));
    },
  ), { global: true });

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
        registerLogRoute(scope, { journal, pluginVersion });
      } catch (error) {
        warn(`reasoning-loop-guard: log route skipped: ${String(error?.message ?? error)}`);
      }
    });
  }
}

export { Config, apply, name };
