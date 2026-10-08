/**
 * dsh-reasoning-loop-guard — the recovery arm (opt-in, default off).
 *
 * The guard's core behaviour is to abort a stream whose reasoning has fallen
 * into a loop. That leaves the agent step failed, and DSH's default reaction to
 * a failure is to surface it — the turn ends, and the user has to type
 * something to get the model moving again. When the abort is *our* doing, and
 * the model was merely stuck rather than broken, there is a better answer:
 * tell it what happened and let it try again.
 *
 * This module implements that answer on `agent/request-error`, the documented
 * recovery extension point. Returning `{ kind: "retry" }` from that waterfall
 * makes the agent loop re-run the same step.
 *
 * ## Two facts that shape the implementation
 *
 * 1. **A retry re-sends the identical request.** The loop's `firstAttempt` flag
 *    is already false on the second pass, so no user message is appended again,
 *    and `buildRequest` re-derives messages from the session log. The aborted
 *    `assistant/attempt` contributes nothing to that derivation (`deriveEventMessage`
 *    has no case for it). Retrying without saying anything new therefore
 *    reproduces the same loop. This arm is only meaningful because it appends a
 *    message first.
 *
 * 2. **The corrective message must carry a producer-owned `source.kind`.**
 *    Session format v4 rejects `kind: "plugin"` outright, so the message is
 *    stamped `{ kind: "reasoning-loop-guard" }`. A side effect worth knowing:
 *    the chat UI renders user messages whose `source.kind` is not `user` as a
 *    context note rather than a user bubble — which is the right presentation
 *    for a machine-inserted nudge.
 *
 * ## Failure policy
 *
 * Every step is wrapped. If the message cannot be appended the arm delegates to
 * `next()`, and the failure becomes terminal exactly as it would have been
 * without the plugin. Recovery is an optimisation; it must never be the reason
 * a session breaks.
 *
 * @module dsh-reasoning-loop-guard/recovery
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { FAILURE_CODE } from "./guard.js";

/** `source.kind` stamped on the corrective message. */
export const PRODUCER_KIND = "reasoning-loop-guard";

/** Used when `recovery.message` is left empty. */
export const DEFAULT_RECOVERY_MESSAGE = "检测到推理进入重复循环，reasoning-loop-guard 已中断本次流。请立即停止重复分析，直接给出结论；若确实无法解决，请直接说明。";

/**
 * Key under which retries are counted: one budget per step, not per session.
 *
 * Counting per session would let one bad turn disable recovery for the rest of
 * the conversation; counting per attempt would make `maxRetries` meaningless.
 * @param payload - the `agent/request-error` payload.
 * @returns a stable string key.
 */
export function attemptKey(payload) {
  const sessionId = payload?.agent?.session?.id ?? "?";
  return `${sessionId}:${payload?.turn ?? "?"}:${payload?.step ?? "?"}`;
}

/**
 * Is this failure the guard's own abort?
 * @param payload - the `agent/request-error` payload.
 * @param config - effective configuration.
 * @returns whether the recovery arm should consider acting.
 */
export function isGuardFailure(payload, config) {
  const code = payload?.failure?.code;
  return typeof code === "string" && code === (config?.failureCode ?? FAILURE_CODE);
}

/**
 * Build the corrective message.
 *
 * `createUserMessage` (not a hand-built object) because the session layer
 * requires every message to carry a non-empty string id, and it is the
 * constructor that mints one.
 * @param text - the configured message body.
 * @returns a frozen user message ready to append.
 */
export function correctiveMessage(text) {
  const body = typeof text === "string" && text.trim() !== "" ? text : DEFAULT_RECOVERY_MESSAGE;
  return createUserMessage({
    content: [{ type: "text", text: body }],
    source: { kind: PRODUCER_KIND },
  });
}

/** Config keys this module reads, with the defaults that keep it inert. */
export const RECOVERY_DEFAULTS = Object.freeze({
  enabled: false,
  message: DEFAULT_RECOVERY_MESSAGE,
  maxRetries: 2,
});

/**
 * Create the `agent/request-error` listener.
 *
 * @param options - `{ read, log, warn }`; `read()` returns the current effective
 *   configuration, so a settings change applies to the next failure without a
 *   restart.
 * @returns an async waterfall listener `(payload, next) => Promise<Action>`.
 */
export function createRecoveryListener(options = {}) {
  const { read, log = () => {}, warn = () => {} } = options;
  const attempts = new Map();

  return async function onRequestError(payload, next) {
    let live;
    let settings;
    try {
      live = read();
      settings = { ...RECOVERY_DEFAULTS, ...(live?.recovery ?? {}) };
    } catch (error) {
      warn(`reasoning-loop-guard: recovery disabled for this failure: ${String(error?.message ?? error)}`);
      return next();
    }
    if (settings.enabled !== true) return next();
    // Recovery only ever answers a failure the guard itself raised. With the
    // core switched off from the GUI no such failure can be raised any more, so
    // the arm stays out of the way even if its own switch is still on. Only an
    // explicit `false` turns the core off: an absent key means "as shipped",
    // which is armed.
    if (live?.enabled === false) return next();
    if (!isGuardFailure(payload, live)) return next();

    const key = attemptKey(payload);
    const used = attempts.get(key) ?? 0;
    if (used >= settings.maxRetries) {
      log(`reasoning-loop-guard: recovery budget spent for ${key} (${used}/${settings.maxRetries}) — leaving the failure terminal`);
      return next();
    }

    try {
      const session = payload?.agent?.session;
      if (session === undefined || typeof session.append !== "function") {
        warn("reasoning-loop-guard: recovery skipped: the failure carries no appending session");
        return next();
      }
      const message = correctiveMessage(settings.message);
      session.append("user/message", message, { surfaceOp: "append" });
      attempts.set(key, used + 1);
      log(`reasoning-loop-guard: recovery ${used + 1}/${settings.maxRetries} for ${key} — appended a corrective message and retried the step`);
      // Take over recovery: do NOT call next(), or the platform would settle
      // the failure as terminal before the retry is scheduled.
      return { kind: "retry" };
    } catch (error) {
      warn(`reasoning-loop-guard: recovery failed, leaving the failure terminal: ${String(error?.message ?? error)}`);
      return next();
    }
  };
}
