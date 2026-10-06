/**
 * Generate the committed test fixtures.
 *
 * The guard was calibrated on a real DSH session (11 degenerate assistant
 * messages, 166 healthy ones). That session's text is private, so the fixtures
 * committed here are **synthetic**: they reproduce the measured statistical
 * shape of the real data without containing any of it.
 *
 * What is reproduced, and why it matters:
 *
 *  - **Row count and length distribution.** The same 11 / 166 rows, each with
 *    the same character count as its real counterpart, so the detector meets
 *    the same scale (a 244k-character blob exercises the rolling windows
 *    exactly as it did in production).
 *  - **Loop geometry.** Each degenerate row ends in one unbroken run of a
 *    single repeated unit. The unit period p is chosen so both rules see what
 *    they saw in the real data: the k-gram rule counts ~4096/p matches (real:
 *    20..162) and the periodic rule counts ~1200/p units, capped by the
 *    1200-character period buffer (real: 5..50).
 *  - **Healthy text stays healthy.** Prose is drawn from a wide vocabulary, so
 *    no tail k-gram repeats and no unit runs; the real healthy blobs peaked at
 *    5 k-grams and 2 units.
 *
 * Deterministic: a fixed PRNG seed means re-running produces byte-identical
 * files, so any diff in the fixtures is a real change.
 *
 * Run: node tools/make-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT_DIR = fileURLToPath(new URL("../test/fixtures/", import.meta.url));

/** Character counts of the 11 degenerate blobs in the real session. */
const DEGENERATE_LENGTHS = [243997, 280888, 61529, 82532, 16744, 7659, 9165, 6966, 14795, 12598, 9588];

/** Character counts of the 166 healthy blobs in the real session. */
const HEALTHY_LENGTHS = [
  1183, 1658, 1122, 2964, 1182, 865, 1173, 1267, 1139, 960, 886, 3347, 6988, 11205, 6720, 2216, 11236, 4868, 8121,
  3165, 7457, 17400, 13789, 10347, 6516, 8609, 2285, 11162, 9539, 708, 11871, 6875, 27671, 27222, 528, 12238, 18179,
  1469, 4729, 9347, 728, 7673, 4608, 1324, 1057, 3829, 16571, 16402, 15197, 15109, 803, 33487, 3067, 1090, 32322,
  17099, 15312, 720, 12236, 7234, 5104, 1283, 3201, 1533, 502, 1022, 21046, 6824, 3149, 6848, 7782, 1076, 771, 22202,
  16760, 4495, 2705, 896, 22729, 34946, 10783, 515, 836, 18021, 25836, 660, 794, 16486, 1315, 728, 13533, 7343, 6371,
  11157, 6618, 15211, 2222, 6178, 14426, 6670, 740, 18571, 1838, 14623, 15300, 3985, 4524, 2610, 3399, 1025, 822,
  2133, 2419, 5468, 5886, 774, 3222, 927, 1469, 11858, 1862, 2909, 6269, 10837, 11188, 6120, 5862, 1504, 35453, 2061,
  4835, 11125, 1130, 1671, 2169, 1299, 1021, 716, 8207, 3607, 865, 621, 787, 1133, 785, 1129, 17411, 1438, 1918,
  10250, 2349, 1006, 837, 1887, 1896, 5221, 1514, 1117, 1896, 2077, 1586, 2179, 522, 677, 9064, 1044,
];

/**
 * Repeated-unit periods, one per degenerate row. Spread across the range the
 * real session occupied: its k-gram peaks of 20..162 imply periods of roughly
 * 25..205, which in turn yields the observed 5..50 periodic units.
 */
const PERIODS = [25, 32, 40, 48, 56, 64, 80, 96, 112, 144, 204];

/** Short filler phrases the degenerate tail is built from. */
const FILLERS = [
  "Let me write", "Go", "OK", "Now", "Emit", "Writing", "Alright", "Here goes", "Output", "Done thinking",
  "Just write it", "So", "Right", "Yes", "Final answer", "One moment", "Almost", "Ready",
];

/**
 * Vocabulary indexed by word length, 1..15. Prose is assembled word by word and
 * lands on an exact character count by choosing a final word of a precise
 * length, so no padding or trimming is ever needed.
 */
const WORDS_BY_LENGTH = {
  1: ["a", "I"],
  2: ["is", "it", "so", "to", "we", "of", "on", "be", "no"],
  3: ["the", "and", "but", "for", "not", "yet", "run", "map", "log", "two", "one"],
  4: ["this", "that", "when", "then", "from", "with", "code", "file", "test", "data", "loop", "path", "read", "true", "null", "same", "once"],
  5: ["which", "there", "where", "value", "entry", "bytes", "clean", "check", "still", "first", "after", "never", "shard", "queue", "state", "guard", "order", "small"],
  6: ["before", "should", "stream", "buffer", "handle", "socket", "parser", "result", "record", "output", "window", "inside", "either", "length", "change"],
  7: ["because", "through", "without", "already", "between", "another", "message", "session", "profile", "adapter", "timeout", "handler", "channel", "payload", "running", "forward"],
  8: ["registry", "manifest", "callback", "watchdog", "pipeline", "shortcut", "observed", "combined", "resolved", "existing", "followed", "argument", "terminal", "distinct"],
  9: ["workspace", "clipboard", "injection", "waterfall", "invariant", "iteration", "dimension", "threshold", "directory", "reference", "exception", "remaining"],
  10: ["descriptor", "permission", "foreground", "middleware", "connection", "completion", "generation", "resolution", "invocation", "validation", "submission", "collection"],
  11: ["observation", "concurrency", "translation", "declaration", "calibration", "measurement", "combination", "composition"],
  12: ["asynchronous", "interruption", "registration", "cancellation", "verification", "notification"],
  13: ["serialisation", "normalisation", "deterministic", "configuration"],
  14: ["implementation", "reconciliation", "identification", "representation", "classification"],
  15: ["instrumentation", "representations", "standardisation"],
};

const MAX_WORD = 15;
for (let length = 1; length <= MAX_WORD; length += 1) {
  if (!Array.isArray(WORDS_BY_LENGTH[length]) || WORDS_BY_LENGTH[length].length === 0) {
    throw new Error(`vocabulary is missing words of length ${length}`);
  }
}

/** Every word, with its length, for the greedy fill. */
const WORDS = Object.entries(WORDS_BY_LENGTH).flatMap(([length, list]) =>
  list.map((word) => {
    if (word.length !== Number(length)) throw new Error(`"${word}" is not ${length} characters`);
    return word;
  }),
);

/** Deterministic 32-bit PRNG, so fixture output is reproducible. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (list, random) => list[Math.floor(random() * list.length)];

/** True when `unit` is not itself a repetition of a shorter block. */
function isAperiodic(unit, minPeriod) {
  const limit = Math.floor(unit.length / 2);
  for (let q = minPeriod; q <= limit; q += 1) {
    let periodic = true;
    for (let at = q; at < unit.length; at += 1) {
      if (unit[at] !== unit[at % q]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return false;
  }
  return true;
}

/**
 * Build one aperiodic unit of exactly `period` characters, from short filler
 * phrases separated by newlines — the real loop tails were fragmented into very
 * short lines (median 5 characters).
 */
function makeUnit(period, random) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    let text = "";
    while (text.length < period) text += `${pick(FILLERS, random)}\n`;
    const unit = text.slice(0, period);
    if (isAperiodic(unit, 8)) return unit;
  }
  throw new Error(`could not build an aperiodic unit of period ${period}`);
}

/**
 * Prose of exactly `length` characters: words joined by spaces, terminated by a
 * period, with occasional paragraph breaks.
 *
 * Accounting: a word contributes `word.length + 1` (the word plus the space
 * that follows it), and the final period is paid for by the last word's
 * trailing space. So the words must sum to exactly `length`. A paragraph break
 * replaces one of those spaces with two newlines, costing one extra character.
 */
function prose(length, random) {
  const words = [];
  const separators = [];
  let consumed = 0; // sum of word.length + 1
  let extra = 0; // paragraph breaks beyond the base single space

  while (consumed + extra < length) {
    const remaining = length - consumed - extra;
    const paragraph = words.length > 0 && remaining > 60 && random() < 0.05;
    const need = remaining - (paragraph ? 1 : 0) - 1; // exact final word length

    let word;
    if (need >= 1 && need <= MAX_WORD) {
      word = pick(WORDS_BY_LENGTH[need], random);
    } else if (need > MAX_WORD) {
      word = pick(WORDS, random);
    } else {
      // Fewer than two characters left: retract the previous word and retry.
      if (words.length === 0) break;
      const last = words.pop();
      const separator = separators.pop();
      consumed -= last.length + 1;
      if (separator === "\n\n") extra -= 1;
      continue;
    }

    words.push(word);
    separators.push(paragraph ? "\n\n" : " ");
    consumed += word.length + 1;
    if (paragraph) extra += 1;
  }

  return words.map((word, index) => (index === 0 ? word : separators[index] + word)).join("") + ".";
}

/** Build the degenerate rows: healthy reasoning, then one unbroken loop. */
function degenerateRows() {
  const random = mulberry32(0x5eed_0001);
  return DEGENERATE_LENGTHS.map((length, index) => {
    const period = PERIODS[index];
    const unit = makeUnit(period, random);
    // Begin the loop early enough to reach four complete units (the firing
    // condition) well inside the blob, but not so early that the head is
    // unrepresentative.
    const target = Math.min(Math.round(length * 0.35), 45000);
    const loopStart = Math.max(1000, Math.min(target, length - 4 * period - 200));
    const repeats = Math.ceil((length - loopStart) / period);
    const text = prose(loopStart, random) + unit.repeat(repeats).slice(0, length - loopStart);
    return { seq: 100 + index * 137, turn: 1 + (index % 12), step: 1 + (index % 4), len: text.length, text };
  });
}

/** Build the healthy rows: pure non-repeating reasoning prose. */
function healthyRows() {
  const random = mulberry32(0x5eed_0002);
  return HEALTHY_LENGTHS.map((length, index) => {
    const text = prose(length, random);
    return { seq: 900 + index * 11, turn: 1 + (index % 12), step: 1 + (index % 5), len: text.length, text };
  });
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, rows] of [["degenerate.json", degenerateRows()], ["healthy.json", healthyRows()]]) {
  for (const row of rows) {
    if (row.text.length !== row.len) throw new Error(`${name} row ${row.seq}: expected ${row.len}, got ${row.text.length}`);
  }
  writeFileSync(`${OUT_DIR}${name}`, `${JSON.stringify(rows)}\n`, "utf8");
  const lengths = rows.map((row) => row.text.length);
  const total = lengths.reduce((sum, value) => sum + value, 0);
  console.log(`${name}: ${rows.length} rows, ${total} chars, lengths ${Math.min(...lengths)}..${Math.max(...lengths)}`);
}
