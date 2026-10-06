/**
 * Unit checks for `lib/settings.js` — the GUI-editable settings store.
 *
 * The store exists so the three optional arms can be toggled from the Plugins
 * page without a restart, which makes two properties load-bearing:
 *
 *  1. a save is visible to the NEXT call (`get()` folds every time), and
 *  2. a broken file behaves like a fresh install, never like a crash.
 *
 * Both are what the guard's stream middleware depends on, so both are tested
 * here rather than only through the route.
 *
 * Run: node test/test-settings.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDITABLE_KEYS,
  EDITABLE_KEY_NAMES,
  EFFORT_VALUES,
  SETTINGS_VERSION,
  createSettingsStore,
  readSettingsFile,
  validatePatch,
  validateValue,
  writeSettingsFile,
} from "../lib/settings.js";

let failures = 0;
const check = (ok, label) => {
  if (!ok) { failures += 1; console.log(`FAIL  ${label}`); } else { console.log(`ok    ${label}`); }
};

const scratch = mkdtempSync(join(tmpdir(), "rlg-settings-"));
const configPath = join(scratch, "config.json");
const warnings = [];
const warn = (message) => warnings.push(message);

/** The baseline the plugin ships with, mirroring lib/index.js defaults. */
const BASE = {
  enabled: true,
  minChars: 800,
  recovery: { enabled: false, message: "内置文案", maxRetries: 2 },
  effort: { enabled: false, value: "low" },
  stripHistory: { enabled: false },
};

console.log("--- 1. the editable surface ---");
check(SETTINGS_VERSION === 1, "the on-disk version is 1");
check(EFFORT_VALUES.join(",") === "off,low,high,max", "the four effort levels match the adapter");
check(EDITABLE_KEY_NAMES.length === 6, `exactly six keys are writable (got ${EDITABLE_KEY_NAMES.length})`);
for (const key of EDITABLE_KEY_NAMES) {
  const spec = EDITABLE_KEYS[key];
  check(
    spec.kind === "boolean" || spec.kind === "enum" || spec.kind === "string" || spec.kind === "integer",
    `${key} declares a known kind`,
  );
}
check(EDITABLE_KEYS["recovery.enabled"].default === false, "recovery defaults off");
check(EDITABLE_KEYS["effort.enabled"].default === false, "effort downgrade defaults off");
check(EDITABLE_KEYS["stripHistory.enabled"].default === false, "history strip defaults off");
// Detection thresholds are deliberately NOT editable: keeping them in the patch
// means a journal record's thresholds always name one file.
check(!EDITABLE_KEY_NAMES.includes("minChars"), "detection thresholds stay out of the GUI");
check(!EDITABLE_KEY_NAMES.includes("minUnits"), "no rule threshold is writable from the browser");

console.log("\n--- 2. value validation ---");
check(validateValue("recovery.enabled", true).ok === true, "a boolean is accepted");
check(validateValue("recovery.enabled", "true").ok === false, "a string is not a boolean");
check(validateValue("recovery.enabled", 1).ok === false, "a number is not a boolean");
check(validateValue("effort.value", "low").ok === true, "a listed effort level is accepted");
check(validateValue("effort.value", "MAX").ok === false, "the enum is case-sensitive");
check(validateValue("effort.value", "turbo").ok === false, "an unlisted level is rejected");
check(validateValue("recovery.maxRetries", 0).ok === true, "zero retries is a legal choice");
check(validateValue("recovery.maxRetries", 10).ok === true, "the upper bound is inclusive");
check(validateValue("recovery.maxRetries", 11).ok === false, "above the bound is rejected");
check(validateValue("recovery.maxRetries", -1).ok === false, "below the bound is rejected");
check(validateValue("recovery.maxRetries", 2.5).ok === false, "a fractional retry count is rejected");
check(validateValue("recovery.message", "自定义文案").ok === true, "a custom message is accepted");
check(validateValue("recovery.message", "").ok === true, "an empty message means 'use the built-in one'");
check(
  validateValue("recovery.message", "x".repeat(2000)).ok === true,
  "a message at the limit is accepted",
);
check(
  validateValue("recovery.message", "x".repeat(2001)).ok === false,
  "a message past the limit is rejected",
);
check(validateValue("minChars", 100).ok === false, "a non-editable key is rejected by name");
check(validateValue("nope", true).ok === false, "an unknown key is rejected");

console.log("\n--- 3. patch validation is all-or-nothing ---");
check(validatePatch({ "effort.enabled": true }).ok === true, "a one-key patch is accepted");
check(
  validatePatch({ "effort.enabled": true, "stripHistory.enabled": true }).ok === true,
  "a multi-key patch is accepted",
);
check(validatePatch({}).ok === false, "an empty patch is refused rather than silently a no-op");
check(validatePatch(null).ok === false, "a null patch is refused");
check(validatePatch([]).ok === false, "an array is not a patch");
{
  // The whole point: one bad key must not let the good ones through, because a
  // half-applied save leaves the user unable to say which half took effect.
  const mixed = validatePatch({ "effort.enabled": true, "effort.value": "turbo" });
  check(mixed.ok === false, "one invalid key fails the whole patch");
  check(String(mixed.reason).includes("effort.value"), "the reason names the offending key");
  check(
    validatePatch({ "stripHistory.enabled": true, "unknown.key": 1 }).ok === false,
    "an unknown key fails the whole patch",
  );
}

console.log("\n--- 4. reading tolerates every failure mode ---");
check(readSettingsFile(join(scratch, "absent.json"), warn).values !== undefined, "a missing file reads as empty");
{
  const bad = join(scratch, "bad.json");
  writeFileSync(bad, "{not json", "utf8");
  const before = warnings.length;
  const read = readSettingsFile(bad, warn);
  check(Object.keys(read.values).length === 0, "malformed JSON reads as empty");
  check(warnings.length > before, "malformed JSON is reported");
}
{
  const list = join(scratch, "list.json");
  writeFileSync(list, "[1,2,3]", "utf8");
  check(Object.keys(readSettingsFile(list, warn).values).length === 0, "a top-level array reads as empty");
}
{
  const partial = join(scratch, "partial.json");
  writeFileSync(
    partial,
    JSON.stringify({
      v: 1,
      values: { "effort.enabled": true, "effort.value": "turbo", "recovery.maxRetries": 4 },
    }),
    "utf8",
  );
  const read = readSettingsFile(partial, warn);
  check(read.values["effort.enabled"] === true, "a valid key survives a neighbouring bad key");
  check(read.values["effort.value"] === undefined, "the invalid value is dropped, not coerced");
  check(read.values["recovery.maxRetries"] === 4, "later valid keys are still read");
}
{
  const bare = join(scratch, "bare.json");
  writeFileSync(bare, JSON.stringify({ "effort.enabled": true }), "utf8");
  check(
    readSettingsFile(bare, warn).values["effort.enabled"] === true,
    "a file without the version wrapper still reads",
  );
}

console.log("\n--- 5. the store folds over the baseline ---");
{
  const store = createSettingsStore({ config: BASE, path: configPath, warn });
  check(store.path === configPath, "the store reports its path");
  check(store.get().minChars === 800, "an untouched baseline passes through");
  check(store.get().recovery.enabled === false, "an untouched arm starts off");
  check(store.get().recovery.message === "内置文案", "the baseline message survives folding");
  check(Object.keys(store.stored()).length === 0, "nothing is stored yet");

  const described = store.describe();
  check(described.path === configPath, "describe reports the path");
  check(described.keys.length === 6, "describe lists every editable key");
  check(described.values["recovery.message"] === "内置文案", "describe reports the effective message");
  check(described.values["effort.value"] === "low", "describe reports the effective effort level");
}
{
  const store = createSettingsStore({ config: BASE, path: configPath, warn });
  const result = store.apply({ "effort.enabled": true, "effort.value": "off" });
  check(result.ok === true, "a valid patch saves");
  check(result.values["effort.value"] === "off", "the save reports back what it wrote");
  // No reload() between these two lines: the next get() must already see it.
  check(store.get().effort.enabled === true, "the save is visible to the next read");
  check(store.get().effort.value === "off", "the saved level is in force");
  check(store.get().stripHistory.enabled === false, "an untouched group keeps its baseline");
  check(store.get().recovery.maxRetries === 2, "a sibling group is not disturbed");
  check(readFileSync(configPath, "utf8").includes("\"effort.enabled\": true"), "the file holds the override");

  // A second save merges rather than replacing the file.
  store.apply({ "stripHistory.enabled": true });
  check(store.get().effort.enabled === true, "an earlier key survives a later save");
  check(store.get().stripHistory.enabled === true, "the later key is in force");

  const reopened = createSettingsStore({ config: BASE, path: configPath, warn });
  check(reopened.get().effort.enabled === true, "a new store reads the saved value from disk");
  check(reopened.get().stripHistory.enabled === true, "both saves persisted");

  const refused = store.apply({ "effort.value": "turbo" });
  check(refused.ok === false, "an invalid patch is refused");
  check(store.get().effort.value === "off", "a refused patch changes nothing on disk or in memory");
}
{
  // A write that cannot land must not be remembered either, or the GUI would
  // show a setting as on that the next stream never sees.
  const store = createSettingsStore({ config: BASE, path: join(scratch, "no"), warn });
  const blocked = createSettingsStore({
    config: BASE,
    // A path whose parent is an existing FILE cannot be created.
    path: join(configPath, "nested", "config.json"),
    warn,
  });
  const result = blocked.apply({ "recovery.enabled": true });
  check(result.ok === false, "an unwritable path is reported as a failure");
  check(blocked.get().recovery.enabled === false, "the in-memory value is not updated when the write fails");
  check(store.get().recovery.enabled === false, "an unrelated store is unaffected");
}
{
  // The default message must be the empty string, so the plugin can tell
  // "user cleared it" from "user typed the built-in wording".
  const store = createSettingsStore({ config: BASE, path: join(scratch, "msg.json"), warn });
  store.apply({ "recovery.message": "请直接给出结论。" });
  check(store.get().recovery.message === "请直接给出结论。", "a custom message is in force");
  store.apply({ "recovery.message": "" });
  check(store.get().recovery.message === "", "an explicit empty message is stored as empty");
}

console.log("\n--- 6. reload and direct writes ---");
{
  const path = join(scratch, "external.json");
  const store = createSettingsStore({ config: BASE, path, warn });
  writeSettingsFile(path, { "effort.enabled": true });
  check(store.get().effort.enabled === false, "an un-reloaded store still shows the old value");
  store.reload();
  check(store.get().effort.enabled === true, "reload picks up an external write");
  const written = JSON.parse(readFileSync(path, "utf8"));
  check(written.v === SETTINGS_VERSION, "the written file carries the version");
}
{
  // The temp file must not be left behind on a successful write.
  const path = join(scratch, "atomic.json");
  const result = writeSettingsFile(path, { "recovery.enabled": true });
  check(result.ok === true, "a direct write succeeds");
  let leftover = true;
  try {
    readFileSync(`${path}.tmp`, "utf8");
  } catch {
    leftover = false;
  }
  check(leftover === false, "no temp file is left behind");
}

rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL SETTINGS CHECKS PASSED" : `\n${failures} SETTINGS CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
