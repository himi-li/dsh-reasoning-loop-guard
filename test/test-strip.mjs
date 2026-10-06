/**
 * Unit checks for `lib/strip.js` — the opt-in historical-reasoning strip.
 *
 * The arm is a pure decision function: given one `llm/stream` options object it
 * either returns a rewritten options object (which the caller re-enters the
 * runtime with) or `null` (do nothing). That shape is what keeps it from being
 * a second listener on the same waterfall, which would make the guard journal
 * one loop twice — so the contract is checked here rather than assumed.
 *
 * The boundary rule is the load-bearing part. DSH delivers tool results as
 * `user`-role messages, so "strip everything before the last user message"
 * lands in the middle of a tool loop and removes the *active* turn's reasoning,
 * which DeepSeek rejects outright:
 *
 *   The reasoning_content in the thinking mode must be passed back to the API.
 *
 * Every check in section 3 exists because of that failure mode.
 *
 * Run: node test/test-strip.mjs
 */
import {
  STRIPPED,
  createStripArm,
  isGenuineUserTurn,
  lastUserTurnIndex,
  shouldStrip,
  stripHistoricalReasoning,
} from "../lib/strip.js";

let failures = 0;
const check = (ok, label) => {
  if (!ok) { failures += 1; console.log(`FAIL  ${label}`); } else { console.log(`ok    ${label}`); }
};

/** An assistant message carrying reasoning plus the answer it produced. */
const assistant = (id, reasoning, text = "answer") => ({
  id,
  role: "assistant",
  content: [
    { type: "reasoning", text: reasoning },
    { type: "text", text },
  ],
});

/** A plain user turn. */
const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }] });

/** A tool result, which DSH delivers as a `user`-role message. */
const toolResult = (id) => ({
  id,
  role: "user",
  content: [{ type: "tool-result", toolCallId: "call-1", content: [] }],
});

console.log("--- 1. the arm ships inert ---");
check(typeof STRIPPED === "symbol", "the re-entry marker is a symbol");
check(STRIPPED === Symbol.for("dsh-reasoning-loop-guard.stripped"), "the marker has a stable registry key");

console.log("\n--- 2. which requests are eligible ---");
check(shouldStrip({ provider: "deepseek", model: "deepseek-chat" }) === true, "deepseek is eligible");
check(shouldStrip({ provider: "DeepSeek", model: "x" }) === true, "the provider match is case-insensitive");
check(shouldStrip({ provider: "workbuddy", model: "deepseek-v4.1-flash" }) === true, "a reseller is caught by the model id");
check(shouldStrip({ provider: "openai", model: "gpt-4o" }) === false, "an unrelated provider is left alone");
check(shouldStrip({ provider: "moonshot", model: "kimi-k2" }) === false, "another vendor is left alone");
check(shouldStrip({ provider: "zhipu", model: "glm-4.6" }) === false, "a third vendor is left alone");
check(shouldStrip({}) === false, "a request naming no provider is left alone");
check(shouldStrip(undefined) === false, "a missing options object is left alone");

console.log("\n--- 3. the turn boundary ---");
check(isGenuineUserTurn(user("u1", "hello")) === true, "a plain user message opens a turn");
check(isGenuineUserTurn(toolResult("t1")) === false, "a tool result does not open a turn");
check(isGenuineUserTurn(assistant("a1", "thinking")) === false, "an assistant message does not open a turn");
check(isGenuineUserTurn(null) === false, "null is not a turn");
check(isGenuineUserTurn({ role: "user" }) === true, "a user message with no content still opens a turn");
check(isGenuineUserTurn({ role: "user", content: [] }) === true, "an empty user message opens a turn");
check(
  isGenuineUserTurn({ role: "user", content: [{ type: "text", text: "hi" }, { type: "tool-result" }] }) === true,
  "a user message with any non-tool block opens a turn",
);
check(lastUserTurnIndex([user("u1", "a"), assistant("a1", "t"), user("u2", "b")]) === 2, "the last user turn is found");
check(lastUserTurnIndex([user("u1", "a"), assistant("a1", "t"), toolResult("t1")]) === 0, "a trailing tool result is not a turn");
check(lastUserTurnIndex([assistant("a1", "t")]) === -1, "a list with no user turn has no boundary");
check(lastUserTurnIndex([]) === -1, "an empty list has no boundary");
check(lastUserTurnIndex(undefined) === -1, "a missing list has no boundary");

console.log("\n--- 4. stripping keeps the active turn ---");
{
  const messages = [
    user("u1", "first question"),
    assistant("a1", "OLD-REASONING-1"),
    user("u2", "second question"),
    assistant("a2", "ACTIVE-REASONING"),
  ];
  const stripped = stripHistoricalReasoning(messages);
  check(stripped !== messages, "a changed list returns a new array");
  check(stripped[1].content.every((block) => block.type !== "reasoning"), "history loses its reasoning block");
  check(stripped[1].content.some((block) => block.type === "text"), "history keeps its answer text");
  check(stripped[3].content.some((block) => block.type === "reasoning"), "the active turn keeps its reasoning");
  check(messages[1].content.some((block) => block.type === "reasoning"), "the input array is not mutated");
  check(messages[1].content.length === 2, "the input message is not mutated");
  check(stripped[0] === messages[0], "untouched messages are reused by reference");
}
{
  // The tool-loop case: no new user question, so the whole list is active.
  const messages = [user("u1", "do the thing"), assistant("a1", "REASONING-A"), toolResult("t1"), assistant("a2", "REASONING-B")];
  const stripped = stripHistoricalReasoning(messages);
  check(stripped === messages, "with no new user turn nothing is stripped");
  check(stripped[1].content.some((block) => block.type === "reasoning"), "the active reasoning survives a tool loop");
  check(stripped[3].content.some((block) => block.type === "reasoning"), "later reasoning in the same turn survives");
}
{
  // A retry of the same step appends nothing, so the boundary is unchanged and
  // the previously aborted reasoning — now history — is what gets dropped.
  const messages = [user("u1", "q"), assistant("a1", "ABORTED-REASONING"), user("u2", "nudge"), assistant("a2", "NEW")];
  const stripped = stripHistoricalReasoning(messages);
  check(stripped[1].content.every((block) => block.type !== "reasoning"), "an aborted attempt becomes history once a user message follows");
}
{
  const messages = [user("u1", "q"), { id: "x", role: "assistant", content: [{ type: "text", text: "no thinking here" }] }];
  check(stripHistoricalReasoning(messages) === messages, "a list with no reasoning at all is returned unchanged");
}
{
  // Two historical assistants: both sit before the newest user turn, so both
  // lose their reasoning. Without that later user turn they would be part of
  // the active turn and must be preserved instead (checked just below).
  const messages = [user("u1", "q"), assistant("a1", "THINK"), assistant("a2", "THINK TOO"), user("u2", "q2"), assistant("a3", "ACTIVE")];
  const stripped = stripHistoricalReasoning(messages);
  check(stripped[1].content.every((block) => block.type !== "reasoning"), "the first historical assistant loses its reasoning");
  check(stripped[2].content.every((block) => block.type !== "reasoning"), "the second historical assistant loses its reasoning too");
  check(stripped[4].content.some((block) => block.type === "reasoning"), "the assistant after the newest user turn keeps its reasoning");
}
{
  // The same two assistants with nothing after them: the newest user turn is
  // still index 0, so they belong to the active turn and must survive intact.
  const messages = [user("u1", "q"), assistant("a1", "THINK"), assistant("a2", "THINK TOO")];
  const stripped = stripHistoricalReasoning(messages);
  check(stripped === messages, "assistants with no newer user turn are all active");
  check(stripped[1].content.some((block) => block.type === "reasoning"), "the first active assistant keeps its reasoning");
  check(stripped[2].content.some((block) => block.type === "reasoning"), "the second active assistant keeps its reasoning too");
}
{
  check(stripHistoricalReasoning([]) === undefined || Array.isArray(stripHistoricalReasoning([])) === false || stripHistoricalReasoning([]).length === 0, "an empty list comes back empty");
  const weird = [null, user("u1", "q")];
  const stripped = stripHistoricalReasoning(weird);
  check(stripped[0] === null, "a null entry is tolerated");
}
{
  // The DeepSeek 400 case: reasoning after the boundary must never be removed,
  // even when it is the only block in the message.
  const messages = [user("u1", "q"), { id: "a1", role: "assistant", content: [{ type: "reasoning", text: "ONLY-REASONING" }] }];
  const stripped = stripHistoricalReasoning(messages);
  check(stripped === messages, "active-turn reasoning is preserved even when it is the whole message");
}

console.log("\n--- 5. the arm is a decision function, not a listener ---");
{
  const calls = [];
  const arm = createStripArm({
    read: () => ({ stripHistory: { enabled: false } }),
    getRuntime: () => ({ stream: () => { calls.push("stream"); } }),
  });
  const options = { provider: "deepseek", model: "deepseek-chat", messages: [user("u1", "q"), assistant("a1", "T"), user("u2", "q2"), assistant("a2", "T2")] };
  check(arm(options) === null, "a disabled arm plans nothing");
  check(calls.length === 0, "nothing is dispatched while disabled");
}
{
  const arm = createStripArm({
    read: () => ({ stripHistory: { enabled: true } }),
    getRuntime: () => ({ stream: () => {} }),
  });
  const messages = [user("u1", "q"), assistant("a1", "OLD"), user("u2", "q2"), assistant("a2", "ACTIVE")];
  const planned = arm({ provider: "deepseek", model: "deepseek-chat", messages, sessionId: "s1" });
  check(planned !== null, "an eligible request is planned");
  check(planned[STRIPPED] === true, "the plan carries the re-entry marker");
  check(planned.messages !== messages, "the plan carries rewritten messages");
  check(planned.messages[1].content.every((b) => b.type !== "reasoning"), "the history is stripped in the plan");
  check(planned.sessionId === "s1", "every other option is carried over");
  // Re-entrancy: the marker must short-circuit the second pass, or the guard
  // and this arm would fight over the same request.
  check(arm(planned) === null, "an already-stripped request is not stripped again");
}
{
  const arm = createStripArm({ read: () => ({ stripHistory: { enabled: true } }), getRuntime: () => ({ stream: () => {} }) });
  const messages = [user("u1", "q"), assistant("a1", "OLD"), user("u2", "q2"), assistant("a2", "ACTIVE")];
  check(arm({ provider: "openai", model: "gpt-4o", messages }) === null, "another vendor is planned for nothing");
}
{
  // Nothing to strip means no re-entry at all: a needless round trip would
  // drop the agent-loop marker for no benefit.
  const arm = createStripArm({ read: () => ({ stripHistory: { enabled: true } }), getRuntime: () => ({ stream: () => {} }) });
  const messages = [user("u1", "q"), assistant("a1", "OLD")];
  check(arm({ provider: "deepseek", model: "deepseek-chat", messages }) === null, "a request with nothing to strip is left alone");
}
{
  const warns = [];
  const arm = createStripArm({
    read: () => ({ stripHistory: { enabled: true } }),
    getRuntime: () => undefined,
    warn: (message) => warns.push(message),
  });
  const messages = [user("u1", "q"), assistant("a1", "OLD"), user("u2", "q2"), assistant("a2", "ACTIVE")];
  check(arm({ provider: "deepseek", model: "deepseek-chat", messages }) === null, "no runtime means no plan");
  check(warns.some((line) => line.includes("no llm runtime")), "the missing runtime is reported");
}
{
  // A config read that throws must not break the request.
  const warns = [];
  const arm = createStripArm({ read: () => { throw new Error("boom"); }, getRuntime: () => ({ stream: () => {} }), warn: (m) => warns.push(m) });
  check(arm({ provider: "deepseek", model: "deepseek-chat", messages: [] }) === null, "a throwing config read plans nothing");
  check(warns.length > 0, "the config fault is reported");
}
{
  const logs = [];
  const arm = createStripArm({
    read: () => ({ stripHistory: { enabled: true } }),
    getRuntime: () => ({ stream: () => {} }),
    log: (message) => logs.push(message),
  });
  const messages = [user("u1", "q"), assistant("a1", "OLD"), user("u2", "q2"), assistant("a2", "ACTIVE")];
  arm({ provider: "deepseek", model: "deepseek-chat", messages });
  arm({ provider: "deepseek", model: "deepseek-chat", messages });
  check(logs.length === 1, `the strip is logged once per window, not once per request (got ${logs.length})`);
  check(logs[0].includes("deepseek"), "the log names the provider");
}

console.log(failures === 0 ? "\nALL STRIP CHECKS PASSED" : `\n${failures} STRIP CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
