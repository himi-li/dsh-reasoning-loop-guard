/**
 * Offline validation of the fire journal and the maintenance log tool.
 *
 * Everything here runs against a temp directory, so the suite never touches a
 * real DSH home and is safe to run on any machine.
 *
 * Run: node test/test-journal.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOURNAL_VERSION,
  buildRecord,
  clipPreview,
  createJournal,
  defaultJournalPath,
  localStamp,
  parseJournal,
  resolveDshHome,
} from "../lib/journal.js";
import { LOG_ACTIONS, LOG_TOOL_NAME, createLogTool, formatLog } from "../lib/log-tool.js";

let failures = 0;
const check = (ok, label) => {
  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
};

const scratch = mkdtempSync(join(tmpdir(), "rlg-journal-"));
const journalPath = join(scratch, "fires.jsonl");
const warnings = [];
const journal = createJournal({
  path: journalPath,
  maxBytes: 64 * 1024,
  previewChars: 20,
  warn: (message) => warnings.push(message),
});

console.log("--- 1. home resolution ---");
check(resolveDshHome({ DSH_HOME: "C:\\custom" }, "C:\\home") === "C:\\custom", "DSH_HOME wins when set");
check(resolveDshHome({ DSH_HOME: "  " }, join("C:", "home")) === join("C:", "home", ".dsh"), "blank DSH_HOME falls back to ~/.dsh");
check(resolveDshHome({}, join("C:", "home")) === join("C:", "home", ".dsh"), "missing DSH_HOME falls back to ~/.dsh");
check(defaultJournalPath({ DSH_HOME: join("C:", "h") }).endsWith(join("dsh-reasoning-loop-guard", "fires.jsonl")), "journal lives under the plugin directory");

console.log("\n--- 2. preview clipping ---");
check(clipPreview("abcdef", 3) === "abc…", "long preview is clipped and ellipsized");
check(clipPreview("abc", 3) === "abc", "short preview is untouched");
check(clipPreview(undefined, 3) === "", "non-string preview becomes empty");
check(clipPreview("abcdef", 0) === "", "non-positive bound becomes empty");

console.log("\n--- 3. human-readable stamps are local ---");
{
  // The regression this pins: the panel printed the stored UTC string, so a
  // fire at 16:25 local (08:25Z) looked like a fire that never happened.
  const at = 1791447902507;
  const local = new Date(at);
  const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")} `
    + `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}:${String(local.getSeconds()).padStart(2, "0")}`;
  check(localStamp(at) === expected, `localStamp renders the reader's clock (${localStamp(at)})`);
  check(localStamp(at) !== new Date(at).toISOString().replace("T", " ").slice(0, 19), "localStamp is not the raw UTC string");
  check(localStamp(undefined) === "?" && localStamp(Number.NaN) === "?" && localStamp("x") === "?", "localStamp survives a missing or unusable instant");
  check(localStamp(1767225600000).length === 19, "localStamp emits a fixed-width YYYY-MM-DD HH:MM:SS stamp");
}

console.log("\n--- 4. record shape ---");
const verdict = { rule: "periodic-run", atChars: 2120, units: 5, period: 104, preview: "Let me write. Go. Emit. OK. Now." };
const options = { sessionId: "sess-1", provider: "deepseek", model: "deepseek-v4.1" };
const config = { failureCode: "REASONING_LOOP", journalPreviewChars: 20 };
const record = buildRecord({ verdict, options, config, pluginVersion: "0.2.0", now: 1767225600000 });
check(record.v === JOURNAL_VERSION, "record carries the schema version");
check(record.iso === "2026-01-01T00:00:00.000Z", `iso is derived from the timestamp (${record.iso})`);
check(record.rule === "periodic-run" && record.units === 5 && record.period === 104, "periodic verdict is recorded");
check(record.sessionId === "sess-1" && record.provider === "deepseek" && record.model === "deepseek-v4.1", "route identity is recorded");
check(record.atChars === 2120 && record.failureCode === "REASONING_LOOP", "measurement and failure code are recorded");
check(record.preview === "Let me write. Go. Em…", `preview is clipped to the configured bound (${JSON.stringify(record.preview)})`);
const kgramRecord = buildRecord({
  verdict: { rule: "kgram-repeat", atChars: 900, count: 20, preview: "x".repeat(50) },
  options: {},
  config,
  now: 1767225600000,
});
check(kgramRecord.count === 20 && kgramRecord.units === undefined, "kgram verdict records a count instead of a period");
check(kgramRecord.sessionId === undefined && kgramRecord.provider === undefined, "absent route fields are omitted, not null");
const bare = buildRecord({ verdict, options, config, now: 1767225600000 });
check(bare.pluginVersion === undefined, "an unknown plugin version is omitted");
const noPreview = buildRecord({ verdict: { ...verdict, preview: "" }, options, config, now: 1767225600000 });
check(noPreview.preview === undefined, "an empty preview is omitted");
{
  // The richer post-mortem fields: what the stream did over time, which attempt
  // it was, and the tunables in force. Absent facts stay absent.
  const rich = buildRecord({
    verdict,
    options,
    config,
    now: 1767225600000,
    facts: {
      elapsedMs: 205000,
      ttftMs: 1200,
      fromStartMs: 206200,
      reasoningChars: 20692,
      aborted: true,
      rawTail: "raw tail text",
      attempt: { attemptId: "attempt-7", turn: 61, step: 12 },
      cwd: "C:\\work\\proj",
    },
    thresholds: { minChars: 800, minUnits: 4 },
  });
  check(rich.turn === 61 && rich.step === 12 && rich.attemptId === "attempt-7", "the attempt is recorded");
  check(rich.elapsedMs === 205000 && rich.ttftMs === 1200, "both timing halves are recorded");
  check(rich.fromStartMs === 206200 && rich.reasoningChars === 20692, "the totals are recorded");
  check(rich.aborted === true, "a user abort is recorded");
  check(rich.cwd === "C:\\work\\proj", "the working directory is recorded");
  check(rich.previewRaw === "raw tail text", "the raw tail is recorded next to the normalized preview");
  check(rich.thresholds.minChars === 800 && rich.thresholds.minUnits === 4, "the thresholds in force are recorded");
  const lean = buildRecord({ verdict, options, config, now: 1767225600000, facts: {} });
  check(lean.turn === undefined && lean.ttftMs === undefined, "absent facts are omitted, not null");
  check(lean.aborted === undefined, "a stream that was not aborted carries no abort flag");
  check(
    buildRecord({ verdict, options, config, now: 1767225600000, facts: { aborted: false } }).aborted === undefined,
    "aborted is only recorded when it happened",
  );
  check(lean.thresholds === undefined, "a record without a snapshot carries no thresholds");
  check(
    buildRecord({ verdict, options, config, now: 1767225600000, facts: { rawTail: verdict.preview } }).previewRaw === undefined,
    "a raw tail identical to the preview is not duplicated",
  );
}

console.log("\n--- 5. parsing tolerates damage ---");
const damaged = `{"v":1,"at":1}\n\n  \nnot json\n[1,2,3]\n{"v":1,"at":2}\n{"v":1,"at":3`;
const parsed = parseJournal(damaged);
check(parsed.length === 2, `only well-formed object lines survive (got ${parsed.length})`);
check(parsed[0].at === 1 && parsed[1].at === 2, "records keep file order");

console.log("\n--- 6. journal writes, reads and filters ---");
check(journal.enabled === true, "journal is enabled by default");
check(journal.record(record) === true, "a record is written");
check(existsSync(journalPath), "the journal file exists after the first write");
check(journal.record({ ...record, at: 1767225600001, iso: "2026-01-01T00:00:00.001Z", rule: "kgram-repeat", count: 20, sessionId: "sess-2", model: "other-model" }) === true, "a second record is written");
const all = journal.read({ limit: 10 });
check(all.total === 2 && all.matched === 2 && all.entries.length === 2, "both records are readable");
check(all.entries[0].at === 1767225600001, "reads are newest-first");
check(journal.read({ rule: "kgram-repeat" }).matched === 1, "reads filter by rule");
check(journal.read({ sessionId: "sess-2" }).matched === 1, "reads filter by session");
check(journal.read({ since: 1767225600001 }).matched === 1, "reads filter by timestamp");
check(journal.read({ limit: 1 }).entries.length === 1, "reads honour the limit");
check(journal.read({ limit: 0 }).entries.length === 2, "a non-positive limit falls back to the default instead of hiding history");
check(journal.read({ limit: 0 }).matched === 2, "the match count is unaffected by the limit");
const readback = journal.read({ limit: 10 }).entries[0];
check(readback.preview === record.preview, "the preview survives a round trip");

console.log("\n--- 7. stats aggregate ---");
const stats = journal.stats();
check(stats.count === 2, "stats counts every record");
check(stats.byRule["periodic-run"] === 1 && stats.byRule["kgram-repeat"] === 1, "stats group by rule");
check(stats.byModel["deepseek-v4.1"] === 1 && stats.byModel["other-model"] === 1, "stats group by model");
check(stats.byDay[localStamp(Date.parse("2026-01-01T00:00:00.000Z")).slice(0, 10)] === 2, "stats group by the reader's local day");
check(stats.earliest === 1767225600000 && stats.latest === 1767225600001, "stats report the time span");

console.log("\n--- 8. rotation and clear ---");
const smallPath = join(scratch, "small.jsonl");
const small = createJournal({ path: smallPath, maxBytes: 512, warn: (m) => warnings.push(m) });
for (let i = 0; i < 40; i += 1) small.record({ v: 1, at: i, iso: "2026-01-01T00:00:00.000Z", rule: "periodic-run", pad: "x".repeat(64) });
check(existsSync(`${smallPath}.1`), "the journal rotates to a .1 backup once it outgrows maxBytes");
check(small.read({ limit: 5 }).total < 40, "rotation bounds how much history is kept");
check(journal.clear() === true, "clear reports that it removed something");
check(!existsSync(journalPath), "clear removes the journal file");
check(journal.read({ limit: 5 }).total === 0, "the journal reads empty after clear");
check(journal.clear() === false, "clearing an absent journal reports nothing removed");

console.log("\n--- 9. failures never escape ---");
const warningsBefore = warnings.length;
const blocked = createJournal({ path: join(scratch, "nested", "\u0000bad", "fires.jsonl"), warn: (m) => warnings.push(m) });
check(blocked.record(record) === false, "an unwritable path reports failure instead of throwing");
check(warnings.length > warningsBefore, "the failure is reported through warn");
check(blocked.read({ limit: 1 }).total === 0, "reading an unreadable journal yields nothing");
check(blocked.stats().count === 0, "stats on an unreadable journal are empty");
const disabled = createJournal({ path: join(scratch, "off.jsonl"), enabled: false });
check(disabled.record(record) === false && !existsSync(join(scratch, "off.jsonl")), "a disabled journal writes nothing");
writeFileSync(join(scratch, "truncated.jsonl"), '{"v":1,"at":1,"rule":"periodic-run"}\n{"v":1,"at":2,"ru', "utf8");
const truncated = createJournal({ path: join(scratch, "truncated.jsonl") });
check(truncated.read({ limit: 10 }).total === 1, "a truncated tail does not hide the records before it");

console.log("\n--- 10. the maintenance tool ---");
check(LOG_TOOL_NAME === "reasoning_loop_log", "tool name is stable");
check(LOG_ACTIONS.join(",") === "list,stats,clear,path", "documented actions are stable");
const tool = createLogTool({ journal: small });
check(tool.name === LOG_TOOL_NAME, "createLogTool names the tool");
check(typeof tool.execute === "function" && typeof tool.output.render === "function", "the definition has execute and render");
check(tool.parameters.required.join(",") === "action", "action is the only required argument");
check(tool.parameters.properties.action.enum.join(",") === "list,stats,clear,path", "the action enum matches the documented actions");
check(tool.output.schema.additionalProperties === false, "the output schema closes additional properties");
check(Object.values(tool.output.schema.properties).every((node) => typeof node.type === "string"), "every output property declares a single type");
const listed = await tool.execute({ action: "list", limit: 3 }, {});
check(listed.entries.length === 3 && listed.total > 3, "list honours the limit and reports the total");
check(listed.entries[0].at > listed.entries[1].at, "list is newest-first");
const narrowed = await tool.execute({ action: "list", rule: "periodic-run" }, {});
check(narrowed.entries.every((entry) => entry.rule === "periodic-run"), "list filters by rule");
const renderedList = tool.output.render({}, listed);
check(renderedList[0].text.includes("newest first"), "the rendered list announces its ordering");
check(renderedList[0].text.includes("periodic-run"), "the rendered list names the rule");
const statsView = await tool.execute({ action: "stats" }, {});
check(statsView.stats.count === small.stats().count && statsView.total === statsView.stats.count, "stats reports the count in both places");
check(tool.output.render({}, statsView)[0].text.includes("fires:"), "the rendered stats carry a header");
const pathView = await tool.execute({ action: "path" }, {});
check(pathView.path === smallPath && pathView.action === "path", "path reports the journal location");
check(tool.output.render({}, pathView)[0].text === `journal: ${smallPath}`, "the rendered path is a single line");
const cleared = await tool.execute({ action: "clear" }, {});
check(cleared.removed === true, "clear reports the removal");
check(tool.output.render({}, cleared)[0].text.includes("journal cleared"), "the rendered clear says so");
check(tool.output.render({}, await tool.execute({ action: "list" }, {}))[0].text.includes("no fires recorded"), "an empty journal renders an explicit message");
const unknown = await tool.execute({}, {});
check(unknown.action === "list", "a missing action defaults to list");
check(formatLog({ action: "list", path: "p", total: 0, matched: 0, entries: [] }).includes("0 matched of 0"), "formatLog is usable without a journal");
check(tool.output.render({}, { action: "stats", path: "p", stats: {} })[0].text.includes("—"), "missing stats render as a dash rather than throwing");

rmSync(scratch, { recursive: true, force: true });
check(!existsSync(scratch), "the scratch directory is cleaned up");

console.log(`\n${failures === 0 ? "ALL JOURNAL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
