/**
 * Scan a fixture file for strings that must not be published.
 *
 * JSON stores Windows paths with doubled backslashes, so every pattern is
 * tested against both the raw bytes and the decoded text.
 *
 * The local account name is read from the environment rather than hardcoded,
 * so this file carries no personal identifier of its own.
 *
 * Run: node tools/scan-fixtures.mjs [file ...]
 */
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The account running the scan — the name that must never appear in a fixture. */
const LOCAL_USER = process.env.USERNAME ?? process.env.USER ?? userInfo().username;

/** Patterns are matched against raw text and against `\\`→`\` collapsed text. */
const PATTERNS = [
  ["windows user path", /[A-Za-z]:\\+Users\\+[^\\"'\s]+/gu],
  ["any windows path", /[A-Za-z]:\\+(?:[^\\"'\s]+\\+){1,}[^\\"'\s]*/gu],
  ["unix home path", /\/(?:home|Users)\/[A-Za-z0-9._-]+/gu],
  ["wxid", /wxid_[A-Za-z0-9_-]+/gu],
  ["wechat brand", /微信|WeChat|wechat/gu],
  ["file helper", /文件传输助手/gu],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu],
  ["cn phone", /(?<!\d)1[3-9]\d{9}(?!\d)/gu],
  ["secret-ish key", /\b(?:sk|ghp|gho|github_pat|xox[baprs]|AKIA|AIza)[-_A-Za-z0-9]{8,}/gu],
  ["bearer/token", /(?:Bearer|token|api[_-]?key|password|passwd|secret)\s*[:=]\s*\S{6,}/giu],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu],
  ["ipv4", /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/gu],
  ["long token", /(?<![A-Za-z0-9])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9])/gu],
  ["session id", /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu],
  ["local user name", new RegExp(escapeRegExp(LOCAL_USER), "gu")],
];

const files = process.argv.slice(2);
if (files.length === 0) files.push("test/fixtures/degenerate.json", "test/fixtures/healthy.json");

console.log(`local user name checked: ${JSON.stringify(LOCAL_USER)}`);

let totalHits = 0;
for (const file of files) {
  const raw = readFileSync(file, "utf8");
  // Raw bytes plus a de-escaped view so `C:\\Users\\x` and `C:\Users\x` both match.
  const views = [["raw", raw], ["unescaped", raw.replaceAll("\\\\", "\\").replaceAll('\\"', '"')]];
  console.log(`\n=== ${file} (${raw.length} chars) ===`);
  for (const [label, pattern] of PATTERNS) {
    const hits = new Map();
    for (const [, text] of views) {
      for (const match of text.matchAll(pattern)) hits.set(match[0], (hits.get(match[0]) ?? 0) + 1);
    }
    if (hits.size === 0) continue;
    const total = [...hits.values()].reduce((a, b) => a + b, 0);
    totalHits += total;
    console.log(`  ${label}: ${hits.size} distinct, ${total} total`);
    for (const [value, count] of [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      const shown = value.length > 80 ? `${value.slice(0, 77)}...` : value;
      console.log(`      ×${String(count).padStart(5)}  ${JSON.stringify(shown)}`);
    }
  }
}

console.log(totalHits === 0 ? "\nCLEAN" : `\n${totalHits} hit(s) — do not publish`);
process.exit(totalHits === 0 ? 0 : 1);
