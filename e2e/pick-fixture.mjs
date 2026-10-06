/**
 * Map each degenerate fixture to the character offset where the guard fires, so
 * the e2e fake provider can replay the one that trips it soonest.
 *
 * Run: node e2e/pick-fixture.mjs
 */
import { readFileSync } from "node:fs";
import { createDetector, DEFAULTS } from "../lib/detector.js";

const rows = JSON.parse(readFileSync(new URL("../test/fixtures/degenerate.json", import.meta.url), "utf8"));

const CHUNK = 64;
const out = [];
for (const [index, row] of rows.entries()) {
  const detector = createDetector({});
  let firedAt = null;
  let verdict = null;
  for (let at = 0; at < row.text.length; at += CHUNK) {
    verdict = detector.feed(row.text.slice(at, at + CHUNK));
    if (verdict !== null) {
      firedAt = at + CHUNK;
      break;
    }
  }
  out.push({ index, len: row.len, firedAt, verdict });
}

out.sort((a, b) => (a.firedAt ?? Infinity) - (b.firedAt ?? Infinity));
console.log(`DEFAULTS = ${JSON.stringify(DEFAULTS)}`);
for (const r of out) {
  const seen =
    r.verdict === null
      ? "NO-FIRE"
      : `${r.verdict.rule} units=${r.verdict.units ?? "-"} period=${r.verdict.period ?? "-"} count=${r.verdict.count ?? "-"}`;
  console.log(
    `index=${String(r.index).padStart(2)} len=${String(r.len).padStart(7)} firedAt=${String(r.firedAt).padStart(7)} ${seen}`,
  );
}
const best = out.find((r) => r.firedAt !== null);
console.log(`\nFASTEST index=${best.index} len=${best.len} firedAt=${best.firedAt}`);
