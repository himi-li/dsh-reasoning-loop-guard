/**
 * dsh-reasoning-loop-guard — the dependency-free half of the guard.
 *
 * Kept apart from `index.js` so the stream logic can be unit-tested offline,
 * without resolving `@deepseek-ai/schemastery` (only the Cordis plugin entry
 * needs it). Protocol notes that constrain the implementation:
 *
 *  - `@deepseek-ai/dsh-llm` validates every stream (`llm-invariant`): a stream
 *    may only end through one terminal `finish` chunk, and open blocks are
 *    tolerated *only* for `kind: "error"` / `kind: "aborted"`. The guard
 *    therefore emits exactly one `finish` chunk and nothing after it.
 *  - Only `reasoning-delta` chunks are measured. `block-end` repeats the whole
 *    block text, so feeding both would double the buffer and fake a repeat.
 *  - `failure.code` decides whether `dsh-llm-retry` retries. `REASONING_LOOP` is
 *    deliberately outside the default retryable set (EMPTY_RESPONSE, RATE_LIMIT,
 *    SERVER, TIMEOUT, TRANSPORT): a loop is a property of the request, and each
 *    automatic retry re-sends the whole prompt. Set `failureCode: EMPTY_RESPONSE`
 *    to opt into the retry policy instead.
 */
import { createDetector } from "./detector.js";

/**
 * Failure code reported when the guard trips. Deliberately outside the default
 * retryable set (EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT):
 * a loop is a property of the request, and every automatic retry re-sends the
 * whole prompt, so retrying would just burn tokens to loop again. Configure
 * `failureCode: "EMPTY_RESPONSE"` to opt into the retry policy instead.
 */
export const FAILURE_CODE = "REASONING_LOOP";

/**
 * One-line account of a fired verdict.
 * @param verdict - detector verdict; `rule` is one of the detector's
 *   {@link import("./detector.js").REPEAT_RULES}.
 * @returns the human-readable failure message.
 */
export function failureMessage(verdict) {
  let detail;
  switch (verdict.rule) {
    case "periodic-run":
      detail = `连续重复片段：周期 ${verdict.period} 字符，重复 ${verdict.units} 次`;
      break;
    case "block-repeat":
      detail = `连续重复片段：同一段 ${verdict.blockLen} 字符文本重复 ${verdict.count} 次`;
      break;
    case "line-repeat":
      detail = `重复行：同一行（${verdict.lineLen} 字符）出现 ${verdict.count} 次`;
      break;
    default:
      detail = `重复片段：末尾同一段文本出现 ${verdict.count} 次`;
      break;
  }
  return `模型推理进入重复循环（${detail}，已读到 ${verdict.atChars} 字符）——reasoning-loop-guard 提前中断了本次流，以免长时间卡死。`;
}

/**
 * The tunables a fire should be reviewable against, captured at fire time.
 * Recording this turns "why did it fire?" into a question the journal answers
 * on its own: thresholds get retuned, and a six-month-old record still shows
 * what the detector was actually configured with.
 * @param config - resolved plugin configuration.
 * @returns the detection-relevant subset, as plain JSON.
 */
export function thresholdSnapshot(config) {
  return {
    minChars: config.minChars,
    every: config.every,
    window: config.window,
    kgram: config.kgram,
    kgramThreshold: config.kgramThreshold,
    periodTail: config.periodTail,
    minPeriod: config.minPeriod,
    maxPeriod: config.maxPeriod,
    minUnits: config.minUnits,
    blockMin: config.blockMin,
    blockCount: config.blockCount,
    lineMin: config.lineMin,
    lineCount: config.lineCount,
  };
}

/**
 * Wrap one model stream with the repetition guard.
 * @param source - upstream chunk stream (the adapter's, via the waterfall).
 * @param options - the `GenerateOptions` of this call (for `sessionId`/`signal`).
 * @param config - resolved plugin configuration.
 * @param log - optional `(message) => void` sink for the firing account.
 * @param onFire - optional `(verdict, options, config, facts) => void` hook
 *   invoked once, just before the terminal chunk, so the caller can journal the
 *   firing. `facts` carries the measurement context (timing, attempt, cwd).
 *   A throw from it is swallowed: telemetry must never break the stream.
 * @param probe - optional supplier of `{ attempt, cwd }` for the richer record,
 *   called once at fire time. A thunk rather than a value because the host
 *   announces the attempt identity *after* the stream middleware runs, so a
 *   value captured earlier would describe the previous attempt. `attempt` is
 *   `{ attemptId, turn, step }` when the host reported one for this session, and
 *   `cwd` the session's working directory. Both are best-effort: a host without
 *   the corresponding service simply yields `null`.
 * @returns the guarded chunk stream.
 */
export async function* guardStream(source, options, config, log, onFire, probe) {
  const detector = createDetector(config);
  const startedAt = Date.now();
  let firstReasoningAt = null;
  let reasoningChars = 0;
  let verdict = null;
  for await (const chunk of source) {
    if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
      if (firstReasoningAt === null) firstReasoningAt = Date.now();
      reasoningChars += chunk.text.length;
      verdict = detector.feed(chunk.text);
      if (verdict !== null) break;
    }
    yield chunk;
  }
  if (verdict === null) return;
  const firedAt = Date.now();
  const failure = { message: failureMessage(verdict), code: config.failureCode ?? FAILURE_CODE };
  log?.(`reasoning-loop-guard: ${verdict.rule} after ${verdict.atChars} chars of reasoning (session ${options.sessionId ?? "?"}) — aborting stream`);
  let context = { attempt: null, cwd: null };
  try {
    context = (typeof probe === "function" ? probe() : probe) ?? context;
  } catch {
    // Context is diagnostic; a probe fault must not cost us the record.
  }
  try {
    onFire?.(verdict, options, config, {
      startedAt,
      firstReasoningAt,
      firedAt,
      /** Milliseconds from the first reasoning delta to the fire. */
      elapsedMs: firstReasoningAt === null ? null : firedAt - firstReasoningAt,
      /** Milliseconds from stream start (including time to first token). */
      fromStartMs: firedAt - startedAt,
      /**
       * Milliseconds from stream start to the first reasoning delta, i.e. time
       * to first token. Separates "the model was slow" from "the model span
       * fast" — a 30 s prefix followed by a 2 s loop is a different story from
       * a loop that began immediately.
       */
      ttftMs: firstReasoningAt === null ? null : firstReasoningAt - startedAt,
      /** Reasoning characters actually measured (may trail `atChars` slightly). */
      reasoningChars,
      /**
       * Whether the caller had already aborted when the verdict landed. Both
       * settle as a failure, but only one of them is the guard's doing.
       */
      aborted: options.signal?.aborted === true,
      /** Raw text at fire time — the counterweight to the normalized preview. */
      rawTail: detector.buffer.slice(-Math.max(config.journalPreviewChars ?? 120, 120)),
      attempt: context.attempt ?? null,
      cwd: context.cwd ?? null,
    });
  } catch {
    // Journaling is best-effort; a telemetry fault must not break the stream.
  }
  yield {
    type: "finish",
    reason: options.signal?.aborted === true ? { kind: "aborted", failure } : { kind: "error", failure },
  };
}
