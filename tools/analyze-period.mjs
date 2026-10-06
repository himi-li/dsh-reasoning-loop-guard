/**
 * Detector-family comparison, kept as the calibration record.
 *
 * The guard has two candidate rules, and the committed thresholds were chosen
 * from the separation margin measured here:
 *
 *   A) **k-gram repeat count** — how often the last 64 characters recur inside a
 *      rolling 4096-character window.
 *   B) **contiguous periodic run** — the longest unbroken chain of identical
 *      p-character units at the tail of a 1200-character window.
 *
 * B separates the two populations far more sharply, so it is the primary rule;
 * A is kept as a secondary catch for loops whose period falls outside
 * [minPeriod, maxPeriod].
 *
 * Run: node tools/analyze-period.mjs
 */
import { readFileSync } from "node:fs";
import { createDetector, kgramCount, periodicRun, DEFAULTS } from "../lib/detector.js";

const DIR = new URL("../test/fixtures/", import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, DIR), "utf8"));

const positives = load("degenerate.json");
const negatives = load("healthy.json");

/** Firing disabled, so both rules report their peak rather than their verdict. */
const NO_FIRE = { kgramThreshold: Number.MAX_SAFE_INTEGER, minUnits: Number.MAX_SAFE_INTEGER };

/** Peak k-gram count and peak periodic units observed anywhere in one blob. */
function peaks(text, chunk = 40) {
  const detector = createDetector(NO_FIRE);
  let kgram = 0;
  let units = 0;
  let bestPeriod = 0;
  for (let at = 0; at < text.length; at += chunk) {
    detector.feed(text.slice(at, at + chunk));
    kgram = Math.max(kgram, kgramCount(detector.buffer, DEFAULTS.kgram));
    const run = periodicRun(detector.periodBuffer, DEFAULTS.minPeriod, DEFAULTS.maxPeriod);
    if (run.units > units) {
      units = run.units;
      bestPeriod = run.period;
    }
  }
  return { kgram, units, period: bestPeriod };
}

const ascending = (values) => [...values].sort((a, b) => a - b);
const range = (values) => {
  const sorted = ascending(values);
  return `${sorted[0]}..${sorted.at(-1)}`;
};

console.log(`=== family B: contiguous periodic run (period ${DEFAULTS.minPeriod}..${DEFAULTS.maxPeriod}) ===`);
const posB = positives.map((row) => ({ row, ...peaks(row.text) }));
const negB = negatives.map((row) => ({ row, ...peaks(row.text) }));
console.log(`POS units ${range(posB.map((r) => r.units))}`);
console.log(
  `POS all: ${ascending(posB.map((r) => `${r.units}(p=${r.period})`)).join(" ")}`,
);
const negTop = negB.sort((a, b) => b.units - a.units).slice(0, 10);
console.log(`NEG units ${range(negB.map((r) => r.units))}   top10: ${negTop.map((r) => `${r.units}(p=${r.period})`).join(" ")}`);
console.log(
  `=> threshold ${DEFAULTS.minUnits} sits between NEG max ${Math.max(...negB.map((r) => r.units))} and POS min ${Math.min(...posB.map((r) => r.units))}`,
);

console.log(`\n=== family A: peak k-gram count (k=${DEFAULTS.kgram}, window=${DEFAULTS.window}) ===`);
const posA = ascending(posB.map((r) => r.kgram));
const negA = ascending(negB.map((r) => r.kgram));
console.log(`POS ${posA[0]}..${posA.at(-1)}   all: ${posA.join(",")}`);
console.log(`NEG ${negA[0]}..${negA.at(-1)}   top10: ${negA.slice(-10).reverse().join(",")}`);
console.log(
  `=> threshold ${DEFAULTS.kgramThreshold} sits between NEG max ${negA.at(-1)} and POS min ${posA[0]}`,
);
