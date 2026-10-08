/**
 * dsh-reasoning-loop-guard — GUI-editable settings.
 *
 * The plugin's baseline configuration lives in the profile patch
 * (`cordis.patch.yml`), which is a deployment artifact: editing it means
 * editing YAML and restarting. But the three optional arms this plugin grew
 * (recovery, effort downgrade, history stripping) are decisions a user revisits
 * while looking at the log panel — "it fired again, turn the recovery arm on" —
 * so they get a second, smaller source of truth that the GUI can write.
 *
 * Precedence is `config.json` over the patch config, key by key. Only keys on
 * {@link EDITABLE_KEYS} may be written: the detection thresholds stay in the
 * patch, so there is never a question of which file a firing's thresholds came
 * from. Keeping the editable surface small is also what makes validation here
 * tractable — every value is either a boolean, one of a few enum strings, or a
 * bounded integer.
 *
 * Writes are atomic (temp file + rename) because the GUI can save while a stream
 * is firing. Readers tolerate a missing, unreadable or corrupt file by falling
 * back to the baseline: a bad settings file must never stop the guard.
 *
 * @module dsh-reasoning-loop-guard/settings
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultConfigPath } from "./journal.js";

/** Versions of the on-disk shape; `1` is the only one written so far. */
export const SETTINGS_VERSION = 1;

/** Reasoning effort levels accepted by the DeepSeek adapter. */
export const EFFORT_VALUES = Object.freeze(["off", "low", "high", "max"]);

/**
 * The exact keys the GUI may write, with their validator and default.
 *
 * `default` is the value used when the key is absent — deliberately the
 * conservative choice for every arm, so a fresh install behaves exactly like
 * the pre-0.2.0 guard (detect and abort) and every added behaviour is opt-in.
 *
 * The one exception is `enabled` itself: it defaults to `true` because that is
 * what a fresh install already did, and the switch exists to turn the core OFF,
 * not to opt into it.
 */
export const EDITABLE_KEYS = Object.freeze({
  // The guard's own core: detect a repeating stream and abort it. It is the one
  // switch whose default is `true` — a fresh install is armed, and the point of
  // the surface is to let a user who was aborted one too many times turn the
  // abort off without uninstalling the plugin. It is read per request by the
  // stream listener, so unlike the patch-level `enabled` it applies live.
  "enabled": { kind: "boolean", default: true },
  "recovery.enabled": { kind: "boolean", default: false },
  "recovery.message": { kind: "string", default: "", maxLength: 2000 },
  "recovery.maxRetries": { kind: "integer", default: 2, min: 0, max: 10 },
  "effort.enabled": { kind: "boolean", default: false },
  "effort.value": { kind: "enum", values: EFFORT_VALUES, default: "low" },
  "stripHistory.enabled": { kind: "boolean", default: false },
});

/** Every key the GUI is allowed to write, in a stable order. */
export const EDITABLE_KEY_NAMES = Object.freeze(Object.keys(EDITABLE_KEYS));

/**
 * Validate one editable value.
 * @param key - one of {@link EDITABLE_KEY_NAMES}.
 * @param value - the candidate value.
 * @returns `{ ok: true, value }` normalized, or `{ ok: false, reason }`.
 */
export function validateValue(key, value) {
  const spec = EDITABLE_KEYS[key];
  if (spec === undefined) return { ok: false, reason: `unknown setting "${key}"` };
  if (spec.kind === "boolean") {
    if (typeof value !== "boolean") return { ok: false, reason: `"${key}" must be a boolean` };
    return { ok: true, value };
  }
  if (spec.kind === "enum") {
    if (typeof value !== "string" || !spec.values.includes(value)) {
      return { ok: false, reason: `"${key}" must be one of ${spec.values.join(", ")}` };
    }
    return { ok: true, value };
  }
  if (spec.kind === "string") {
    if (typeof value !== "string") return { ok: false, reason: `"${key}" must be a string` };
    if (value.length > spec.maxLength) {
      return { ok: false, reason: `"${key}" must be at most ${spec.maxLength} characters` };
    }
    return { ok: true, value };
  }
  if (!Number.isSafeInteger(value)) return { ok: false, reason: `"${key}" must be an integer` };
  if (value < spec.min || value > spec.max) {
    return { ok: false, reason: `"${key}" must be between ${spec.min} and ${spec.max}` };
  }
  return { ok: true, value };
}

/**
 * Validate a whole patch, rejecting the request as a unit.
 *
 * All-or-nothing on purpose: a GUI save that half-applied would leave the user
 * unable to tell which half took effect.
 * @param patch - candidate `{ key: value }` map.
 * @returns `{ ok: true, values }` or `{ ok: false, reason }`.
 */
export function validatePatch(patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, reason: "patch must be a JSON object" };
  }
  const values = {};
  for (const [key, value] of Object.entries(patch)) {
    const result = validateValue(key, value);
    if (!result.ok) return result;
    values[key] = result.value;
  }
  if (Object.keys(values).length === 0) return { ok: false, reason: "patch carries no settings" };
  return { ok: true, values };
}

/**
 * Read the settings file, dropping anything that does not validate.
 *
 * Never throws: an unreadable or malformed file reads as "no overrides", which
 * is the same state as a fresh install.
 * @param path - settings file path.
 * @param warn - optional diagnostic sink.
 * @returns `{ version, values }` with only valid entries.
 */
export function readSettingsFile(path, warn = () => {}) {
  const empty = { version: SETTINGS_VERSION, values: {} };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      warn(`reasoning-loop-guard: cannot read settings ${path}: ${String(error?.message ?? error)}`);
    }
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warn(`reasoning-loop-guard: ignoring malformed settings ${path}: ${String(error?.message ?? error)}`);
    return empty;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(`reasoning-loop-guard: ignoring settings ${path}: not a JSON object`);
    return empty;
  }
  const source = parsed.values !== null && typeof parsed.values === "object" && !Array.isArray(parsed.values)
    ? parsed.values
    : parsed;
  const values = {};
  for (const [key, value] of Object.entries(source)) {
    const result = validateValue(key, value);
    if (!result.ok) continue;
    values[key] = result.value;
  }
  return { version: SETTINGS_VERSION, values };
}

/**
 * Write the settings file atomically, creating the directory as needed.
 * @param path - settings file path.
 * @param values - already-validated values.
 * @returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function writeSettingsFile(path, values) {
  const payload = `${JSON.stringify({ v: SETTINGS_VERSION, values }, null, 2)}\n`;
  const temp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
    return { ok: true };
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing to clean up, or nothing we can do about it.
    }
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * Open the settings store the plugin and its route share.
 *
 * Returns a live view, not a snapshot: {@link SettingsStore.get} folds the
 * file's overrides over the baseline config on every call, so a save is visible
 * to the next stream without a restart.
 *
 * @param options - `{ path?, config, warn? }`.
 * @returns a store with `get`, `apply`, `describe` and `path`.
 */
export function createSettingsStore(options) {
  const {
    config,
    path = defaultConfigPath(),
    warn = () => {},
  } = options;
  let cache = readSettingsFile(path, warn);

  /** Fold `cache.values` over the baseline, key by key. */
  function fold() {
    const effective = { ...config };
    const nested = { recovery: {}, effort: {}, stripHistory: {} };
    for (const [key, value] of Object.entries(cache.values)) {
      const dot = key.indexOf(".");
      if (dot === -1) {
        effective[key] = value;
        continue;
      }
      const group = key.slice(0, dot);
      const field = key.slice(dot + 1);
      if (nested[group] !== undefined) nested[group][field] = value;
    }
    for (const [group, fields] of Object.entries(nested)) {
      const base = config[group];
      const merged = { ...(base !== null && typeof base === "object" ? base : {}), ...fields };
      // Only replace the group when the file actually spoke about it, so the
      // baseline object (and its own defaults) survives untouched otherwise.
      if (Object.keys(fields).length > 0) effective[group] = merged;
    }
    return effective;
  }

  return {
    path,

    /** The effective configuration: baseline plus every stored override. */
    get() {
      return fold();
    },

    /** The stored overrides alone (what the GUI should display as "set"). */
    stored() {
      return { ...cache.values };
    },

    /** Reload from disk; used after an external edit. */
    reload() {
      cache = readSettingsFile(path, warn);
    },

    /**
     * Validate, persist and activate a patch.
     * @param patch - candidate `{ key: value }` map.
     * @returns `{ ok: true, values }` or `{ ok: false, reason }`.
     */
    apply(patch) {
      const result = validatePatch(patch);
      if (!result.ok) return result;
      const next = { ...cache.values, ...result.values };
      const written = writeSettingsFile(path, next);
      if (!written.ok) return { ok: false, reason: `cannot write ${path}: ${written.reason}` };
      cache = { version: SETTINGS_VERSION, values: next };
      return { ok: true, values: result.values };
    },

    /**
     * The editable surface, for rendering a settings form.
     * @returns `{ path, values, stored }` — `values` is effective, `stored` raw.
     */
    describe() {
      const effective = fold();
      const values = {};
      for (const key of EDITABLE_KEY_NAMES) {
        const spec = EDITABLE_KEYS[key];
        const dot = key.indexOf(".");
        const current = dot === -1
          ? effective[key]
          : effective[key.slice(0, dot)]?.[key.slice(dot + 1)];
        values[key] = current === undefined ? spec.default : current;
      }
      return { path, values, stored: { ...cache.values }, keys: EDITABLE_KEY_NAMES };
    },
  };
}
