/**
 * End-to-end check against the REAL shipped DSH code (not a replica):
 *
 *  1. `validateStream` from `@deepseek-ai/dsh-llm/invariant` — the same
 *     grammar gate DSH installs on every provider stream. A guard that emits
 *     an illegal chunk shape would fail here and break every request.
 *  2. `AssistantStreamAccumulator` — what DSH actually does with the chunks:
 *     builds the assistant message. This proves the interrupted message is
 *     well-formed rather than merely tolerated.
 *
 * Run: node --import ./test/smoke/register-hook.mjs test/smoke/real-protocol.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AssistantStreamAccumulator, assembleAssistantStream, isAgentLoopRequest, markAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { apply, Config } from "../../lib/index.js";

// `validateStream` is module-private; re-create the install hook it uses.
// We import the module and reach the validator through the exported `apply`
// path instead: register a fake invariant service and capture `install`.
const captured = {};
const invariantCtx = {
  invariants: { register: (_pkg, install) => { captured.install = install; return () => {}; } },
  on: () => {},
  get: () => undefined,
};
const { apply: applyInvariant } = await import("file:///C:/Program%20Files/DSH%20Desktop/resources/app/node_modules/@deepseek-ai/dsh-llm/lib/invariant.js");
await applyInvariant(invariantCtx);
if (typeof captured.install !== "function") throw new Error("failed to capture the invariant installer");

// Drive the captured installer with a ctx that records the llm/stream hook.
let validateHook = null;
const failMessages = [];
captured.install(
  {
    on: (event, handler) => { if (event === "llm/stream") validateHook = handler; },
    get: () => undefined,
  },
  (message) => failMessages.push(message),
);
if (validateHook === null) throw new Error("llm-invariant did not register an llm/stream hook");

let failures = 0;
const check = (ok, label) => {
  if (!ok) { failures += 1; console.log(`FAIL  ${label}`); } else { console.log(`ok    ${label}`); }
};

const DIR = fileURLToPath(new URL("../fixtures", import.meta.url));
const positives = JSON.parse(readFileSync(`${DIR}/degenerate.json`, "utf8"));
const negatives = JSON.parse(readFileSync(`${DIR}/healthy.json`, "utf8"));

// Build the guard exactly as DSH would. `journal` is switched off so this test
// never writes outside its own temp dir.
const registered = [];
apply(
  {
    logger: { warn: () => {} },
    on: (event, handler, options) => registered.push({ event, handler, options }),
    inject: () => {},
  },
  { ...Config({}), journal: false },
);
const guard = registered[0].handler;

async function* fromText(text, size) {
  // A well-formed provider stream: open a reasoning block, stream deltas.
  yield { type: "block-start", index: 0, blockType: "reasoning" };
  for (let at = 0; at < text.length; at += size) {
    yield { type: "reasoning-delta", index: 0, text: text.slice(at, at + size) };
  }
  yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}

console.log("--- real llm-invariant accepts the guarded stream ---");
const degenerate = positives[0];
const guarded = guard({ sessionId: "s-real" }, () => fromText(degenerate.text, 40));
const validated = [];
for await (const chunk of validateHook({ sessionId: "s-real" }, () => guarded)) validated.push(chunk);
check(failMessages.length === 0, `llm-invariant reported no violation (got ${failMessages.length}: ${failMessages.join(" | ")})`);
check(validated.at(-1)?.type === "finish", "guarded stream reaches a terminal finish through the validator");
check(validated.at(-1)?.reason?.kind === "error", "terminal finish is an error finish");
check(validated.at(-1)?.reason?.failure?.code === "REASONING_LOOP", "failure code survives validation");

console.log("\n--- real llm-invariant accepts healthy streams untouched ---");
let healthyFailures = 0;
for (const item of negatives.slice(0, 25)) {
  const stream = validateHook({ sessionId: "s-real" }, () => guard({ sessionId: "s-real" }, () => fromText(item.text, 400)));
  for await (const _chunk of stream) { /* drain */ }
  if (failMessages.length > 0) healthyFailures += 1;
}
check(healthyFailures === 0 && failMessages.length === 0, `25 healthy streams validated clean (${failMessages.length} violations)`);

console.log("\n--- real accumulator/assembler handle the guarded stream ---");
const accumulator = new AssistantStreamAccumulator();
let clock = 0;
for (const chunk of validated) accumulator.push({ time: clock += 1, chunk });
const assembler = assembleAssistantStream(accumulator.snapshot());
const interrupted = assembler.interruptedBlocks();
const blocks = assembler.blocks();
const types = interrupted.map((block) => block.type);
console.log(`      interruptedBlocks: ${JSON.stringify(types)}`);
console.log(`      completedBlocks: ${JSON.stringify(blocks.map((b) => b.type))}`);
console.log(`      finish: ${JSON.stringify(assembler.finish)}`);
check(types.every((t) => t === "reasoning" || t === "text"), "only reasoning/text blocks survive interruption");
check(!types.includes("tool-call"), "no fabricated tool-call block");
check(interrupted.length > 0, "the interrupted attempt still yields visible content");
const reasoning = interrupted.find((block) => block.type === "reasoning");
check(typeof reasoning?.text === "string" && reasoning.text.length > 0, "the partial reasoning text is preserved");
console.log(`      preserved reasoning chars: ${reasoning.text.length} of ${degenerate.text.length}`);
check(assembler.finish.kind === "error", "the assembler reports an error finish");

console.log("\n--- the request marker distinguishes agent-loop calls ---");
const marked = markAgentLoopRequest(Object.freeze({ provider: "p", model: "m", messages: [], sessionId: "s-real" }));
check(isAgentLoopRequest(marked) === true, "a marked request is recognized as an agent-loop request");
check(isAgentLoopRequest(Object.freeze({ provider: "p", model: "m", messages: [] })) === false, "an unmarked request (compaction/session-title) is not");

console.log(`\n${failures === 0 ? "ALL REAL-PROTOCOL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
