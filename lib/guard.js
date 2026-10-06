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
 * @param verdict - detector verdict (`periodic-run` or `kgram-repeat`).
 * @returns the human-readable failure message.
 */
export function failureMessage(verdict) {
  const detail = verdict.rule === "periodic-run"
    ? `连续重复片段：周期 ${verdict.period} 字符，重复 ${verdict.units} 次`
    : `重复片段：末尾同一段文本出现 ${verdict.count} 次`;
  return `模型推理进入重复循环（${detail}，已读到 ${verdict.atChars} 字符）——reasoning-loop-guard 提前中断了本次流，以免长时间卡死。`;
}

/**
 * Wrap one model stream with the repetition guard.
 * @param source - upstream chunk stream (the adapter's, via the waterfall).
 * @param options - the `GenerateOptions` of this call (for `sessionId`/`signal`).
 * @param config - resolved plugin configuration.
 * @param log - optional `(message) => void` sink for the firing account.
 * @param onFire - optional `(verdict, options, config) => void` hook invoked
 *   once, just before the terminal chunk, so the caller can journal the firing.
 *   A throw from it is swallowed: telemetry must never break the stream.
 * @returns the guarded chunk stream.
 */
export async function* guardStream(source, options, config, log, onFire) {
  const detector = createDetector(config);
  let verdict = null;
  for await (const chunk of source) {
    if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
      verdict = detector.feed(chunk.text);
      if (verdict !== null) break;
    }
    yield chunk;
  }
  if (verdict === null) return;
  const failure = { message: failureMessage(verdict), code: config.failureCode ?? FAILURE_CODE };
  log?.(`reasoning-loop-guard: ${verdict.rule} after ${verdict.atChars} chars of reasoning (session ${options.sessionId ?? "?"}) — aborting stream`);
  try {
    onFire?.(verdict, options, config);
  } catch {
    // Journaling is best-effort; a telemetry fault must not break the stream.
  }
  yield {
    type: "finish",
    reason: options.signal?.aborted === true ? { kind: "aborted", failure } : { kind: "error", failure },
  };
}
