/**
 * Derive the statistical shape of the real fixtures, so the committed fixtures
 * can be synthesised from measurements instead of copied from a private log.
 *
 * Run: node tools/fixture-stats.mjs
 */
import { readFileSync } from "node:fs";
import { createDetector, kgramCount, periodicRun, DEFAULTS } from "../lib/detector.js";

const DIR = new URL("../test/fixtures/", import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, DIR), "utf8"));

const NO_FIRE = { kgramThreshold: Number.MAX_SAFE_INTEGER, minUnits: Number.MAX_SAFE_INTEGER };

/** Peak k-gram count and peak periodic units over one blob, firing disabled. */
function peaks(text, chunk = 40) {
  const detector = createDetector(NO_FIRE);
  let kgram = 0;
  let units = 0;
  for (let at = 0; at < text.length; at += chunk) {
    detector.feed(text.slice(at, at + chunk));
    kgram = Math.max(kgram, kgramCount(detector.buffer, DEFAULTS.kgram));
    units = Math.max(units, periodicRun(detector.periodBuffer, DEFAULTS.minPeriod, DEFAULTS.maxPeriod).units);
  }
  return { kgram, units };
}

/** Character-class histogram, as a rough fingerprint of the writing style. */
function classes(text) {
  const counts = { asciiLetter: 0, digit: 0, space: 0, punct: 0, cjk: 0, other: 0 };
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) counts.cjk += 1;
    else if (char === " " || char === "\n" || char === "\t") counts.space += 1;
    else if (code < 128 && /[A-Za-z]/.test(char)) counts.asciiLetter += 1;
    else if (code < 128 && /[0-9]/.test(char)) counts.digit += 1;
    else if (code < 128) counts.punct += 1;
    else counts.other += 1;
  }
  return counts;
}

const quantiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { min: sorted[0], p25: at(0.25), p50: at(0.5), p75: at(0.75), max: sorted.at(-1), total: sorted.reduce((a, b) => a + b, 0) };
};

for (const name of ["degenerate.json", "healthy.json"]) {
  const rows = load(name);
  const lengths = rows.map((r) => r.text.length);
  console.log(`\n=== ${name}: ${rows.length} rows ===`);
  console.log(`length: ${JSON.stringify(quantiles(lengths))}`);
  const peakRows = rows.map((r) => ({ len: r.text.length, ...peaks(r.text) }));
  console.log(`kgram peaks:    ${JSON.stringify(quantiles(peakRows.map((r) => r.kgram)))}`);
  console.log(`periodic peaks: ${JSON.stringify(quantiles(peakRows.map((r) => r.units)))}`);
  const merged = classes(rows.map((r) => r.text).join(""));
  const totalChars = Object.values(merged).reduce((a, b) => a + b, 0);
  const share = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, `${((v / totalChars) * 100).toFixed(2)}%`]));
  console.log(`char classes: ${JSON.stringify(share)}`);
  // Line shape: how the text is broken up.
  const lines = rows.map((r) => r.text.split("\n").length);
  console.log(`lines per row: ${JSON.stringify(quantiles(lines))}`);
  const lineLens = rows.flatMap((r) => r.text.split("\n").map((l) => l.length)).filter((n) => n > 0);
  console.log(`line length: ${JSON.stringify(quantiles(lineLens))}`);
}
