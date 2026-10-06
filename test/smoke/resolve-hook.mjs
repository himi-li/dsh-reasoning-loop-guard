/**
 * Map bare `@deepseek-ai/*` specifiers onto the real installed locations, so
 * `lib/index.js` can be exercised outside a real DSH boot.
 *
 * Nothing here is hard-coded to one machine: the DSH app directory is taken
 * from `DSH_APP_DIR` when set, otherwise discovered from the running `dsh`
 * installation, and the profile directory is derived from `DSH_HOME`.
 *
 * `test/smoke/register-hook.mjs` installs this as a Node module hook.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

/** Candidate app install roots, in the order DSH itself would try them. */
function appCandidates() {
  const fromEnv = process.env.DSH_APP_DIR;
  const candidates = [];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") candidates.push(fromEnv.trim());
  const require = createRequire(import.meta.url);
  for (const specifier of ["@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-llm", "@deepseek-ai/cordis"]) {
    try {
      // …/node_modules/@deepseek-ai/dsh-llm/lib/index.js → …/node_modules
      const resolved = require.resolve(specifier);
      const at = resolved.lastIndexOf("node_modules");
      if (at > 0) candidates.push(resolved.slice(0, at + "node_modules".length));
    } catch {
      // Not resolvable from here; the env var or the fallbacks below decide.
    }
  }
  for (const dir of [
    process.env.ProgramFiles && join(process.env.ProgramFiles, "DSH Desktop", "resources", "app", "node_modules"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "DSH Desktop", "resources", "app", "node_modules"),
    "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules",
    "/usr/lib/dsh-desktop/resources/app/node_modules",
  ]) {
    if (typeof dir === "string" && dir !== "") candidates.push(dir);
  }
  return candidates.map((dir) => `${dir.replaceAll("\\", "/").replace(/\/+$/u, "")}/`);
}

/** The DSH home, mirroring the plugin's own resolution. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return join(homedir(), ".dsh");
}

const APP_ROOTS = appCandidates().filter((root) => existsSync(root));
const PROFILE_ROOTS = [
  join(dshHome(), "profiles", process.env.DSH_PROFILE ?? "desktop", "node_modules"),
  join(dshHome(), "profiles", "node_modules"),
].map((dir) => `${dir.replaceAll("\\", "/")}/`);

/** Packages that live in the app bundle, keyed by specifier. */
const IN_APP = ["@deepseek-ai/cordis", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-commands"];

/** Subpath overrides for packages whose entry point is not `lib/index.js`. */
const ENTRY = {
  "@deepseek-ai/schemastery": "lib/index.cjs",
};

/** Resolve one specifier to a file URL, or `undefined` when we do not own it. */
function map(specifier) {
  const roots = IN_APP.includes(specifier) ? [...APP_ROOTS, ...PROFILE_ROOTS] : PROFILE_ROOTS;
  const entry = ENTRY[specifier] ?? "lib/index.js";
  for (const root of roots) {
    const candidate = `${root}${specifier}/${entry}`;
    if (existsSync(candidate)) return `file:///${candidate}`;
  }
  // Last resort: let Node resolve it from the profile, which is where a real
  // DSH install puts it.
  for (const root of PROFILE_ROOTS) {
    if (!existsSync(root)) continue;
    try {
      const resolved = createRequire(`${root}_`)?.resolve?.(specifier);
      if (typeof resolved === "string") return `file:///${resolved.replaceAll("\\", "/")}`;
    } catch {
      // Fall through to the next root.
    }
  }
  return undefined;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@deepseek-ai/")) {
    const mapped = map(specifier);
    // No explicit `format`: let Node infer it from the target extension so the
    // CJS schemastery build still gets default-export interop.
    if (mapped !== undefined) return { url: mapped, shortCircuit: true };
  }
  return next(specifier, context);
}
