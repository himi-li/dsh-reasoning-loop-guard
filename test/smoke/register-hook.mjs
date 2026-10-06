/**
 * Resolve `@deepseek-ai/*` the way the DSH host does (from the app / profile
 * node_modules) so `lib/index.js` can be exercised outside a real DSH boot.
 *
 * Usage: node --import ./test/smoke/register-hook.mjs test/smoke/smoke.mjs
 */
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("./resolve-hook.mjs", import.meta.url);
