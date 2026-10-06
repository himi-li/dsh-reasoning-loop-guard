/**
 * dsh-reasoning-loop-guard — historical reasoning stripping (opt-in, default off).
 *
 * A second, complementary attack on the same failure mode. The guard's primary
 * rule interrupts a loop *after* it starts; this one removes a known input that
 * provokes it.
 *
 * In thinking mode the DeepSeek adapter replays the `reasoning` block of every
 * historical assistant message back to the API as a wire-level `thinking` block.
 * So on turn *n* the model reads its own chain of thought from turns 1..n-1,
 * including the "let me verify that once more" that started the loop. Re-reading
 * a stalled line of reasoning is a good way to resume it — and the replayed
 * history also inflates the prompt prefix, which costs KV-cache reuse.
 *
 * The strip is bounded by the last *genuine* user turn:
 *
 *  - reasoning **before** that boundary is history and is dropped;
 *  - reasoning **after** it belongs to the active turn and is kept.
 *
 * Getting that boundary wrong is not a cosmetic bug: DeepSeek rejects a thinking
 * request whose active-turn reasoning was removed (`The reasoning_content in the
 * thinking mode must be passed back to the API.`). DSH delivers tool results as
 * `user`-role messages, so a naive "last user message" boundary would land in
 * the middle of a tool loop and strip the live turn. {@link isGenuineUserTurn}
 * is what prevents that.
 *
 * ## The cost, stated plainly
 *
 * The request object handed to `llm/stream` is frozen and `next()` takes no
 * arguments, so the only way to change `messages` is to re-enter the runtime
 * with a new options object. That new object is not in the runtime's
 * `AGENT_LOOP_REQUESTS` weak set, so `isAgentLoopRequest` returns false and
 * `dsh-agent-loop`'s invariant — which checks that the request still matches the
 * session log's derivation — is skipped for it. In other words this arm trades
 * an internal consistency check for the prompt it rewrites. That is exactly why
 * it ships disabled by default, and why the plugin only ever *removes* content
 * here rather than inventing any.
 *
 * @module dsh-reasoning-loop-guard/strip
 */

/** Marker preventing the re-entrant call from being stripped twice. */
export const STRIPPED = Symbol.for("dsh-reasoning-loop-guard.stripped");
const DEEPSEEK = /deepseek/i;

/**
 * Is this message a turn started by a person?
 *
 * Tool results arrive as `user`-role messages, so role alone is not enough:
 * a message whose every block is a `tool-result` continues the current turn
 * rather than starting a new one.
 * @param message - one message from the request.
 * @returns whether the message opens a new user turn.
 */
export function isGenuineUserTurn(message) {
  if (message === null || typeof message !== "object") return false;
  if (message.role !== "user") return false;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return true;
  return content.some((block) => block?.type !== "tool-result");
}

/**
 * Index of the last genuine user turn.
 * @param messages - the request's message list.
 * @returns the index, or -1 when the whole list is active-turn content.
 */
export function lastUserTurnIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isGenuineUserTurn(messages[index])) return index;
  }
  return -1;
}

/**
 * Does this request belong to a provider whose history we understand?
 *
 * Anything that is not clearly DeepSeek is left alone: other providers may rely
 * on replayed reasoning to keep context, and stripping it there would be a
 * silent quality regression in someone else's territory.
 * @param options - the `GenerateOptions` of this call.
 * @returns whether stripping is applicable.
 */
export function shouldStrip(options) {
  if (options === null || typeof options !== "object") return false;
  if (DEEPSEEK.test(String(options.provider ?? ""))) return true;
  return DEEPSEEK.test(String(options.model ?? ""));
}

/**
 * Drop the `reasoning` blocks of messages at or before the boundary.
 *
 * Always returns a new array of new message objects: the request object is part
 * of the session log, and rewriting it in place would corrupt what gets
 * persisted. When nothing changes the original array is returned, which the
 * caller uses as the signal to pass the request through untouched.
 * @param messages - the request's message list.
 * @returns the rewritten list, or the original when there was nothing to drop.
 */
export function stripHistoricalReasoning(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const boundary = lastUserTurnIndex(messages);
  let changed = false;
  const next = messages.map((message, index) => {
    if (index > boundary) return message;
    if (message === null || typeof message !== "object") return message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    if (!message.content.some((block) => block?.type === "reasoning")) return message;
    changed = true;
    return { ...message, content: message.content.filter((block) => block?.type !== "reasoning") };
  });
  return changed ? next : messages;
}

/**
 * Create the history-strip arm.
 *
 * Deliberately *not* a standalone `llm/stream` listener. Rewriting the request
 * means re-entering the runtime, and a re-entrant call would run every
 * `llm/stream` listener a second time — including the guard itself, which would
 * then journal one loop twice. So this arm is a pure decision function that the
 * guard's single listener consults: it either reports the rewritten request to
 * re-enter with, or nothing.
 *
 * @param options - `{ read, getRuntime, log, warn }`.
 * @returns `(streamOptions) => options | null` — the replacement request options
 *   to re-enter with, or `null` to let the caller continue normally.
 */
export function createStripArm(options = {}) {
  const { read, getRuntime, log = () => {}, warn = () => {} } = options;
  let lastLogAt = 0;

  return function plan(streamOptions) {
    if (streamOptions?.[STRIPPED] === true) return null;
    let enabled = false;
    try {
      enabled = read()?.stripHistory?.enabled === true;
    } catch (error) {
      // Reported rather than swallowed: the switch is on disk, so a silent
      // failure here looks exactly like "the feature does nothing".
      warn(`reasoning-loop-guard: history strip skipped, could not read settings: ${String(error?.message ?? error)}`);
      return null;
    }
    if (!enabled) return null;
    if (!shouldStrip(streamOptions)) return null;

    let stripped;
    try {
      stripped = stripHistoricalReasoning(streamOptions.messages);
    } catch (error) {
      warn(`reasoning-loop-guard: history strip failed, sending the request unchanged: ${String(error?.message ?? error)}`);
      return null;
    }
    if (stripped === streamOptions.messages) return null;

    const runtime = getRuntime?.();
    if (runtime === undefined || typeof runtime.stream !== "function") {
      warn("reasoning-loop-guard: history strip skipped: no llm runtime to re-enter");
      return null;
    }

    // Rate-limited so a long conversation does not flood the log, and wrapped
    // because a logging fault must never break a request.
    try {
      const now = Date.now();
      if (now - lastLogAt > 30000) {
        lastLogAt = now;
        log(`reasoning-loop-guard: stripped historical reasoning (provider=${streamOptions.provider ?? "?"} model=${streamOptions.model ?? "?"})`);
      }
    } catch {
      // Nothing to do; the request is what matters.
    }

    return { ...streamOptions, [STRIPPED]: true, messages: stripped };
  };
}
