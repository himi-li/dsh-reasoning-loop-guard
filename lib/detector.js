/**
 * dsh-reasoning-loop-guard — incremental detector for degenerate reasoning loops.
 *
 * The failure mode this guards against was observed in a real 12-turn session:
 * the model finished its actual engineering reasoning and then looped on short
 * "let me write it / OK, emit / Go" phrases forever — 208 s and 244k characters
 * in a single step, ending only because the user pressed stop. Healthy reasoning
 * never does this, so the detector looks for *repetition* in the streamed text.
 *
 * Four rules, evaluated on a rolling buffer every `every` characters:
 *
 *  1. `periodic-run` (primary): the buffered tail ends with >= `minUnits`
 *     identical consecutive units of period p in [minPeriod, maxPeriod].
 *  2. `block-repeat`: some `blockMin`-character block occurs at least
 *     `blockCount` times inside the window.
 *  3. `line-repeat`: some line of at least `lineMin` characters occurs at least
 *     `lineCount` times.
 *  4. `kgram-repeat` (backup): the last `kgram` characters occur at least
 *     `kgramThreshold` times inside the window.
 *  5. `filler-run` (last resort): the RAW text holds a run of at least
 *     `fillerRun` characters that are all whitespace, punctuation or symbols.
 *
 * ## Why the text is normalized first
 *
 * Rules 1, 2 and 4 count on `normalize(text)`: whitespace, punctuation and
 * symbols are stripped first. Normalizing keeps those rules on *semantic*
 * repetition and makes the recorded preview readable.
 *
 * The strip class has to be wide. An earlier version stripped a hand-written
 * list that happened to omit `_`, so eight underscores survived normalization
 * as eight identical characters and fired `periodic-run` at
 * `period=8 · units=6` — a real false positive, produced by a model drawing a
 * horizontal rule. `[\s\p{P}\p{S}]` matches every whitespace, punctuation and
 * symbol code point instead of a guessed list that is always one character
 * short. Digits and letters stay: a repeating number table is a real loop.
 *
 * Stripping decoration is also why rule 5 exists. Once decoration is removed
 * the repetition rules cannot see a run of it at all, so the one case worth
 * catching — a decoration run so long that no formatting could explain it —
 * is checked separately, on the raw text, as the last resort.
 *
 * ## Rule 3 measures lines, and must not reuse rule 2's buffer
 *
 * `line-repeat` splits the RAW text on newlines and normalizes each line
 * separately. Normalizing the whole blob first erases the newlines, so a
 * line-oriented rule fed the block-oriented buffer silently never splits
 * anything (a backtest that mixed the two conventions reported 166/166 false
 * positives — a measurement artifact, not a detector result).
 *
 * ## What the numbers looked like when these thresholds were chosen
 *
 * Measured over 11 degenerate blobs, 166 healthy blobs and 3 real loops
 * captured from live sessions. Under the defaults below every degenerate blob
 * and every real loop fires, and no healthy blob does.
 *
 * The module is pure (no Cordis, no I/O) so it can be unit-tested offline
 * against the real fixtures.
 */

/**
 * Rule names, in the order {@link judge} evaluates them.
 * Other modules import this instead of repeating the literal list, so adding a
 * rule means editing the detector and its formatting, not every consumer.
 */
export const REPEAT_RULES = Object.freeze(["periodic-run", "block-repeat", "line-repeat", "kgram-repeat", "filler-run"]);

/**
 * Noise characters: whitespace, punctuation and symbols carry no repetition
 * signal, so every counting rule works on the text with them removed.
 *
 * Written as Unicode property escapes rather than a literal list. The list this
 * replaced omitted `_`, and eight underscores therefore survived normalization
 * as eight identical characters — enough to fire `periodic-run` at
 * `period=8 · units=6` on a model drawing a horizontal rule. A guessed list is
 * always one character short; `\p{P}` and `\p{S}` are exhaustive by
 * construction. Digits and letters stay, because a repeating number table is a
 * real loop, not noise.
 *
 * The two classes together are a strict superset of the old list: `_` is
 * `\p{Pc}`, `─`/`▁` are `\p{So}`, and every character the old list named is
 * whitespace, punctuation or a symbol — so nothing it stripped is now kept.
 */
const STRIP = /[\s\p{P}\p{S}]/gu;

/**
 * Trailing run of decoration characters, for {@link fillerRun}.
 * Same class as {@link STRIP}, anchored to the end of the text.
 */
const FILLER_TAIL = /[\s\p{P}\p{S}]+$/u;

/** Tunables. Every field is overridable through the plugin config. */
export const DEFAULTS = Object.freeze({
  /** Do not judge before this much reasoning text has streamed. */
  minChars: 800,
  /** Evaluate the buffer once every N characters. */
  every: 200,
  /** Rolling buffer (characters) used by the block and k-gram rules. */
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
  /** Shortest block considered by the block-repeat rule (normalized chars). */
  blockMin: 100,
  /** Occurrences of the same block that count as a loop. */
  blockCount: 3,
  /** Shortest line considered by the line-repeat rule (normalized chars). */
  lineMin: 10,
  /** Occurrences of the same line that count as a loop. */
  lineCount: 2,
  /**
   * Consecutive decoration characters (whitespace/punctuation/symbols) at the
   * end of the RAW text that count as a loop, regardless of repetition.
   *
   * This is the "unless it is especially long" escape hatch. Decoration is
   * usually formatting, so the bar sits above anything formatting produces:
   * measured over real shapes, a 150-wide ASCII box reaches 151 characters, a
   * 20-column markdown table row 142, a setext underline 62, a `---` rule 5.
   * The false positive that motivated this rule was 8 underscores. 400 is 2.6x
   * above the widest legitimate shape found, and a genuine decoration stall
   * exceeds it within one `every` interval.
   *
   * Anchored to the tail: a finished diagram stops counting as soon as the model
   * writes anything else, so only an ongoing decoration stream can fire.
   */
  fillerRun: 400,
});

/**
 * Strip whitespace and punctuation, the noise every counting rule ignores.
 * @param text - raw streamed text.
 * @returns the normalized text (empty when there was nothing but noise).
 */
export function normalize(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  return text.replace(STRIP, "");
}

/**
 * Longest run of identical consecutive units at the end of `tail`.
 * Expects {@link normalize}d input: the caller strips noise once and reuses it.
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
 * Expects {@link normalize}d input: the caller strips noise once and reuses it.
 * @param buf - rolling buffer.
 * @param k - k-gram length.
 * @returns the occurrence count (overlapping matches included); 0 when too short.
 */
export function kgramCount(buf, k) {
  if (!Number.isSafeInteger(k) || k <= 0 || buf.length < k) return 0;
  const tail = buf.slice(-k);
  let count = 0;
  let at = buf.indexOf(tail);
  while (at !== -1) {
    count += 1;
    const next = buf.indexOf(tail, at + 1);
    if (next <= at) break;
    at = next;
  }
  return count;
}

/**
 * Most-repeated `minBlock`-character block inside `text`.
 *
 * Normalizes internally: this rule is defined on the noise-free projection of
 * the text, so cross-line repeats ("the same sentence, reformatted") count.
 * @param text - raw rolling buffer.
 * @param minBlock - block length in normalized characters.
 * @param minCount - occurrences that count as a loop.
 * @returns `{ count, blockLen, block }`; `count` is 0 when nothing qualifies.
 */
export function blockRepeat(text, minBlock, minCount) {
  const empty = { count: 0, blockLen: 0, block: "" };
  if (!Number.isSafeInteger(minBlock) || minBlock < 2) return empty;
  if (!Number.isSafeInteger(minCount) || minCount < 2) return empty;
  const norm = normalize(text);
  if (norm.length < minBlock * minCount) return { count: 0, blockLen: minBlock, block: "" };
  const seen = new Map();
  for (let at = 0; at + minBlock <= norm.length; at += 1) {
    const key = norm.slice(at, at + minBlock);
    const count = (seen.get(key) ?? 0) + 1;
    if (count >= minCount) return { count, blockLen: minBlock, block: key };
    seen.set(key, count);
  }
  return { count: 0, blockLen: minBlock, block: "" };
}

/**
 * Most-repeated line inside `text`, measured line by line.
 *
 * Splits on newlines FIRST and normalizes each line separately — see the module
 * header for why reusing the block-oriented buffer here is a bug, not a
 * shortcut.
 * @param text - raw rolling buffer.
 * @param minLine - line length in normalized characters.
 * @param minCount - occurrences that count as a loop.
 * @returns `{ count, lineLen, line }`; `count` is 0 when nothing qualifies.
 */
export function lineRepeat(text, minLine, minCount) {
  const empty = { count: 0, lineLen: 0, line: "" };
  if (typeof text !== "string" || text.length === 0) return empty;
  if (!Number.isSafeInteger(minLine) || minLine < 2) return empty;
  if (!Number.isSafeInteger(minCount) || minCount < 2) return empty;
  const seen = new Map();
  for (const raw of text.split(/\n+/)) {
    const line = normalize(raw);
    if (line.length < minLine) continue;
    const count = (seen.get(line) ?? 0) + 1;
    if (count >= minCount) return { count, lineLen: line.length, line };
    seen.set(line, count);
  }
  return empty;
}

/**
 * Length of the run of decoration characters (whitespace, punctuation or
 * symbols) at the very END of the raw text, and its first character.
 *
 * The counting rules cannot see this: they strip decoration before measuring, so
 * a model that fills the stream with `_` or spaces leaves them nothing to count
 * and passes clean forever. That is the intended trade — decoration is usually
 * formatting — but a stream that is *currently* producing nothing else is a
 * stall, and this is the only rule that can say so.
 *
 * Anchored to the end on purpose. A model may legitimately draw a wide table or
 * an ASCII diagram; once it moves on to prose the run is no longer at the tail
 * and stops counting, so only an ongoing decoration stream can fire. A run
 * anywhere in the buffer would fire on any diagram the model had already
 * finished.
 *
 * @param text - raw rolling buffer.
 * @param minRun - run length that counts as a loop.
 * @returns `{ run, char }`; `run` is 0 when the tail is not decoration.
 */
export function fillerRun(text, minRun) {
  const empty = { run: 0, char: "" };
  if (typeof text !== "string" || text.length === 0) return empty;
  if (!Number.isSafeInteger(minRun) || minRun < 2) return empty;
  const match = FILLER_TAIL.exec(text);
  if (match === null) return empty;
  // Count code points, not UTF-16 units, so a run of astral symbols (many are
  // `\p{So}`) is measured the same way every other character count here is.
  const points = Array.from(match[0]);
  return points.length >= minRun ? { run: points.length, char: points[0] } : empty;
}

/**
 * Judge the current buffer.
 *
 * The verdict carries a `preview`: the repeating material itself. That is what
 * makes a fire reviewable after the fact — the journal keeps this short string
 * instead of the 200k-character reasoning blob that produced it. By
 * construction the preview is the degenerate filler, and because every counting
 * rule works on normalized text it is never a run of blank space; only
 * `filler-run`, which reads the raw text on purpose, can report one.
 *
 * @param buf - rolling buffer shared by the block and k-gram rules.
 * @param periodBuf - periodic-run rolling buffer.
 * @param total - characters consumed so far.
 * @param config - resolved tunables.
 * @returns a verdict object, or null while the text still looks healthy.
 */
export function judge(buf, periodBuf, total, config) {
  const periodText = normalize(periodBuf);
  const run = periodicRun(periodText, config.minPeriod, config.maxPeriod);
  if (run.units >= config.minUnits) {
    return {
      rule: "periodic-run",
      atChars: total,
      units: run.units,
      period: run.period,
      preview: periodText.slice(-run.period),
    };
  }
  const block = blockRepeat(buf, config.blockMin, config.blockCount);
  if (block.count >= config.blockCount) {
    return {
      rule: "block-repeat",
      atChars: total,
      count: block.count,
      blockLen: block.blockLen,
      preview: block.block,
    };
  }
  const line = lineRepeat(buf, config.lineMin, config.lineCount);
  if (line.count >= config.lineCount) {
    return {
      rule: "line-repeat",
      atChars: total,
      count: line.count,
      lineLen: line.lineLen,
      preview: line.line,
    };
  }
  const text = normalize(buf);
  const count = kgramCount(text, config.kgram);
  if (count >= config.kgramThreshold) {
    return { rule: "kgram-repeat", atChars: total, count, preview: text.slice(-config.kgram) };
  }
  // Last resort, on the RAW buffer: the counting rules above deliberately strip
  // decoration before measuring, so a stream of nothing but decoration reaches
  // here with an empty normalized text and no verdict at all.
  const filler = fillerRun(buf, config.fillerRun);
  if (filler.run >= config.fillerRun) {
    return { rule: "filler-run", atChars: total, count: filler.run, preview: filler.char.repeat(Math.min(filler.run, 40)) };
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
    /** Current rolling buffer (exposed for tests and diagnostics). */
    get buffer() {
      return buf;
    },
    /** Current periodic-run rolling buffer (exposed for tests and diagnostics). */
    get periodBuffer() {
      return periodBuf;
    },
    /** Resolved tunables, including defaults for every unspecified field. */
    get config() {
      return config;
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
