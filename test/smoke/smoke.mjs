/**
 * Integration smoke test: load the REAL Cordis host half (`lib/index.js`) and
 * drive it through a fake `ctx` that records the `llm/stream` registration and
 * the `reasoning_loop_log` tool registration, then run degenerate and healthy
 * streams through the registered middleware. This is what proves the plugin
 * works via the path DSH uses, not just via the dependency-free unit tests.
 *
 * Run: node --import ./test/smoke/register-hook.mjs test/smoke/smoke.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig, Config, apply, name } from "../../lib/index.js";

let failures = 0;
const check = (ok, label) => {
  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
};

console.log(`plugin name: ${name}`);
check(name === "reasoning-loop-guard", "plugin exports its Cordis name");
check(typeof Config === "function" || typeof Config === "object", "Config is a schemastery schema");

console.log("\n--- validateConfig rejects misconfiguration ---");
const base = { ...Config({}) };
const rejects = (patch, label) => {
  let threw = false;
  try {
    validateConfig({ ...base, ...patch });
  } catch {
    threw = true;
  }
  check(threw, label);
};
console.log(`defaults: ${JSON.stringify(base)}`);
rejects({ kgram: 99999 }, "kgram > window is rejected");
rejects({ minPeriod: 400, maxPeriod: 400 }, "minPeriod >= maxPeriod is rejected");
rejects({ periodTail: 10 }, "periodTail < 2*maxPeriod is rejected");
rejects({ failureCode: "" }, "empty failureCode is rejected");
rejects({ every: 0 }, "every below its floor is rejected");
rejects({ journalMaxBytes: 10 }, "journalMaxBytes below its floor is rejected");
let okConfig = true;
try {
  validateConfig(base);
} catch (error) {
  okConfig = false;
  console.log(`      ${error.message}`);
}
check(okConfig, "the default configuration validates");

console.log("\n--- apply() registers on llm/stream and the maintenance tool ---");
const registered = [];
const warned = [];
const toolDefs = [];
// The journal must never touch the real DSH home from a test.
const scratch = mkdtempSync(join(tmpdir(), "rlg-smoke-"));
const live = { ...base, journalPath: join(scratch, "fires.jsonl"), settingsPath: join(scratch, "config.json") };
const ctx = {
  logger: { warn: (message) => warned.push(message) },
  on: (event, handler, options) => registered.push({ event, handler, options }),
  inject: (deps, callback) => {
    // Stand in for Cordis optional injection: hand the callback a child ctx
    // carrying only the services this plugin asks for.
    const child = { tools: { register: (definition) => toolDefs.push(definition) } };
    for (const dep of deps) if (child[dep] === undefined) return;
    callback(child);
  },
};
apply(ctx, live);
// Two listeners: the stream middleware, and the correlator that learns which
// attempt a delta belongs to. Their order is not contractual, so pick by event.
const streamListener = registered.find((entry) => entry.event === "llm/stream");
const frames = registered.filter((entry) => entry.event === "agent/assistant-stream");
check(registered.length === 2, `exactly two listeners registered (got ${registered.length})`);
check(frames.length === 1, `the attempt correlator is wired (got ${frames.length})`);
check(frames[0]?.options?.global === true, "the correlator is registered globally");
check(streamListener !== undefined, "listener is on llm/stream");
check(streamListener?.options?.global === true, "listener is registered globally");
check(toolDefs.length === 1, `exactly one tool registered (got ${toolDefs.length})`);
check(toolDefs[0]?.name === "reasoning_loop_log", "tool is reasoning_loop_log");
check(typeof toolDefs[0]?.output?.render === "function", "tool declares output.render");
check(typeof toolDefs[0]?.execute === "function", "tool declares execute");

// A fake registry accepts any object, which is exactly how a schema DSH
// rejects slips through: the real `ctx.tools.register` ends in
// `assertSupportedJsonSchema(output.schema)` and THROWS, and the plugin then
// dies at load (`JsonSchemaError: schema.properties.action.required is not
// supported on type "string"`). Validate against DSH's own validator instead
// of a replica so this class of bug cannot come back silently.
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import("@deepseek-ai/dsh-tools");
let schemaError = null;
try {
  assertSupportedJsonSchema(toolDefs[0]?.parameters);
  assertSupportedJsonSchema(toolDefs[0]?.output?.schema);
} catch (error) {
  schemaError = error;
}
check(schemaError === null, `both tool schemas pass DSH's real validator (${schemaError?.message ?? "ok"})`);

console.log("\n--- middleware guards a real stream ---");
const DIR = fileURLToPath(new URL("../fixtures", import.meta.url));
const positives = JSON.parse(readFileSync(join(DIR, "degenerate.json"), "utf8"));
const negatives = JSON.parse(readFileSync(join(DIR, "healthy.json"), "utf8"));
const { handler } = streamListener;
async function* fromText(text, size) {
  for (let at = 0; at < text.length; at += size) yield { type: "reasoning-delta", index: 0, text: text.slice(at, at + size) };
}
const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

const degenerate = positives[0];
const guarded = await collect(handler({ sessionId: "smoke" }, () => fromText(degenerate.text, 40)));
const finish = guarded.at(-1);
check(finish?.type === "finish", "degenerate stream ends with a finish chunk");
check(finish?.reason?.kind === "error", "degenerate stream reports an error finish");
check(finish?.reason?.failure?.code === "REASONING_LOOP", "failure code is REASONING_LOOP");
check(warned.length === 1, `the firing was logged once (got ${warned.length})`);
console.log(`      log: ${warned[0]}`);

const healthy = negatives.find((item) => item.text.length > 20000) ?? negatives[0];
const passed = await collect(handler({ sessionId: "smoke" }, () => fromText(healthy.text, 40)));
check(passed.every((chunk) => chunk.type === "reasoning-delta"), "healthy stream passes through untouched");

console.log("\n--- every fixture through the real middleware ---");
let hit = 0;
for (const item of positives) {
  const chunks = await collect(handler({ sessionId: "smoke" }, () => fromText(item.text, 200)));
  if (chunks.at(-1)?.reason?.failure?.code === "REASONING_LOOP") hit += 1;
}
let falsePositives = 0;
for (const item of negatives) {
  const chunks = await collect(handler({ sessionId: "smoke" }, () => fromText(item.text, 200)));
  if (chunks.at(-1)?.type === "finish") falsePositives += 1;
}
check(hit === positives.length, `positives caught through middleware: ${hit}/${positives.length}`);
check(falsePositives === 0, `false positives through middleware: ${falsePositives}/${negatives.length}`);

console.log("\n--- reasoning_loop_log reads what the guard journaled ---");
const tool = toolDefs[0];
// Every value the tool returns must satisfy its own published output schema;
// DSH validates exactly this way before the result reaches the model.
const conforms = (value, label) => {
  try {
    validateJsonSchemaValue(tool.output.schema, value);
    return null;
  } catch (error) {
    return `${label}: ${error.message}`;
  }
};
const listed = await tool.execute({ action: "list", limit: 5 }, {});
check(conforms(listed, "list") === null, `list result matches the output schema (${conforms(listed, "list") ?? "ok"})`);
check(listed.path === live.journalPath, "tool reports the configured journal path");
check(listed.entries.length === 5, `list honours limit (got ${listed.entries.length})`);
check(listed.total >= positives.length, `list sees every fire (${listed.total} on file)`);
check(listed.matched === listed.total, "unfiltered list matches every record");
const rendered = tool.output.render({}, listed);
check(
  Array.isArray(rendered) && rendered[0]?.type === "text" && typeof rendered[0].text === "string",
  "render returns a text content block",
);
// Any of the four rules may be the one that fired, so assert on the set rather
// than on the two rules that happened to exist first.
check(
  ["periodic-run", "block-repeat", "line-repeat", "kgram-repeat"].some((rule) => rendered[0].text.includes(rule)),
  `rendered text names the rule (${rendered[0].text.split("\n")[0]})`,
);
const renderedDetail = rendered[0].text;
check(renderedDetail.includes("at="), "rendered text carries the character offset");
const filtered = await tool.execute({ action: "list", rule: "periodic-run", limit: 100 }, {});
check(filtered.entries.every((entry) => entry.rule === "periodic-run"), "list filters by rule");
const stats = await tool.execute({ action: "stats" }, {});
check(stats.stats.count >= positives.length, `stats counts every fire (got ${stats.stats.count})`);
check(typeof stats.stats.byModel === "object" && stats.stats.byModel !== null, "stats aggregates by model");
const pathOnly = await tool.execute({ action: "path" }, {});
check(pathOnly.action === "path" && pathOnly.path === live.journalPath, "path action reports the file location");
check(conforms(pathOnly, "path") === null, `path result matches the output schema (${conforms(pathOnly, "path") ?? "ok"})`);
check(conforms(stats, "stats") === null, `stats result matches the output schema (${conforms(stats, "stats") ?? "ok"})`);
const cleared = await tool.execute({ action: "clear" }, {});
check(cleared.removed === true, "clear removes the journal");
check(conforms(cleared, "clear") === null, `clear result matches the output schema (${conforms(cleared, "clear") ?? "ok"})`);
check((await tool.execute({ action: "stats" }, {})).stats.count === 0, "the journal is empty after clear");

console.log("\n--- disabled config is inert ---");
const off = [];
apply({ logger: { warn: () => {} }, on: (...args) => off.push(args) }, { ...base, enabled: false });
check(off.length === 0, "enabled:false registers nothing");

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "ALL SMOKE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
