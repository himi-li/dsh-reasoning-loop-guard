/**
 * Offline validation of dsh-reasoning-loop-guard against real session fixtures.
 *
 * Positives: 11 assistant messages from the failing session that streamed
 * reasoning only and were cut short by the user (the loop itself).
 * Negatives: all 166 healthy assistant messages from the same session.
 *
 * Run: node test/test-guard.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULTS,
  blockRepeat,
  createDetector,
  fillerRun,
  judge,
  kgramCount,
  lineRepeat,
  normalize,
  periodicRun,
} from "../lib/detector.js";
import { guardStream, failureMessage, thresholdSnapshot, FAILURE_CODE } from "../lib/guard.js";

const DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
const positives = JSON.parse(readFileSync(`${DIR}/degenerate.json`, "utf8"));
const negatives = JSON.parse(readFileSync(`${DIR}/healthy.json`, "utf8"));

let failures = 0;
const check = (ok, label) => {
  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
};

/** Feed text through a detector in `chunk`-sized reasoning-delta pieces. */
function runDetector(text, chunk, overrides = {}) {
  const detector = createDetector(overrides);
  for (let at = 0; at < text.length; at += chunk) {
    const verdict = detector.feed(text.slice(at, at + chunk));
    if (verdict !== null) return verdict;
  }
  return null;
}

console.log(`fixtures: ${positives.length} positives, ${negatives.length} negatives`);
console.log(`defaults: ${JSON.stringify(DEFAULTS)}\n`);

console.log("--- 1. detection over all stream chunk sizes ---");
for (const chunk of [1, 8, 40, 200, 1000, 4000]) {
  let hit = 0;
  const at = [];
  for (const item of positives) {
    const verdict = runDetector(item.text, chunk);
    if (verdict !== null) {
      hit += 1;
      at.push(verdict.atChars);
    }
  }
  let falsePositives = 0;
  for (const item of negatives) if (runDetector(item.text, chunk) !== null) falsePositives += 1;
  at.sort((a, b) => a - b);
  check(
    hit === positives.length && falsePositives === 0,
    `chunk=${String(chunk).padStart(4)}  positives ${hit}/${positives.length}  falsePositives ${falsePositives}/${negatives.length}  fireAt ${at[0]}..${at[at.length - 1]}`,
  );
}

console.log("\n--- 2. separation margin (peak counts, firing disabled) ---");
// Both thresholds are lifted so `feed()` never latches and the buffers keep
// updating for the whole blob — otherwise the measurement freezes at whichever
// rule happened to fire first.
//
// The peaks are measured on the SAME inputs `judge()` uses: `periodicRun` and
// `kgramCount` see normalized text, while the block and line rules normalize
// internally. Measuring the raw buffers here would report margins the detector
// never actually relies on.
const NO_FIRE = { kgramThreshold: Number.MAX_SAFE_INTEGER, minUnits: Number.MAX_SAFE_INTEGER };
const peaks = (text, chunk) => {
  const detector = createDetector(NO_FIRE);
  let kgram = 0;
  let units = 0;
  let block = 0;
  let line = 0;
  for (let at = 0; at < text.length; at += chunk) {
    detector.feed(text.slice(at, at + chunk));
    kgram = Math.max(kgram, kgramCount(normalize(detector.buffer), DEFAULTS.kgram));
    units = Math.max(units, periodicRun(normalize(detector.periodBuffer), DEFAULTS.minPeriod, DEFAULTS.maxPeriod).units);
    block = Math.max(block, blockRepeat(detector.buffer, DEFAULTS.blockMin, 2).count);
    line = Math.max(line, lineRepeat(detector.buffer, DEFAULTS.lineMin, 2).count);
  }
  return { kgram, units, block, line };
};
const posPeaks = positives.map((p) => peaks(p.text, 40));
const negPeaks = negatives.map((n) => peaks(n.text, 40));
const asc = (values) => [...values].sort((a, b) => a - b);
const posKgram = asc(posPeaks.map((p) => p.kgram));
const negKgram = asc(negPeaks.map((p) => p.kgram));
const posUnits = asc(posPeaks.map((p) => p.units));
const negUnits = asc(negPeaks.map((p) => p.units));
const posBlock = asc(posPeaks.map((p) => p.block));
const negBlock = asc(negPeaks.map((p) => p.block));
const posLine = asc(posPeaks.map((p) => p.line));
const negLine = asc(negPeaks.map((p) => p.line));
console.log(`kgram    positives ${posKgram[0]}..${posKgram.at(-1)}   negatives ${negKgram[0]}..${negKgram.at(-1)}   threshold ${DEFAULTS.kgramThreshold}`);
console.log(`periodic positives ${posUnits[0]}..${posUnits.at(-1)}   negatives ${negUnits[0]}..${negUnits.at(-1)}   threshold ${DEFAULTS.minUnits}`);
console.log(`block    positives ${posBlock[0]}..${posBlock.at(-1)}   negatives ${negBlock[0]}..${negBlock.at(-1)}   threshold ${DEFAULTS.blockCount}`);
console.log(`line     positives ${posLine[0]}..${posLine.at(-1)}   negatives ${negLine[0]}..${negLine.at(-1)}   threshold ${DEFAULTS.lineCount}`);

// What must hold for every healthy blob: NO rule reaches its own threshold. That
// is the safety property, and it is asserted per rule rather than in aggregate so
// a single over-eager rule cannot hide behind the others.
check(negKgram.at(-1) < DEFAULTS.kgramThreshold, "k-gram threshold sits above every healthy blob");
check(negUnits.at(-1) < DEFAULTS.minUnits, "periodic threshold sits above every healthy blob");
check(negBlock.at(-1) < DEFAULTS.blockCount, "block threshold sits above every healthy blob");
check(negLine.at(-1) < DEFAULTS.lineCount, "line threshold sits above every healthy blob");

// The mirror property for degenerate blobs is *disjunctive*: four rules share the
// work, so a positive need not trip any particular one — pos#3 onward are caught
// by `line-repeat` alone. What must hold is that some rule separates it, so the
// check is on the best ratio across rules, not on each rule in isolation.
//
// Every rule fires at `>=` its threshold, so the separating ratio is exactly 1.0:
// a positive must REACH one threshold, a healthy blob must reach none.
const ratio = (peak, threshold) => peak / threshold;
const bestRatio = (p) => Math.max(
  ratio(p.kgram, DEFAULTS.kgramThreshold),
  ratio(p.units, DEFAULTS.minUnits),
  ratio(p.block, DEFAULTS.blockCount),
  ratio(p.line, DEFAULTS.lineCount),
);
const posRatios = asc(posPeaks.map(bestRatio));
const negRatios = asc(negPeaks.map(bestRatio));
console.log(`best ratio per blob   positives ${posRatios[0].toFixed(2)}..${posRatios.at(-1).toFixed(2)}   negatives ${negRatios[0].toFixed(2)}..${negRatios.at(-1).toFixed(2)}   separation at 1.00`);
check(posRatios[0] >= 1, "every degenerate blob reaches at least one rule threshold");
check(negRatios.at(-1) < 1, "no healthy blob reaches any rule threshold");

console.log("\n--- 3b. short decoration is never a loop ---");
// Two real false positives are covered here. The first: the original detector
// ran `periodicRun` on the raw buffer, so 32 spaces were "8 characters repeated
// 4 times" and a genuine fire was journaled with an eight-space preview. The
// second: the strip list omitted `_`, so eight underscores from a model drawing
// a horizontal rule survived normalization as eight identical characters and
// fired `periodic-run` at `period=8 · units=6`.
//
// Everything here is either shorter than `fillerRun` or is not at the tail of
// the buffer, which is the whole point: formatting is decoration, and decoration
// only becomes a loop when the model does nothing else for a long stretch.
// The `prose` prefix matters — a rule is not consulted until the stream passes
// `minChars`, so a bare "________" would pass by never being judged at all.
const prose = (chars) => {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
  let out = "";
  let i = 0;
  while (out.length < chars) {
    out += `${words[i % words.length]}${i} carries value ${(i * 7919) % 1009} onward. `;
    i += 1;
  }
  return out;
};
check(runDetector(prose(1000), 40) === null, "plain prose is not a loop (the baseline these cases build on)");
for (const [label, text] of [
  ["32 spaces", prose(1000) + " ".repeat(32)],
  ["8 underscores (real false positive)", prose(1000) + "________"],
  ["80 underscores", prose(1000) + "_".repeat(80)],
  ["a short horizontal rule", prose(1000) + "---\n***\n___\n".repeat(20)],
  ["box drawing", prose(1000) + "─".repeat(120)],
  ["markdown table row", prose(1000) + "|" + "------|".repeat(20)],
  ["ascii box, 150 wide", prose(1000) + "+" + "-".repeat(148) + "+"],
  ["setext underline", prose(1000) + "=".repeat(60)],
  ["a finished diagram followed by prose", prose(1000) + "+" + "-".repeat(148) + "+\nthe box above shows the data flow\n"],
  ["a table row followed by prose", prose(1000) + "|" + "------|".repeat(30) + "\nand here is the explanation of that table\n"],
]) {
  check(runDetector(text, 40) === null, `${label} is not a loop`);
}
check(normalize("  a b\nc  ") === "abc", "normalize strips whitespace and keeps the text");
check(normalize("   \n\t ") === "", "normalize reduces blank input to nothing");
check(normalize(undefined) === "", "normalize tolerates a non-string");
check(normalize("________") === "", "normalize strips underscores (the real false positive)");
check(normalize("a_b") === "ab", "normalize strips a mid-word underscore");
check(normalize("café—naïve") === "cafénaïve", "normalize keeps accented letters, drops the dash");
check(normalize("$100 x^2 a|b") === "100x2ab", "normalize strips symbols and whitespace, keeps letters and digits");

// The wide strip class is a strict superset of the hand-written list it replaced,
// so it can only ever REMOVE more. On real degenerate text that must be a no-op:
// if the real loops were caught by their decoration rather than their words, this
// fix would have traded false positives for false negatives. It is not — for all
// 11 positives the old and new classes produce byte-identical output, and every
// one still fires (2 by `periodic-run`, 9 by `line-repeat`).
const OLD_STRIP = /[\s，。、；：！？,.?!;:()[\]{}<>"'`~\-—…]/gu;
const wideningRemovedSomething = positives.filter((p) => p.text.replace(OLD_STRIP, "").length !== normalize(p.text).length);
check(wideningRemovedSomething.length === 0, "the wider strip class removes nothing from any real degenerate blob");
for (const [index, sample] of positives.entries()) {
  const verdict = runDetector(sample.text, 40);
  check(verdict !== null, `real degenerate blob #${index} still fires (got ${String(verdict?.rule)})`);
}

console.log("\n--- 3b-2. a decoration stall still fires, but only when it is long ---");
// The counting rules cannot see decoration at all (they strip it first), so a
// model that fills the stream with `_` or spaces would otherwise pass clean
// forever. `filler-run` is the last-resort rule that catches exactly that, and
// it must stay far above legitimate formatting: measured shapes reach 151
// characters (a 150-wide ASCII box) while the default bar is 400.
for (const [label, text] of [
  ["4000 underscores", "_".repeat(4000)],
  ["4000 spaces", " ".repeat(4000)],
  ["4000 newlines", "\n".repeat(4000)],
  ["mixed blank", " \n\t \r\n ".repeat(600)],
  ["punctuation only", "，。；：、！？".repeat(400)],
  ["4000 box-drawing chars", "─".repeat(4000)],
  ["mixed decoration stall", "─ = _ - ".repeat(600)],
]) {
  const verdict = runDetector(text, 40);
  check(verdict?.rule === "filler-run", `${label} fires filler-run (got ${String(verdict?.rule)})`);
}
// Sanity: the threshold itself is what makes the difference. The input must clear
// `minChars` before any rule runs at all, so the lenient case uses a stall long
// enough to be judged (4000) while the strict case can be shorter.
check(runDetector("_".repeat(4000), 40, { fillerRun: 5000 }) === null, "a higher fillerRun bar lets the stall through");
check(runDetector("_".repeat(4000), 40, { fillerRun: 100 })?.rule === "filler-run", "a lower fillerRun bar fires sooner");
check(fillerRun("________", 400).run === 0, "fillerRun ignores a short decoration tail");
check(fillerRun("_".repeat(500), 400).run === 500, "fillerRun counts a long decoration tail");
check(fillerRun("_".repeat(500), 400).char === "_", "fillerRun reports the run character");
check(fillerRun("text with no decoration", 400).run === 0, "fillerRun ignores a plain-text tail");

console.log("\n--- 3c. guardStream protocol conformance ---");
async function* fromText(text, size, type = "reasoning-delta") {
  for (let at = 0; at < text.length; at += size) yield { type, index: 0, text: text.slice(at, at + size) };
}
const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

const degenerate = positives[0];
const guarded = await collect(guardStream(fromText(degenerate.text, 40), { sessionId: "test" }, DEFAULTS));
const finishes = guarded.filter((chunk) => chunk.type === "finish");
check(finishes.length === 1, `exactly one finish chunk (got ${finishes.length})`);
check(guarded.at(-1).type === "finish", "finish is the last chunk");
check(finishes[0]?.reason.kind === "error", "loop reports reason.kind === error");
check(finishes[0]?.reason.failure.code === FAILURE_CODE, `failure code is ${FAILURE_CODE}`);
check(typeof finishes[0]?.reason.failure.message === "string" && finishes[0].reason.failure.message.length > 0, "failure carries a message");
check(guarded.length < degenerate.text.length / 40, `stopped early: ${guarded.length} chunks vs ${Math.ceil(degenerate.text.length / 40)} upstream`);

const aborted = await collect(guardStream(fromText(degenerate.text, 40), { sessionId: "test", signal: { aborted: true } }, DEFAULTS));
check(aborted.at(-1)?.reason.kind === "aborted", "an already-aborted signal reports reason.kind === aborted");

console.log("\n--- 3b. the firing report ---");
{
  const fires = [];
  await collect(
    guardStream(
      fromText(degenerate.text, 40),
      { sessionId: "sess-9", provider: "workbuddy", model: "deepseek-v4.1-flash" },
      DEFAULTS,
      undefined,
      (verdict, firedOptions, firedConfig, facts) => fires.push({ verdict, firedOptions, firedConfig, facts }),
      { attempt: { attemptId: "attempt-3", turn: 4, step: 7 }, cwd: "C:\\work" },
    ),
  );
  check(fires.length === 1, `the firing is reported exactly once (got ${fires.length})`);
  const { verdict, firedOptions, firedConfig, facts } = fires[0] ?? {};
  check(verdict?.rule === "periodic-run", "the report carries the verdict");
  check(firedOptions?.sessionId === "sess-9", "the report carries the request options");
  check(firedConfig?.minChars === DEFAULTS.minChars, "the report carries the config in force");
  check(facts?.attempt?.turn === 4 && facts.attempt.step === 7, "the report carries the probed attempt");
  check(facts?.cwd === "C:\\work", "the report carries the probed working directory");
  check(Number.isFinite(facts?.elapsedMs) && facts.elapsedMs >= 0, "the report carries the loop duration");
  check(Number.isFinite(facts?.ttftMs) && facts.ttftMs >= 0, "the report carries the time to first token");
  check(
    Number.isFinite(facts?.fromStartMs) && facts.fromStartMs >= facts.elapsedMs,
    "the total stream lifetime is at least the loop duration",
  );
  check(facts?.reasoningChars === verdict.atChars, "the measured character count matches the verdict");
  check(facts?.aborted === false, "a stream nobody aborted is reported as such");
  check(typeof facts?.rawTail === "string" && facts.rawTail.length > 0, "the raw tail is captured for the journal");
}
{
  // The snapshot exists so a fire can be explained months later. That only
  // holds if it covers every knob that can change a verdict: a threshold added
  // to DEFAULTS but forgotten here would make old records unexplainable, which
  // is exactly how `fillerRun` went missing once.
  const snapshot = thresholdSnapshot(DEFAULTS);
  const missing = Object.keys(DEFAULTS).filter((key) => !(key in snapshot));
  check(
    missing.length === 0,
    `the snapshot covers every detection threshold (missing: ${missing.join(", ") || "none"})`,
  );
  check(snapshot.fillerRun === DEFAULTS.fillerRun, "the snapshot carries the filler-run bar");
  check(snapshot.minChars === DEFAULTS.minChars, "the snapshot carries the minimum length");
}
{
  // The abort flag must describe *this* stream, not the platform default.
  const fires = [];
  await collect(
    guardStream(fromText(degenerate.text, 40), { sessionId: "test", signal: { aborted: true } }, DEFAULTS, undefined, (_v, _o, _c, facts) => fires.push(facts)),
  );
  check(fires[0]?.aborted === true, "an aborted stream is reported as aborted");
}
{
  // A throwing report hook must not break the stream it describes.
  const guarded = await collect(
    guardStream(fromText(degenerate.text, 40), { sessionId: "test" }, DEFAULTS, undefined, () => {
      throw new Error("telemetry exploded");
    }),
  );
  check(guarded.at(-1)?.type === "finish", "a throwing report hook still yields the terminal chunk");
  check(guarded.at(-1)?.reason.failure.code === FAILURE_CODE, "and the failure code survives it");
}
{
  // Without a probe the report still arrives, just with less context.
  const fires = [];
  await collect(
    guardStream(fromText(degenerate.text, 40), { sessionId: "test" }, DEFAULTS, undefined, (_v, _o, _c, facts) => fires.push(facts)),
  );
  check(fires[0]?.attempt === null && fires[0]?.cwd === null, "a host without a probe reports null context, not undefined");
}
{
  // The probe must be consulted at FIRE time, not when the stream is wrapped:
  // the agent loop announces the attempt identity only after it has called
  // `llm.stream()`, so a probe read eagerly would report the previous attempt.
  let calls = 0;
  const fires = [];
  await collect(
    guardStream(fromText(degenerate.text, 40), { sessionId: "test" }, DEFAULTS, undefined, (_v, _o, _c, facts) => fires.push(facts), () => {
      calls += 1;
      return { attempt: { attemptId: "attempt-live", turn: 9, step: 3 }, cwd: "C:\\late" };
    }),
  );
  check(calls === 1, `the probe is called exactly once (got ${calls})`);
  check(fires[0]?.attempt?.attemptId === "attempt-live", "the probe's late answer is the one recorded");
  check(fires[0]?.cwd === "C:\\late", "the probe's working directory is recorded");
}
{
  // A throwing probe degrades the record, it does not lose it.
  const fires = [];
  await collect(
    guardStream(fromText(degenerate.text, 40), { sessionId: "test" }, DEFAULTS, undefined, (_v, _o, _c, facts) => fires.push(facts), () => {
      throw new Error("no session service");
    }),
  );
  check(fires.length === 1, "a throwing probe still reports the firing");
  check(fires[0]?.attempt === null && fires[0]?.cwd === null, "a throwing probe degrades to null context");
}

const healthy = negatives.find((item) => item.text.length > 8000) ?? negatives[0];
const passthrough = await collect(guardStream(fromText(healthy.text, 40), { sessionId: "test" }, DEFAULTS));
check(passthrough.every((chunk) => chunk.type === "reasoning-delta"), "healthy stream passes through untouched");
check(passthrough.length === Math.ceil(healthy.text.length / 40), `healthy stream is complete (${passthrough.length} chunks)`);

const textOnly = await collect(guardStream(fromText(degenerate.text, 40, "text-delta"), { sessionId: "test" }, DEFAULTS));
check(textOnly.every((chunk) => chunk.type === "text-delta"), "text-delta output is never judged");

console.log("\n--- 3d. line-repeat needs a count AND a share ---");
// The two false positives that motivated this criterion, both from the user's
// own journal. Neither is exotic: they are what reasoning looks like while
// writing a changelog and while editing a function.
//
// These go through `judge()` with the other rules disabled rather than through
// `feed()`, because the question here is what THIS rule decides — a blob that
// trips `periodic-run` first would otherwise pass the "does not fire" cases for
// the wrong reason.
const ONLY_LINE = { ...DEFAULTS, minUnits: Number.MAX_SAFE_INTEGER, kgramThreshold: Number.MAX_SAFE_INTEGER, blockCount: Number.MAX_SAFE_INTEGER };
const judgeLine = (text) => judge(text, text, text.length, ONLY_LINE);

{
  // The real false positive: a changelog being drafted, so the same heading
  // lands on two lines. 10 normalized characters, twice, in a lot of prose.
  const changelog = `${"Rewrote the detector to scan the whole window instead of stopping at the first hit. ".repeat(28)}
## Unreleased
Added a share floor to the line rule so a repeated heading no longer counts.
## Unreleased
Bumped the block rule while I was in there, and left the rest alone.`;
  const verdict = judgeLine(changelog);
  check(verdict === null, `a twice-written changelog heading is not a loop (got ${verdict?.rule ?? "null"})`);

  // The other real false positive: an identifier on two lines while editing.
  const editing = `${"The cache lookup walks the map and returns undefined when the key is absent. ".repeat(30)}
if (pruneIfNeeded(now)) {
  await this.flush();
}
const stale = pruneIfNeeded(now) ? this.entries : [];`;
  check(judgeLine(editing) === null, "an identifier on two lines while editing is not a loop");

  // The worst false positive in the corpus, and the reason `lineCount` cannot
  // drop back to 2: a single 41-character identifier, repeated twice, in a short
  // stream. Two occurrences are enough for it to reach 19.5% of the window on
  // length alone, so a share floor by itself would still admit it.
  //
  // The filler matters twice over. It has to be genuinely varied (an earlier
  // version repeated one comment line and was caught by `line-repeat` on THAT
  // line — a correct fire on a badly built fixture), and it has to be CODE:
  // normalization strips punctuation, so 2,159 characters of real code reduce to
  // a few hundred normalized ones, which is exactly why the identifier's share
  // came out so high. Prose filler would dilute it back below the floor and the
  // case would prove nothing.
  const longName = "export function getFilePathByModeInCafs(cafsDir, integrity) {";
  const codeFiller = Array.from({ length: 20 }, (_unused, i) => `if (cache[${i}] === undefined) { return { id: ${i}, path: join(base, "x") }; }`).join("\n");
  const twice = `${codeFiller}
${longName}
  return join(cafsDir, integrity ? "integrity" : "mode");
${longName}
  throw new Error("unreachable");`;
  const twiceLine = lineRepeat(twice, DEFAULTS.lineMin, 2);
  check(twiceLine.count === 2, `the long identifier really does occur twice (got ${twiceLine.count})`);
  check(twiceLine.share > DEFAULTS.lineShare, `and twice is enough to clear the share floor on its own (${(twiceLine.share * 100).toFixed(1)}%)`);
  const longVerdict = judgeLine(twice);
  check(longVerdict === null, `one long identifier twice is not a loop (got ${longVerdict?.rule ?? "null"})`);

  // The genuine loop the corpus is full of: a short tic, repeated far more than
  // the floor, filling the window. This is the shape that must still fire.
  const loop = "Let me write.\nOK.\n".repeat(12);
  const loopVerdict = judgeLine(loop);
  check(loopVerdict?.rule === "line-repeat", `a real tic loop still fires (got ${loopVerdict?.rule ?? "null"})`);
  check(loopVerdict?.count >= DEFAULTS.lineCount, `the loop reports its real repeat count (${loopVerdict?.count})`);
  check(loopVerdict?.share >= DEFAULTS.lineShare, `the loop reports the share it fired on (${loopVerdict?.share})`);

  // Count without share: three occurrences of a short line buried in a full
  // window. The count floor alone would fire here.
  const sparse = `${"unrelated prose about the task at hand, kept deliberately varied. ".repeat(40)}
const x = 1;
more prose in between so the repeats are far apart from one another.
const x = 1;
the third occurrence, still nowhere near a tenth of the buffer.
const x = 1;
tail prose.`;
  const sparseVerdict = judgeLine(sparse);
  check(sparseVerdict === null, `three sparse repeats are not a loop (got ${sparseVerdict?.rule ?? "null"})`);

  // The rule reports the worst line, not the first one to reach the threshold.
  const worst = `aaaaaaaaaa\n${"bbbbbbbbbb\n".repeat(7)}`;
  const repeat = lineRepeat(worst, 10, 2);
  check(repeat.count === 7, `lineRepeat reports the real maximum, not the threshold (got ${repeat.count})`);
  check(repeat.line === "b".repeat(10), "lineRepeat reports the worst line itself");
  check(repeat.share > 0 && repeat.share <= 1, `lineRepeat reports a share in (0, 1] (got ${repeat.share})`);
  check(lineRepeat("short\ntext", 10, 2).count === 0, "lineRepeat ignores lines under minLine");
  check(lineRepeat("", 10, 2).count === 0, "lineRepeat tolerates an empty buffer");

  // The same fix on the block rule, which shares the defect. The three blocks
  // must be internally varied: a run of one repeated character is counted at
  // every offset it can be sliced at (300 identical characters hold 201
  // overlapping 100-character blocks), which is correct behaviour but useless as
  // a fixture — it reports hundreds of "occurrences" of a block that appears
  // once.
  // The blocks must be aperiodic. `"abcdefghij"[i % 10]` repeated ten times
  // looks varied but has period 10, so every 100-character slice inside it is
  // the same block and the count inflates for free.
  const mkBlock = (seed) => Array.from({ length: 100 }, (_unused, i) => String.fromCharCode(97 + ((i * 7 + i * i * 3 + seed * 11) % 26))).join("");
  const blockA = mkBlock(1);
  const blockB = mkBlock(2);
  check(blockA !== blockB, "the two block fixtures differ");
  // A single block reports 0, not 1: the scan bails out when the buffer is too
  // short to hold `minCount` occurrences at all, so "one occurrence" is reported
  // as "cannot be a repeat" rather than counted and then rejected.
  check(blockRepeat(blockA, 100, 2).count === 0, "a buffer too short for two blocks reports no repeat");
  const block = blockRepeat(`${blockA}${blockB}${blockA}${blockB}${blockA}`, 100, 2);
  check(block.count === 3, `blockRepeat reports the real maximum, not the threshold (got ${block.count})`);
  check(block.block === blockA, "blockRepeat reports the worst block itself");
}

console.log("\n--- 4. message rendering (one line per rule) ---");
for (const verdict of [
  { rule: "periodic-run", atChars: 6400, units: 10, period: 114 },
  { rule: "block-repeat", atChars: 6400, count: 4, blockLen: 120 },
  { rule: "line-repeat", atChars: 6400, count: 3, lineLen: 14, share: 0.117 },
  { rule: "kgram-repeat", atChars: 6400, count: 20 },
]) {
  const line = failureMessage(verdict);
  check(line.includes("重复") && line.includes(String(verdict.atChars)), `message renders for ${verdict.rule}`);
  console.log(line);
}
{
  // A verdict without a share still renders: hand-built or older verdicts must
  // not produce "占窗口 NaN%".
  const line = failureMessage({ rule: "line-repeat", atChars: 100, count: 3, lineLen: 12 });
  check(!line.includes("NaN"), "a verdict with no share renders without NaN");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
