/**
 * dsh-reasoning-loop-guard — the maintenance log tool.
 *
 * Exposes the fire journal (see `./journal.js`) as a DSH tool, so the guard can
 * be maintained without hand-reading session logs: how often it fired, on which
 * model, and what the repeating text looked like.
 *
 * Registered through `ctx.tools.register()` with a hand-written definition.
 * `register()` validates only `output.render` and `output.schema`, so the plugin
 * needs no dependency on `@deepseek-ai/dsh-tools` — which matters, because a
 * plugin installed under a profile cannot resolve `@deepseek-ai/*` from its own
 * directory anyway. Two in-box plugins do the same
 * (`dsh-subagent-in-process-driver`, `dsh-tool-skill`).
 *
 * The schema below must stay inside the subset `assertSupportedJsonSchema`
 * accepts: `type` is a single string from
 * object/array/string/number/integer/boolean/null (no type arrays, no `json`),
 * `properties`/`required`/`additionalProperties` only on `object`, `items` only
 * on `array`, and every `object` node states `additionalProperties` explicitly.
 *
 * @module dsh-reasoning-loop-guard/log-tool
 */

import { REPEAT_RULES } from "./detector.js";

/** Tool name the model sees. */
export const LOG_TOOL_NAME = "reasoning_loop_log";

/** Actions the tool accepts, in the order they are documented. */
export const LOG_ACTIONS = ["list", "stats", "clear", "path"];

/** How long an entry is, whichever rule caught it. */
function measureOf(entry) {
  switch (entry?.rule) {
    case "periodic-run":
      return `period=${String(entry.period)} units=${String(entry.units)}`;
    case "block-repeat":
      return `block=${String(entry.blockLen)} reuses=${String(entry.count)}`;
    case "line-repeat": {
      const share = Number.isFinite(entry.share) ? ` share=${(entry.share * 100).toFixed(1)}%` : "";
      return `line=${String(entry.lineLen)} reuses=${String(entry.count)}${share}`;
    }
    default:
      return `count=${String(entry?.count)}`;
  }
}

/**
 * One journal record as a single line.
 * @param entry - a parsed journal record.
 * @returns the formatted line.
 */
function formatRecord(entry) {
  const when = typeof entry.iso === "string" ? entry.iso.replace("T", " ").slice(0, 19) : "?";
  const where = [entry.provider, entry.model]
    .filter((part) => typeof part === "string" && part !== "")
    .join(" / ") || "?";
  const at = entry.turn === undefined ? "" : `  turn=${String(entry.turn)} step=${String(entry.step)}`;
  const preview = typeof entry.preview === "string" && entry.preview !== "" ? `\n    “${entry.preview}”` : "";
  return `${when}  ${String(entry.rule)}  ${measureOf(entry)}  at=${String(entry.atChars)}  ${where}${at}${preview}`;
}

/**
 * Render a `reasoning_loop_log` result as text.
 * Pure, so the maintenance surface is testable without a host.
 * @param value - the tool result value (matches the output schema).
 * @returns the text shown to the model.
 */
export function formatLog(value) {
  const header = `journal: ${value.path}`;
  if (value.action === "path") return header;
  if (value.action === "clear") return `${header}\n${value.removed === true ? "journal cleared" : "nothing to clear"}`;
  if (value.action === "stats") {
    const stats = value.stats ?? {};
    const table = (counts) => Object.entries(counts ?? {})
      .map(([key, count]) => `${key} × ${count}`)
      .join(", ") || "—";
    const stamp = (at) => (Number.isFinite(at) ? new Date(at).toISOString() : "—");
    return [
      header,
      `fires: ${String(stats.count ?? 0)}`,
      `by rule:  ${table(stats.byRule)}`,
      `by model: ${table(stats.byModel)}`,
      `by day:   ${table(stats.byDay)}`,
      `span: ${stamp(stats.earliest)} .. ${stamp(stats.latest)}`,
    ].join("\n");
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    return `${header}\nno fires recorded (${String(value.matched)} matched of ${String(value.total)} on file)`;
  }
  return [
    header,
    `${String(value.matched)} matched of ${String(value.total)} on file, newest first:`,
    ...value.entries.map(formatRecord),
  ].join("\n");
}

/**
 * Build the `reasoning_loop_log` tool definition.
 * @param options - the journal handle to expose.
 * @returns a definition ready for `ctx.tools.register()`.
 */
export function createLogTool({ journal }) {
  return {
    name: LOG_TOOL_NAME,
    description:
      "Read the reasoning-loop-guard fire journal. The guard appends one bounded record every time it "
      + "aborts a stream for repeating reasoning; this tool reports how often that happened, on which "
      + "provider and model, and the repeating text it caught. "
      + "action=\"list\" returns the newest fires, \"stats\" returns counters, "
      + "\"path\" returns the journal file location, \"clear\" deletes the journal and its backup.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: LOG_ACTIONS,
          description: "What to do with the journal: list fires, aggregate stats, report the file path, or clear it.",
        },
        limit: { type: "number", description: "list: maximum entries to return, newest first (default 20)." },
        rule: {
          type: "string",
          enum: [...REPEAT_RULES],
          description: "list: only fires from this detector rule.",
        },
        sessionId: { type: "string", description: "list: only fires recorded for this DSH session id." },
        since: { type: "number", description: "list: only fires at or after this epoch-millisecond timestamp." },
      },
      required: ["action"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        // `required` is a keyword OF the object node, not of each property:
        // `json-schema.js` reports `properties.x.required is not supported on
        // type "string"` and `ctx.tools.register` then throws.
        required: ["action", "path", "total", "matched", "entries"],
        properties: {
          action: { type: "string" },
          path: { type: "string" },
          total: { type: "integer" },
          matched: { type: "integer" },
          entries: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          stats: { type: "object", additionalProperties: true },
          removed: { type: "boolean" },
        },
      },
      render: (_args, value) => [{ type: "text", text: formatLog(value) }],
    },
    async execute(args) {
      const action = typeof args?.action === "string" ? args.action : "list";
      const base = { action, path: journal.path, total: 0, matched: 0, entries: [] };
      if (action === "path") return base;
      if (action === "clear") return { ...base, removed: journal.clear() };
      if (action === "stats") {
        const stats = journal.stats();
        return { ...base, total: stats.count, matched: stats.count, stats };
      }
      const result = journal.read({
        limit: args?.limit,
        rule: args?.rule,
        sessionId: args?.sessionId,
        since: args?.since,
      });
      return { action: "list", path: journal.path, total: result.total, matched: result.matched, entries: result.entries };
    },
  };
}
