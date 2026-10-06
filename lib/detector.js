/**
 * dsh-reasoning-loop-guard — incremental detector for degenerate reasoning loops.
 *
 * The failure mode this guards against was observed in a real 12-turn session:
 * the model finished its actual engineering reasoning and then looped on short
 * "let me write it / OK, emit / Go" phrases forever — 208 s and 244k characters
 * in a single step, ending only because the user pressed stop. Healthy reasoning
 * never does this, so the detector looks for *contiguous repetition at the tail*
 * of the streamed reasoning text.
 *
 * Two rules, evaluated on a rolling buffer every `every` characters:
 *
 *  1. `periodic-run` (primary): the buffered tail ends with >= `minUnits`
 *     identical consecutive units of period p in [minPeriod, maxPeriod].
 *     Measured on real data (166 healthy blobs, 11 degenerate blobs):
 *     degenerate 5..50 units, healthy 0 units — a zero-false-positive rule.
 *
 *  2. `kgram-repeat` (backup): the last `kgram` characters occur at least
 *     `kgramThreshold` times inside the rolling window. Degenerate blobs peak at
 *     20..162, healthy blobs at 5, so the threshold sits at 12.
 *
 * The module is pure (no Cordis, no I/O) so it can be unit-tested offline
 * against the real fixtures.
 */

/** Tunables. Every field is overridable through the plugin config. */
export const DEFAULTS = Object.freeze({
  /** Do not judge before this much reasoning text has streamed. */
  minChars: 1500,
  /** Evaluate the buffer once every N characters. */
  every: 200,
  /** Rolling buffer (characters) used by the k-gram rule. */
  window: 4096,
  /** Tail length of the repeated k-gram. */
  kgram: 64,
  /** Occurrences of the tail k-gram inside the window that count as a loop. */
  kgramThreshold: 12,
  /** Rolling buffer (characters) used by the periodic-run rule. */
  periodTail: 1200,
  /** Shortest repeated unit considered by the periodic-run rule. */
  minPeriod: 8,
  /** Longest repeated unit considered by the periodic-run rule. */
  maxPeriod: 400,
  /** Consecutive identical units that count as a loop. */
  minUnits: 4,
});

/**
 * Longest run of identical consecutive units at the end of `tail`.
 * @param tail - buffered reasoning text (its end is the stream tail).
 * @param minPeriod - shortest unit length to consider.
 * @param maxPeriod - longest unit length to consider.
 * @returns the winning `{ units, period }`; `units` is 0 when nothing repeats.
 */
export function periodicRun(tail, minPeriod, maxPeriod) {
  let units = 0;
  let period = 0;
  for (let p = minPeriod; p <= maxPeriod; p += 1) {
    if (tail.length < 2 * p) break;
    const last = tail.slice(-p);
    if (tail.slice(-2 * p, -p) !== last) continue;
    let run = 2;
    while (tail.length >= (run + 1) * p && tail.slice(-(run + 1) * p, -run * p) === last) run += 1;
    if (run > units) {
      units = run;
      period = p;
    }
  }
  return { units, period };
}

/**
 * How many times the window's last `k` characters occur inside the window.
 * @param buf - rolling buffer.
 * @param k - k-gram length.
 * @returns the occurrence count (overlapping matches included); 0 when too short.
 */
export function kgramCount(buf, k) {
  if (buf.length < k) return 0;
  const tail = buf.slice(-k);
  let count = 0;
  let at = buf.indexOf(tail);
  while (at !== -1) {
    count += 1;
    at = buf.indexOf(tail, at + 1);
  }
  return count;
}

/**
 * Judge the current buffer.
 *
 * The verdict carries a `preview`: the repeating unit itself. That is what
 * makes a fire reviewable after the fact — the journal keeps this short string
 * instead of the 200k-character reasoning blob that produced it. By
 * construction the preview is the degenerate filler ("Let me write. Go."), not
 * the model's substantive reasoning.
 *
 * @param buf - k-gram rolling buffer.
 * @param periodBuf - periodic-run rolling buffer.
 * @param total - characters consumed so far.
 * @param config - resolved tunables.
 * @returns a verdict object, or null while the text still looks healthy.
 */
export function judge(buf, periodBuf, total, config) {
  const run = periodicRun(periodBuf, config.minPeriod, config.maxPeriod);
  if (run.units >= config.minUnits) {
    return {
      rule: "periodic-run",
      atChars: total,
      units: run.units,
      period: run.period,
      preview: periodBuf.slice(-run.period),
    };
  }
  const count = kgramCount(buf, config.kgram);
  if (count >= config.kgramThreshold) {
    return { rule: "kgram-repeat", atChars: total, count, preview: buf.slice(-config.kgram) };
  }
  return null;
}

/**
 * Create one incremental detector. State is per model stream: a new detector is
 * created for every `llm/stream` call, so an automatic retry starts clean.
 * @param overrides - partial tunables merged over {@link DEFAULTS}.
 * @returns a detector with `feed(text)` and read-only `total` / `fired`.
 */
export function createDetector(overrides = {}) {
  const config = { ...DEFAULTS, ...overrides };
  let buf = "";
  let periodBuf = "";
  let total = 0;
  let nextAt = config.minChars;
  let fired = null;
  return {
    get total() {
      return total;
    },
    get fired() {
      return fired;
    },
    /** Current k-gram rolling buffer (exposed for tests and diagnostics). */
    get buffer() {
      return buf;
    },
    /** Current periodic-run rolling buffer (exposed for tests and diagnostics). */
    get periodBuffer() {
      return periodBuf;
    },
    /**
     * Feed one slice of streamed reasoning text.
     * @param text - newly streamed characters.
     * @returns the verdict once the text looks degenerate, else null.
     */
    feed(text) {
      if (fired !== null || typeof text !== "string" || text.length === 0) return fired;
      total += text.length;
      buf = (buf + text).slice(-config.window);
      periodBuf = (periodBuf + text).slice(-config.periodTail);
      if (total < nextAt) return null;
      nextAt = total + config.every;
      fired = judge(buf, periodBuf, total, config);
      return fired;
    },
  };
}
