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
import { createDetector, periodicRun, kgramCount, DEFAULTS } from "../lib/detector.js";
import { guardStream, failureMessage } from "../lib/guard.js";

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
const NO_FIRE = { kgramThreshold: Number.MAX_SAFE_INTEGER, minUnits: Number.MAX_SAFE_INTEGER };
const peaks = (text, chunk) => {
  const detector = createDetector(NO_FIRE);
  let kgram = 0;
  let units = 0;
  for (let at = 0; at < text.length; at += chunk) {
    detector.feed(text.slice(at, at + chunk));
    kgram = Math.max(kgram, kgramCount(detector.buffer, DEFAULTS.kgram));
    units = Math.max(units, periodicRun(detector.periodBuffer, DEFAULTS.minPeriod, DEFAULTS.maxPeriod).units);
  }
  return { kgram, units };
};
const posPeaks = positives.map((p) => peaks(p.text, 40));
const negPeaks = negatives.map((n) => peaks(n.text, 40));
const asc = (values) => [...values].sort((a, b) => a - b);
const posKgram = asc(posPeaks.map((p) => p.kgram));
const negKgram = asc(negPeaks.map((p) => p.kgram));
const posUnits = asc(posPeaks.map((p) => p.units));
const negUnits = asc(negPeaks.map((p) => p.units));
console.log(`kgram    positives ${posKgram[0]}..${posKgram.at(-1)}   negatives ${negKgram[0]}..${negKgram.at(-1)}   threshold ${DEFAULTS.kgramThreshold}`);
console.log(`periodic positives ${posUnits[0]}..${posUnits.at(-1)}   negatives ${negUnits[0]}..${negUnits.at(-1)}   threshold ${DEFAULTS.minUnits}`);
check(posKgram[0] > DEFAULTS.kgramThreshold, "k-gram threshold keeps margin below every positive");
check(negKgram.at(-1) < DEFAULTS.kgramThreshold, "k-gram threshold sits above every healthy blob");
check(posUnits[0] > DEFAULTS.minUnits, "periodic threshold keeps margin below every positive");
check(negUnits.at(-1) < DEFAULTS.minUnits, "periodic threshold sits above every healthy blob");

console.log("\n--- 3. guardStream protocol conformance ---");
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
check(finishes[0]?.reason.failure.code === "REASONING_LOOP", "failure code is REASONING_LOOP");
check(typeof finishes[0]?.reason.failure.message === "string" && finishes[0].reason.failure.message.length > 0, "failure carries a message");
check(guarded.length < degenerate.text.length / 40, `stopped early: ${guarded.length} chunks vs ${Math.ceil(degenerate.text.length / 40)} upstream`);

const aborted = await collect(guardStream(fromText(degenerate.text, 40), { sessionId: "test", signal: { aborted: true } }, DEFAULTS));
check(aborted.at(-1)?.reason.kind === "aborted", "an already-aborted signal reports reason.kind === aborted");

const healthy = negatives.find((item) => item.text.length > 8000) ?? negatives[0];
const passthrough = await collect(guardStream(fromText(healthy.text, 40), { sessionId: "test" }, DEFAULTS));
check(passthrough.every((chunk) => chunk.type === "reasoning-delta"), "healthy stream passes through untouched");
check(passthrough.length === Math.ceil(healthy.text.length / 40), `healthy stream is complete (${passthrough.length} chunks)`);

const textOnly = await collect(guardStream(fromText(degenerate.text, 40, "text-delta"), { sessionId: "test" }, DEFAULTS));
check(textOnly.every((chunk) => chunk.type === "text-delta"), "text-delta output is never judged");

console.log("\n--- 4. message rendering ---");
console.log(failureMessage({ rule: "periodic-run", atChars: 6400, units: 10, period: 114 }, "REASONING_LOOP"));
console.log(failureMessage({ rule: "kgram-repeat", atChars: 6400, count: 20 }, "REASONING_LOOP"));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
