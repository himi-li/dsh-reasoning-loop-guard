#!/usr/bin/env node
/**
 * Release content gate.
 *
 * Scans every file that would be published for anything that must not leave
 * this machine: personal paths, account identifiers, hostnames, credentials,
 * and traces of the session this plugin was derived from.
 *
 * The local account name and the surrounding workspace path are resolved at
 * runtime, so this file itself carries no personal identifier.
 *
 * Run before every push:  node tools/scan-repo.mjs
 * Exit 0 = clean, 1 = hits found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Not published (and may legitimately contain scratch).
const SKIP_DIRS = new Set(["node_modules", ".git", "e2e-home"]);
const SKIP_FILES = new Set(["package-lock.json", "pnpm-lock.yaml"]);

// The gates' own rule tables necessarily spell out what they look for, so
// scanning them would only ever report the definitions themselves.
const GATE_FILES = new Set(["scan-repo.mjs", "scan-fixtures.mjs"]);

/** The account running the scan, and the workspace the repo sits in. */
const LOCAL_USER = process.env.USERNAME ?? process.env.USER ?? userInfo().username;
const WORKSPACE = dirname(ROOT);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const RULES = [
  { name: "local-user-name", re: new RegExp(escapeRegExp(LOCAL_USER), "gu") },
  { name: "windows-user-path", re: /[A-Za-z]:\\+Users\\+[^\\"'\s]+/gu },
  // Only the full local path is identifying — the bare project name is public.
  { name: "workspace-path", re: new RegExp(escapeRegExp(WORKSPACE), "giu") },
  { name: "wxid", re: /wxid_[A-Za-z0-9_-]+/gu },
  { name: "wechat-brand", re: /\u5fae\u4fe1|We[Cc]hat/gu },
  { name: "file-helper", re: /\u6587\u4ef6\u4f20\u8f93\u52a9\u624b/gu },
  { name: "scratch-dir", re: /_ntr_work/gu },
  { name: "session-id", re: /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu },
  { name: "email", re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/gu },
  { name: "cn-phone", re: /(?<!\d)1[3-9]\d{9}(?!\d)/gu },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu },
  { name: "secret-assign", re: /(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["'][^"']{12,}["']/giu },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9._-]{20,}/gu },
  { name: "github-pat", re: /gh[pousr]_[A-Za-z0-9]{20,}/gu },
  { name: "npm-token", re: /npm_[A-Za-z0-9]{30,}/gu },
  { name: "sk-key", re: /sk-[A-Za-z0-9]{20,}/gu },
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      if (GATE_FILES.has(entry.name)) continue;
      yield full;
    }
  }
}

console.log(`local user name checked: ${JSON.stringify(LOCAL_USER)}`);
console.log(`workspace path checked:   ${JSON.stringify(WORKSPACE)}`);

let scanned = 0;
let hits = 0;
const perRule = new Map();

for (const file of walk(ROOT)) {
  const info = statSync(file);
  if (info.size > 16 * 1024 * 1024) continue;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    continue; // binary
  }
  if (raw.includes("\u0000")) continue; // binary
  scanned += 1;

  // Raw view plus a de-escaped one, so `C:\\Users\\x` and `C:\Users\x` both match.
  const views = [raw, raw.replace(/\\\\/gu, "\\")];

  for (const { name, re } of RULES) {
    const found = new Set();
    for (const view of views) {
      re.lastIndex = 0;
      for (const m of view.matchAll(re)) {
        found.add(m[0].length > 120 ? `${m[0].slice(0, 117)}…` : m[0]);
      }
    }
    if (found.size === 0) continue;
    hits += found.size;
    perRule.set(name, (perRule.get(name) ?? 0) + found.size);
    console.log(`\n!! ${name}  (${relative(ROOT, file)})`);
    for (const text of [...found].slice(0, 12)) console.log(`     ${text}`);
    if (found.size > 12) console.log(`     … and ${found.size - 12} more`);
  }
}

console.log(`\n=== release content gate: ${scanned} text files scanned ===`);
if (hits === 0) {
  console.log("CLEAN — nothing to redact before publishing.");
  process.exit(0);
}
console.log(`HITS: ${hits} across ${perRule.size} rule(s):`);
for (const [name, count] of [...perRule].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name}: ${count}`);
}
process.exit(1);
