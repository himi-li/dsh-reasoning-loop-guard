/**
 * dsh-reasoning-loop-guard — incremental detector for degenerate reasoning loops.
 *
 * The failure mode this guards against was observed in a real 12-turn session:
 * the model finished its actual engineering reasoning and then looped on short
 * "let me write it / OK, emit / Go" phrases forever — 208 s and 244k characters
 * in a single step, ending only because the user pressed stop. Healthy reasoning
 * never does this, so the detector looks for *repetition* in the streamed text.
 *
 * Five rules, evaluated on a rolling buffer every `every` characters:
 *
 *  1. `periodic-run` (primary): the buffered tail ends with >= `minUnits`
 *     identical consecutive units of period p in [minPeriod, maxPeriod]. A unit
 *     that is itself a shorter string repeated is a typed-out pattern, not a
 *     loop, and does not count.
 *  2. `block-repeat`: some `blockMin`-character block occurs at least
 *     `blockCount` times inside the window, at an equal stride.
 *  3. `line-repeat`: some line of at least `lineMin` characters occurs at least
 *     `lineCount` times AND occupies at least `lineShare` of the window. Lines
 *     that are code, markup or diff rows are measured but never reported.
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
 * ## Rule 3 needs two conditions, and the fixtures were not enough to see it
 *
 * `line-repeat` originally fired on two occurrences of a ten-character line.
 * That reads as a safe margin on the synthetic fixtures and was still the
 * noisiest rule in the plugin in practice: 178 firings over 2,799 real reasoning
 * streams, nearly all of them an identifier or a heading that happened to land
 * on two lines while the model was writing code — `Unreleased` in a changelog
 * draft, `pruneIfNeeded` in a function being edited.
 *
 * The fixtures could not have caught it. They are 11 degenerate blobs and 166
 * healthy ones, all prose: they contain no "reasoning while writing code", which
 * is the shape that produces the false positives, so they scored 0/166 on the
 * very behaviour that was failing in the field. A calibration set that does not
 * contain the failure mode will always pass.
 *
 * What actually separates the two populations is how much of the window the
 * repeats occupy. Over those 2,799 streams the highest share reached by a
 * healthy stream is 6.1% — a `Let me write.` tic repeated 17 times — and the
 * weakest genuine loop reaches 10.2%. Count alone does not separate them (the
 * same tic reaches 17 while the weakest real loop reaches 29), and neither does
 * the density of the repeats (a real loop's tightest pair of occurrences spans
 * 12 characters; a healthy struct-field list spans 14). So rule 3 requires
 * `count >= lineCount` AND `share >= lineShare` at the same judge point, which
 * is what makes it a *persistent* condition rather than a momentary one.
 *
 * The count floor cannot go back to 2 even with the share floor in place: one
 * 41-character identifier repeated twice in a 2,159-character stream was worth
 * 19.5% on its own, which is how a share floor alone would still admit it.
 *
 * ## Rule 3 must also ignore code, and a threshold could not have fixed it
 *
 * Two conditions were still not enough, because `STRIP` removes the very
 * characters that tell one line of code from another. A real fire from a live
 * session: five lines in an 801-character reasoning burst,
 *
 *     if (e.isKeyboardEvent()) {                    (quoted three times)
 *     -                if (e.isKeyboardEvent()) {   (the diff's removed line)
 *     +                if (e.isKeyboardEvent()) {   (the diff's added line)
 *
 * all normalize to `ifeisKeyboardEvent`, so the model reads as repeating one
 * line five times — `count=5 · share=22.6%`, past both floors. It was reasoning
 * about an edit, not looping; its next attempt was 4,084 characters of ordinary
 * work that trips no rule at all. The trigger landed at the first judge point
 * (`minChars: 800`) in a `minChars`-sized window, where a handful of repeats is
 * already a large share.
 *
 * No threshold reaches it. `lineCount` must rise from 3 to 6 to clear this one
 * occurrence — inside the range real loops occupy — and raising `lineShare` past
 * it costs genuine detections in the fixtures. So the rule now declines to
 * *report* lines the marker set of {@link CODE_LINE} identifies as code, markup
 * or diff rows, while still counting them in the denominator.
 *
 * Measured over the real 3,862-stream corpus this removes this fire and one
 * other of the same shape (`<p align="center">` quoted from HTML three times)
 * while changing nothing else: the fixtures stay 166 healthy / 11 degenerate,
 * and both remaining `line-repeat` fires are the same genuine loops, unchanged.
 * Diff-marker stripping and dropping normalization entirely were both tried and
 * do not work — `STRIP` already removes `-`/`+` and whitespace, so the three
 * diff rows collide before and after; un-normalized, the same stream still
 * reaches `count=3 · share=11.3%` and fires.
 *
 * The marker set stays narrow: braces, markup tags, diff rows, a trailing
 * semicolon, a dotted call. All are absent from ordinary prose; wider sets that
 * exclude any bracket or operator would also suppress "The config (see above) is
 * wrong." and blind the rule to genuine prose tics.
 *
 * ## One window is not a loop: the second layer, added after four more fires
 *
 * Everything above asks "did anything repeat inside this window?". The week of
 * 2026-10-18 showed that question is too easy to answer yes: four fires in one
 * session, three different rules, all on text that was doing ordinary work.
 *
 * Three shapes, and each got its own answer:
 *
 *  - `block-repeat` fired on four DIFFERENT `runcode` commands — add planet, add
 *    asteroid belt, add nebula, add ring — because they share the boilerplate
 *    that reads the current star system. They share 100 normalized characters;
 *    they are not the same command. Co-occurrence in a window is not repetition.
 *    A real loop emits its block at a CONSTANT PERIOD, so `count` is now the
 *    longest equal-stride chain rather than the raw occurrence count. The three
 *    false positives had gaps of 1130/359/742, 396/666/467 and 651/491/1436; a
 *    real loop's gaps are all identical.
 *  - `periodic-run` fired on `"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"` — the model
 *    typing out a 6x6 tile literal. Normalized, that is the period-8 unit
 *    `xxxxxxxx` repeated; a unit that is itself a repetition is a pattern being
 *    produced, not a structure recurring, so it no longer counts.
 *  - `line-repeat` fired on one Java statement quoted four times while the model
 *    worked out how to add a planet. No braces, no diff marker — the original
 *    marker set simply could not see it. `;\s*$` and `\w+\.\w+\(` catch it.
 *
 * All three were measured at once against the five recorded fires, the 3,862
 * -stream corpus and both fixture sets: five recorded fires inert, corpus fires
 * unchanged (the same four genuine loops at three chunk sizes), fixtures still
 * 166 healthy / 11 degenerate. Each rule change is load-bearing on its own fire
 * and none costs a detection.
 *
 * The general lesson, recorded because it will recur: *presence in a window* is
 * the wrong primitive. A loop is a repetition in TIME — at a constant stride, or
 * continuing to the tail — and the rules that only count occurrences will keep
 * finding coincidences in any code-heavy stream.
 *
 * ## What the numbers looked like when these thresholds were chosen
 *
 * Two measurements, and the second one is the one that matters.
 *
 * The fixtures: 11 degenerate blobs, 166 healthy blobs. Under the defaults
 * below every degenerate blob fires and no healthy blob does.
 *
 * The real corpus at the time these floors were set: 2,799 reasoning streams
 * (19.2M characters) recovered from live session stores, containing both genuine
 * loops and ordinary work. Under the defaults below, 7 fired and every one of
 * them was a genuine loop; the two false positives that motivated the earlier
 * revision (`Unreleased`, `pruneIfNeeded`) were both inert, where the defaults
 * before it fired 180 times. The corpus has since grown to 3,862 streams, on
 * which the same defaults fire 4 times, all genuine.
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

/**
 * A line that is code, markup or a unified-diff row rather than prose.
 *
 * Such a line may not BE the repeated line for {@link lineRepeat}, though it
 * still counts toward that rule's denominator. The reason is the interaction
 * with {@link STRIP}: normalization removes exactly the characters that
 * distinguish one code line from another, so distinct source lines collide into
 * one string.
 *
 * The false positive this fixes, from a real session, was five lines in a single
 * 801-character reasoning burst:
 *
 *     if (e.isKeyboardEvent()) {          (quoted three times)
 *     -                if (e.isKeyboardEvent()) {   (the diff's removed line)
 *     +                if (e.isKeyboardEvent()) {   (the diff's added line)
 *
 * `[\s\p{P}\p{S}]` erases the indentation, the diff markers and the punctuation,
 * so all five normalize to `ifeisKeyboardEvent` and the model reads as repeating
 * one line five times — `count=5 · share=22.6%`, over both floors. The model was
 * not looping; it was reasoning about a code change, which is what it is for.
 *
 * The marker set is deliberately narrow. Braces, markup tags, diff rows, a
 * trailing semicolon and a `something.method(` call are all absent from ordinary
 * prose, so prose that merely contains parentheses — or a bracket, or a `<`
 * used as a comparison — stays eligible. Wider sets (any bracket or operator)
 * also suppress "The config (see above) is wrong.", which would blind the rule
 * to genuine prose tics.
 *
 * The last two markers came from a second real fire, this time in code with no
 * braces at all: one Java statement, quoted four times while the model was
 * working out how to add a planet,
 *
 *     StarSystemAPI sys = (StarSystemAPI)Global.getSector().getPlayerFleet().getContainingLocation();
 *
 * normalized to 79 characters and reached `count=4 · share=10.2%` — just past
 * the share floor, on four genuinely different occurrences. Braces never appear
 * in such a line, and the diff markers never do either, so the original set
 * could not see it. A trailing `;` and a dotted call chain are what actually
 * identify it. Prose does not end lines with semicolons, and "e.g (see" is not a
 * dotted call.
 *
 * Exported so the tests can assert prose eligibility against this set rather
 * than against a hand-copied regex that silently drifts from it.
 */
export const CODE_LINE = /[{}]|<\/?[A-Za-z!/]|^[ \t]*[-+]{1,3}[ \t]|;\s*$|[A-Za-z_$][\w$]*\.[\w$]+\(/;

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
  /**
   * Consecutive identical units that count as a loop.
   *
   * A unit that is itself a repetition — `xxxxxxxx`, `abababab` — is rejected
   * before this floor is consulted, so a typed-out literal never fires no matter
   * how many times it repeats. See {@link isRepeatedUnit}.
   */
  minUnits: 4,
  /** Shortest block considered by the block-repeat rule (normalized chars). */
  blockMin: 100,
  /**
   * Length of the equal-stride chain of the same block that counts as a loop.
   *
   * 4, not 3: at 3 this rule fired on healthy reasoning that quoted long text
   * once — a hex dump, a list of plugin names, a restatement of the system
   * prompt. Measured over 2,799 real reasoning streams, 4 left 3 firings and all
   * 3 were genuine loops. A share floor buys nothing here (3 firings at every
   * floor from 0% to 25%), so none is applied: it would be complexity with no
   * measurement behind it.
   *
   * 4 is also why a lone pair cannot pass: {@link strideChain} returns 2 for two
   * occurrences, since one gap has nothing to disagree with.
   */
  blockCount: 4,
  /** Shortest line considered by the line-repeat rule (normalized chars). */
  lineMin: 10,
  /**
   * Occurrences of the same line that count as a loop.
   *
   * 3, not 2. At 2 this was the noisiest rule in the plugin: 178 firings over
   * the same 2,799 streams, nearly all of them an identifier or a heading that
   * happened to land on two lines while the model was writing code. Raising the
   * count alone is not enough — a healthy `Let me write.` tic reaches 17 — so it
   * is paired with {@link DEFAULTS.lineShare}, which is what actually separates
   * the two populations.
   */
  lineCount: 3,
  /**
   * Fraction of the window the repeated line must occupy to count as a loop.
   *
   * The separating measurement. Over the same 2,799 streams the highest share
   * any healthy stream reaches is 6.1% (that same 17-times tic), while the
   * weakest genuine loop reaches 10.2%. Nothing else separates them: at
   * `lineCount: 2` the counts overlap outright, and the density of the repeats
   * is a dead end (a real loop's tightest pair spans 12 characters, a healthy
   * struct-field list spans 14).
   *
   * 10% is the midpoint of the gap. 8% admits two known false positives; 12%
   * drops a genuine loop, so the usable band is narrow and this is its middle.
   *
   * A long line can clear the floor on two occurrences alone, which is why the
   * count floor cannot go back to 2: the worst false positive found was a single
   * 41-character identifier repeated twice in a 2,159-character stream, worth
   * 19.5% on its own.
   */
  lineShare: 0.1,
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
  if (units === 0 || isRepeatedUnit(tail.slice(-period))) return { units: 0, period: 0 };
  return { units, period };
}

/**
 * Whether `unit` is itself a shorter string repeated a whole number of times.
 *
 * Such a unit is a pattern being typed out character by character, not a
 * structure that recurs, and the two are indistinguishable to the run counter.
 * A real fire from a live session is the clean example: the model wanted a 6x6
 * tile and wrote the literal `"xxxxxxxx...."` — thirty-six `x`, which normalize
 * to a period-8 unit of `xxxxxxxx` repeated five times. It was producing exactly
 * the string it intended to produce.
 *
 * Measured before adopting it: every genuine `periodic-run` unit in both fixture
 * sets and in the real 3,862-stream corpus is primitive (0 of 11 degenerate
 * blobs, 0 of 3 corpus fires), so rejecting repeated units costs nothing.
 */
function isRepeatedUnit(unit) {
  for (let p = 1; p <= unit.length / 2; p += 1) {
    if (unit.length % p !== 0) continue;
    if (unit === unit.slice(0, p).repeat(unit.length / p)) return true;
  }
  return false;
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
 * Positions of `unit` inside `norm`, ascending.
 * @param norm - normalized text.
 * @param unit - the block to locate.
 * @returns every start offset, possibly empty.
 */
function positionsOf(norm, unit) {
  const out = [];
  if (unit.length === 0) return out;
  for (let at = norm.indexOf(unit); at !== -1; at = norm.indexOf(unit, at + 1)) out.push(at);
  return out;
}

/**
 * Longest run of `positions` whose consecutive gaps are all the same.
 *
 * This is what separates a repeated block from a shared prefix. A real loop
 * emits the same block again and again, so the occurrences sit at a constant
 * period; four different commands that happen to start with the same 100
 * normalized characters do not. Returns 1 for a single position and 2 for a
 * lone pair — a pair has no third gap to disagree with, so it cannot be told
 * apart from a chain, which is why `blockCount: 4` is still required.
 * @param positions - ascending start offsets.
 * @returns the longest equal-gap run length.
 */
function strideChain(positions) {
  if (positions.length < 2) return positions.length;
  let best = 2;
  let run = 2;
  let stride = positions[1] - positions[0];
  for (let i = 2; i < positions.length; i += 1) {
    const gap = positions[i] - positions[i - 1];
    if (gap === stride) run += 1;
    else {
      stride = gap;
      run = 2;
    }
    if (run > best) best = run;
  }
  return best;
}

/**
 * Most-repeated `minBlock`-character block inside `text`.
 *
 * Normalizes internally: this rule is defined on the noise-free projection of
 * the text, so cross-line repeats ("the same sentence, reformatted") count.
 *
 * Scans the whole window and reports the worst block found. It used to return
 * the first block to reach `minCount`, which made the reported `count` always
 * equal to the threshold — a journal field that looked like a measurement but
 * was really a constant.
 *
 * Deliberately has no share floor to pair with, unlike {@link lineRepeat}: the
 * count already separates cleanly here (4 leaves 3 firings over the real
 * streams, all genuine), and adding one measured no difference at any floor from
 * 0% to 25%.
 *
 * `count` is the length of the longest EQUAL-STRIDE chain of occurrences, not
 * the raw number of occurrences. Counting occurrences alone is a co-occurrence
 * test: any four texts that share a 100-character prefix score 4 whether or not
 * anything repeated. Three fires from one live session were exactly that — four
 * different `runcode` commands (`add planet`, `add asteroid belt`, `add nebula`,
 * `add ring`) sharing the boilerplate that reads the current star system, at
 * gaps of 1130/359/742, 396/666/467 and 651/491/1436. A genuine loop repeats at
 * a constant period. The raw count is still reported as `rawCount` so a fire
 * stays reviewable.
 * @param text - raw rolling buffer.
 * @param minBlock - block length in normalized characters.
 * @param minCount - occurrences that count as a loop.
 * @returns `{ count, blockLen, block, rawCount }`; `count` is 0 when nothing
 *   repeats.
 */
export function blockRepeat(text, minBlock, minCount) {
  const empty = { count: 0, blockLen: 0, block: "", rawCount: 0 };
  if (!Number.isSafeInteger(minBlock) || minBlock < 2) return empty;
  if (!Number.isSafeInteger(minCount) || minCount < 2) return empty;
  const norm = normalize(text);
  if (norm.length < minBlock * minCount) return { count: 0, blockLen: minBlock, block: "", rawCount: 0 };
  const seen = new Map();
  let best = { count: 0, block: "" };
  for (let at = 0; at + minBlock <= norm.length; at += 1) {
    const key = norm.slice(at, at + minBlock);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > best.count) best = { count, block: key };
  }
  if (best.count === 0) return { count: 0, blockLen: minBlock, block: "", rawCount: 0 };
  const chain = strideChain(positionsOf(norm, best.block));
  return { count: chain, blockLen: minBlock, block: best.block, rawCount: best.count };
}

/**
 * Most-repeated line inside `text`, measured line by line.
 *
 * Splits on newlines FIRST and normalizes each line separately — see the module
 * header for why reusing the block-oriented buffer here is a bug, not a
 * shortcut.
 *
 * Scans every line and reports the worst one. Like {@link blockRepeat} this used
 * to stop at the first line reaching `minCount`, so its `count` was always the
 * threshold rather than the real repetition count.
 * @param text - raw rolling buffer.
 * @param minLine - line length in normalized characters.
 * @param minCount - occurrences that count as a loop.
 * @returns `{ count, lineLen, line, share }`; `count` is 0 when nothing
 *   qualifies. `share` is the repeated lines' fraction of the normalized
 *   window — the measurement that separates a real loop from a verbal tic.
 */
export function lineRepeat(text, minLine, minCount) {
  const empty = { count: 0, lineLen: 0, line: "", share: 0 };
  if (typeof text !== "string" || text.length === 0) return empty;
  if (!Number.isSafeInteger(minLine) || minLine < 2) return empty;
  if (!Number.isSafeInteger(minCount) || minCount < 2) return empty;
  const seen = new Map();
  let normLen = 0;
  let best = { count: 0, line: "" };
  for (const raw of text.split(/\n+/)) {
    const line = normalize(raw);
    if (line.length < minLine) continue;
    // Code is measured but never reported: see {@link CODE_LINE}. Dropping it
    // from the denominator too would inflate the share of a code-heavy stream,
    // which is the same failure in the opposite direction.
    normLen += line.length;
    if (CODE_LINE.test(raw)) continue;
    const count = (seen.get(line) ?? 0) + 1;
    seen.set(line, count);
    // Ties go to the longer line: with equal counts the longer one covers more
    // of the window, which is the more alarming shape and the better preview.
    if (count > best.count || (count === best.count && line.length > best.line.length)) best = { count, line };
  }
  if (best.count === 0 || normLen === 0) return empty;
  return { count: best.count, lineLen: best.line.length, line: best.line, share: (best.count * best.line.length) / normLen };
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
      rawCount: block.rawCount,
      preview: block.block,
    };
  }
  const line = lineRepeat(buf, config.lineMin, config.lineCount);
  // Both conditions, at the same judge point. Either one alone is useless here:
  // counts overlap between healthy and degenerate streams, and a single long
  // identifier repeated twice can clear any share floor on its own.
  if (line.count >= config.lineCount && line.share >= config.lineShare) {
    return {
      rule: "line-repeat",
      atChars: total,
      count: line.count,
      lineLen: line.lineLen,
      share: Number(line.share.toFixed(4)),
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
