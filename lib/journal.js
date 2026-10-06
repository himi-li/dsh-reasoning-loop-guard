/**
 * dsh-reasoning-loop-guard — the fire journal.
 *
 * Every time the guard trips, one bounded JSON line is appended to a local
 * journal. The journal exists for maintenance: when the guard fires you want to
 * know how often, on which model, and what the repeating text looked like —
 * without re-reading a 200k-character session log. It also makes threshold
 * tuning evidence-based instead of guesswork.
 *
 * Design constraints, in order of importance:
 *
 *  1. **Never break the stream.** Every write is wrapped; a journal failure is
 *     reported through the caller's `warn` sink and otherwise ignored. The
 *     guard's job is to stop a runaway model, not to persist telemetry.
 *  2. **Bounded.** The record carries only metadata plus a short preview of the
 *     *repeating unit* — by construction the degenerate filler ("Let me write.
 *     Go."), not the model's substantive reasoning. The file is capped by
 *     `maxBytes` and rotated to a single `.1` backup.
 *  3. **Dependency-free.** No Cordis, no schemastery, no I/O beyond `node:fs`,
 *     so the whole module is unit-testable offline.
 *
 * Storage location follows the DSH home convention: `$DSH_HOME/<plugin>/…`,
 * falling back to `~/.dsh/<plugin>/…` when `DSH_HOME` is unset.
 *
 * @module dsh-reasoning-loop-guard/journal
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Journal record schema version; bumped when a field changes meaning. */
export const JOURNAL_VERSION = 1;

/** Directory name created under the DSH home. */
const HOME_DIR_NAME = "dsh-reasoning-loop-guard";

/** Journal file name inside {@link HOME_DIR_NAME}. */
const JOURNAL_FILE_NAME = "fires.jsonl";

/** Settings file name inside {@link HOME_DIR_NAME} (see `settings.js`). */
const CONFIG_FILE_NAME = "config.json";

/**
 * Resolve the Harness home directory the way DSH's own plugins do.
 * @param env - environment to read `DSH_HOME` from.
 * @param home - fallback user home.
 * @returns the absolute DSH home directory (may not exist yet).
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env?.DSH_HOME;
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return join(home, ".dsh");
}

/**
 * Default journal path for one DSH home.
 * @param env - environment to read `DSH_HOME` from.
 * @param home - fallback user home.
 * @returns the absolute journal file path.
 */
export function defaultJournalPath(env = process.env, home = homedir()) {
  return join(resolveDshHome(env, home), HOME_DIR_NAME, JOURNAL_FILE_NAME);
}

/**
 * Default path of the GUI-editable settings file (see `settings.js`).
 * @param env - environment to read `DSH_HOME` from.
 * @param home - fallback user home.
 * @returns the absolute settings file path.
 */
export function defaultConfigPath(env = process.env, home = homedir()) {
  return join(resolveDshHome(env, home), HOME_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * The state directory this plugin owns, created on demand.
 * @param env - environment to read `DSH_HOME` from.
 * @param home - fallback user home.
 * @returns the absolute directory path.
 */
export function pluginStateDir(env = process.env, home = homedir()) {
  return join(resolveDshHome(env, home), HOME_DIR_NAME);
}

/**
 * Clip one preview string to its bound.
 * @param text - raw repeating unit.
 * @param maxChars - maximum characters to keep.
 * @returns the clipped preview, ellipsized when it was cut.
 */
export function clipPreview(text, maxChars) {
  if (typeof text !== "string") return "";
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** Copy only the keys that actually carry a value, so records stay compact. */
function defined(pairs) {
  const out = {};
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

/** Keep numbers finite, so a NaN never reaches the journal as `null`. */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Build the durable record for one firing.
 *
 * A record has to answer "what happened, and should I retune?" without the
 * session log. That means three layers: what the guard saw (rule, measure,
 * counts), the context the stream ran in (model, effort, timing, cwd), and the
 * thresholds in force at that moment. Everything is optional — a host missing a
 * service omits a field rather than failing the write.
 *
 * `preview` is the normalized repeating material; `previewRaw` the same region
 * of the raw stream. Keeping both is deliberate: the normalized form shows the
 * loop, the raw form shows the formatting the model actually emitted.
 *
 * @param input - what the guard measured, plus route, plugin identity and facts.
 * @returns a plain JSON-serializable record.
 */
export function buildRecord(input) {
  const { verdict, options, config, pluginVersion, now, facts, thresholds } = input;
  const record = {
    v: JOURNAL_VERSION,
    at: now,
    iso: new Date(now).toISOString(),
    rule: verdict.rule,
    atChars: verdict.atChars,
    failureCode: config.failureCode,
    ...defined({
      pluginVersion,
      sessionId: options?.sessionId === undefined ? undefined : String(options.sessionId),
      provider: options?.provider === undefined ? undefined : String(options.provider),
      model: options?.model === undefined ? undefined : String(options.model),
      purpose: options?.purpose === undefined ? undefined : String(options.purpose),
      reasoningEffort: options?.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      maxTokens: finite(options?.maxTokens),
      temperature: finite(options?.temperature),
      cwd: facts?.cwd === undefined || facts.cwd === null ? undefined : String(facts.cwd),
      turn: finite(facts?.attempt?.turn),
      step: finite(facts?.attempt?.step),
      attemptId: facts?.attempt?.attemptId === undefined ? undefined : String(facts.attempt.attemptId),
      elapsedMs: finite(facts?.elapsedMs),
      ttftMs: finite(facts?.ttftMs),
      fromStartMs: finite(facts?.fromStartMs),
      reasoningChars: finite(facts?.reasoningChars),
      aborted: facts?.aborted === true ? true : undefined,
    }),
  };
  if (verdict.rule === "periodic-run") {
    record.units = verdict.units;
    record.period = verdict.period;
  } else {
    record.count = verdict.count;
    if (verdict.rule === "block-repeat") record.blockLen = verdict.blockLen;
    if (verdict.rule === "line-repeat") record.lineLen = verdict.lineLen;
  }
  const preview = clipPreview(verdict.preview, config.journalPreviewChars);
  if (preview !== "") record.preview = preview;
  const raw = clipPreview(facts?.rawTail, config.journalPreviewChars);
  if (raw !== "" && raw !== preview) record.previewRaw = raw;
  if (thresholds !== undefined && thresholds !== null) record.thresholds = thresholds;
  return record;
}

/**
 * Parse a journal file, skipping lines that are blank or corrupt.
 * A truncated tail (a crash mid-write) must not hide the records before it.
 * @param raw - file contents.
 * @returns the parsed records in file order.
 */
export function parseJournal(raw) {
  const records = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed);
    } catch {
      // A partial or hand-edited line is dropped, never fatal.
    }
  }
  return records;
}

/**
 * Open (or create) the fire journal.
 * @param options - resolved journal settings.
 * @returns a journal handle with `record`, `read`, `stats`, `clear` and `path`.
 */
export function createJournal(options) {
  const {
    path,
    enabled = true,
    maxBytes = 512 * 1024,
    maxEntries = 500,
    previewChars = 120,
    warn = () => {},
  } = options;

  /** Ensure the parent directory exists; returns false when it cannot. */
  function ensureDir() {
    try {
      mkdirSync(dirname(path), { recursive: true });
      return true;
    } catch (error) {
      warn(`reasoning-loop-guard: cannot create journal directory for ${path}: ${String(error?.message ?? error)}`);
      return false;
    }
  }

  /** Rotate to a single `.1` backup once the file outgrows `maxBytes`. */
  function rotateIfNeeded() {
    try {
      if (!existsSync(path)) return;
      if (statSync(path).size < maxBytes) return;
      const backup = `${path}.1`;
      rmSync(backup, { force: true });
      renameSync(path, backup);
    } catch (error) {
      // Rotation is best-effort: appending to a large file still beats losing
      // the record entirely.
      warn(`reasoning-loop-guard: journal rotation failed for ${path}: ${String(error?.message ?? error)}`);
    }
  }

  return {
    path,
    enabled,

    /**
     * Append one firing record. Never throws.
     * @param record - a {@link buildRecord} result.
     * @returns whether the record reached disk.
     */
    record(entry) {
      if (!enabled) return false;
      try {
        if (!ensureDir()) return false;
        rotateIfNeeded();
        appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
        return true;
      } catch (error) {
        warn(`reasoning-loop-guard: journal write failed for ${path}: ${String(error?.message ?? error)}`);
        return false;
      }
    },

    /**
     * Read the journal newest-first.
     * @param query - optional filters.
     * @returns matching records plus the total count seen before filtering.
     */
    read(query = {}) {
      const { limit = 20, rule, sessionId, since } = query;
      let records;
      try {
        records = existsSync(path) ? parseJournal(readFileSync(path, "utf8")) : [];
      } catch (error) {
        warn(`reasoning-loop-guard: journal read failed for ${path}: ${String(error?.message ?? error)}`);
        records = [];
      }
      const total = records.length;
      let filtered = records;
      if (typeof rule === "string" && rule !== "") filtered = filtered.filter((r) => r.rule === rule);
      if (typeof sessionId === "string" && sessionId !== "") filtered = filtered.filter((r) => r.sessionId === sessionId);
      if (Number.isFinite(since)) filtered = filtered.filter((r) => Number.isFinite(r.at) && r.at >= since);
      const capped = Number.isSafeInteger(limit) && limit > 0 ? limit : 20;
      return { total, matched: filtered.length, entries: filtered.slice(-capped).reverse() };
    },

    /**
     * Aggregate the journal into maintenance counters.
     * @returns counts by rule, by model and by day, plus the time span.
     */
    stats() {
      let records;
      try {
        records = existsSync(path) ? parseJournal(readFileSync(path, "utf8")) : [];
      } catch {
        records = [];
      }
      const byRule = {};
      const byModel = {};
      const byDay = {};
      let earliest = null;
      let latest = null;
      for (const r of records) {
        byRule[r.rule ?? "unknown"] = (byRule[r.rule ?? "unknown"] ?? 0) + 1;
        const model = r.model ?? "unknown";
        byModel[model] = (byModel[model] ?? 0) + 1;
        const day = typeof r.iso === "string" ? r.iso.slice(0, 10) : "unknown";
        byDay[day] = (byDay[day] ?? 0) + 1;
        if (Number.isFinite(r.at)) {
          if (earliest === null || r.at < earliest) earliest = r.at;
          if (latest === null || r.at > latest) latest = r.at;
        }
      }
      const trim = (counts) => Object.fromEntries(
        Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, maxEntries),
      );
      return {
        count: records.length,
        byRule: trim(byRule),
        byModel: trim(byModel),
        byDay: Object.fromEntries(Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, maxEntries)),
        earliest,
        latest,
      };
    },

    /**
     * Delete the journal and its backup. Never throws.
     * @returns whether anything was removed.
     */
    clear() {
      let removed = false;
      for (const target of [path, `${path}.1`]) {
        try {
          if (!existsSync(target)) continue;
          rmSync(target, { force: true });
          removed = true;
        } catch (error) {
          warn(`reasoning-loop-guard: journal clear failed for ${target}: ${String(error?.message ?? error)}`);
        }
      }
      return removed;
    },
  };
}
