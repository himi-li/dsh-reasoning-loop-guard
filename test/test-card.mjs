/**
 * Offline validation of the pluggable log route and the browser-half card.
 *
 * Both halves are written so they can be exercised with no server, no browser
 * and no build step: the route handler is a pure function of the journal handle
 * and a request, and the card exposes its pure formatting helpers under
 * `__card`. Everything here runs against a temp directory.
 *
 * Run: node test/test-card.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "../lib/journal.js";
import {
  ROUTE_NAME,
  ROUTE_PATH,
  ROUTE_REFUSAL,
  createLogRouteHandler,
  isLoopbackHost,
  isTrustedRequest,
  registerLogRoute,
} from "../lib/log-route.js";

let failures = 0;
const check = (ok, label) => {
  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
};

const scratch = mkdtempSync(join(tmpdir(), "rlg-card-"));
const journalPath = join(scratch, "fires.jsonl");
const warnings = [];
const journal = createJournal({
  path: journalPath,
  maxBytes: 64 * 1024,
  previewChars: 40,
  warn: (message) => warnings.push(message),
});

console.log("--- 1. same-origin fence ---");
check(isLoopbackHost("127.0.0.1") === true, "127.0.0.1 is loopback");
check(isLoopbackHost("127.9.9.9") === true, "the whole 127/8 block is loopback");
check(isLoopbackHost("localhost") === true, "localhost is loopback");
check(isLoopbackHost("[::1]") === true, "IPv6 loopback is loopback");
check(isLoopbackHost("192.168.1.10") === false, "a LAN address is not loopback");
check(isLoopbackHost("example.com") === false, "a public name is not loopback");
check(isLoopbackHost("") === false, "an empty host is not loopback");
check(isLoopbackHost(undefined) === false, "a missing host is not loopback");
check(isTrustedRequest({ headers: { host: "127.0.0.1:43120" } }) === true, "a plain loopback request is trusted");
check(isTrustedRequest({ headers: { host: "127.0.0.1:43120", origin: "http://127.0.0.1:43120" } }) === true, "a same-origin Origin is trusted");
check(isTrustedRequest({ headers: { host: "127.0.0.1:43120", origin: "http://evil.example" } }) === false, "a foreign Origin is refused");
check(isTrustedRequest({ headers: { host: "127.0.0.1:43120", "sec-fetch-site": "cross-site" } }) === false, "a cross-site fetch is refused");
check(isTrustedRequest({ headers: { host: "evil.example" } }) === false, "a non-loopback Host is refused");
check(isTrustedRequest({ headers: {} }) === false, "a missing Host is refused");
check(isTrustedRequest({ headers: { host: "not a host" } }) === false, "an unparsable Host is refused");

/** A minimal stand-in for a Node request. */
const fakeRequest = ({ method = "GET", url = ROUTE_PATH, headers = {}, body, onDestroy } = {}) => ({
  method,
  url,
  headers: { host: "127.0.0.1:43120", ...headers },
  destroy: () => {
    if (typeof onDestroy === "function") onDestroy();
  },
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(body, "utf8");
  },
});

/** A minimal stand-in for a Node response that records what was written. */
const fakeResponse = () => {
  const out = { status: 0, headers: null, body: "" };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(text) {
      out.body = text ?? "";
    },
    destroy() {},
  };
};

/** Drive the handler once and parse the answer. */
const call = async (handler, request) => {
  const response = fakeResponse();
  await handler(request, response);
  let json;
  try {
    json = JSON.parse(response.out.body);
  } catch {
    json = null;
  }
  return { ...response.out, json };
};

const handler = createLogRouteHandler({ journal, pluginVersion: "0.1.0" });

console.log("\n--- 2. route identity ---");
check(ROUTE_PATH === "/reasoning-loop-guard/log", "route path is the one the card fetches");
check(ROUTE_NAME === "reasoning-loop-guard-log", "route name is stable");
check(typeof ROUTE_REFUSAL === "string" && ROUTE_REFUSAL !== "", "refusal message is defined");

console.log("\n--- 3. refusals happen before any data ---");
{
  const refused = await call(handler, fakeRequest({ headers: { host: "evil.example" } }));
  check(refused.status === 403, "a foreign Host gets 403");
  check(refused.json?.error === ROUTE_REFUSAL, "the refusal body carries the fence message");
  check(refused.json?.entries === undefined, "a refused request leaks no entries");
  check(refused.json?.path === undefined, "a refused request leaks no path");
}
{
  const refused = await call(handler, fakeRequest({ headers: { origin: "http://evil.example" } }));
  check(refused.status === 403, "a foreign Origin gets 403 on the real handler too");
}

console.log("\n--- 4. empty journal reads ---");
{
  const answer = await call(handler, fakeRequest());
  check(answer.status === 200, "an empty journal still answers 200");
  check(answer.json?.total === 0, "an empty journal reports zero on file");
  check(Array.isArray(answer.json?.entries) && answer.json.entries.length === 0, "an empty journal returns no entries");
  check(answer.json?.enabled === true, "the route reports the journal as enabled");
  check(answer.json?.version === "0.1.0", "the route reports the plugin version");
  check(answer.json?.path === journalPath, "the route reports the journal path");
  check(answer.json?.stats?.count === 0, "stats are present");
}

console.log("\n--- 5. records round-trip through the route ---");
const fire = (at, rule, model, countOrUnits) => journal.record({
  v: 1,
  at,
  iso: new Date(at).toISOString(),
  rule,
  sessionId: "sess-1",
  provider: "deepseek",
  model,
  atChars: 3072,
  ...(rule === "periodic-run"
    ? { units: countOrUnits, period: 64 }
    : { count: countOrUnits }),
  preview: "Let me write. Go. Emit. OK.",
  version: "0.1.0",
});
fire(1767225600000, "periodic-run", "deepseek-v4.1", 6);
fire(1767225660000, "kgram-repeat", "deepseek-v4.1", 20);
fire(1767225720000, "periodic-run", "other-model", 9);

{
  const answer = await call(handler, fakeRequest());
  check(answer.json?.total === 3, "all three records are on file");
  check(answer.json?.matched === 3, "all three match an unfiltered read");
  check(answer.json?.entries?.length === 3, "all three are returned");
  check(answer.json.entries[0].at === 1767225720000, "the newest record comes first");
  check(answer.json.entries[2].at === 1767225600000, "the oldest record comes last");
  check(answer.json?.stats?.count === 3, "stats count all three");
  check(answer.json?.stats?.byRule?.["periodic-run"] === 2, "stats count by rule");
  check(answer.json?.stats?.byModel?.["deepseek-v4.1"] === 2, "stats count by model");
}

console.log("\n--- 6. query parameters ---");
{
  const answer = await call(handler, fakeRequest({ url: `${ROUTE_PATH}?rule=periodic-run` }));
  check(answer.json?.matched === 2, "rule filter narrows the match count");
  check(answer.json?.total === 3, "the on-file total is unfiltered");
}
{
  const answer = await call(handler, fakeRequest({ url: `${ROUTE_PATH}?rule=nonsense` }));
  check(answer.json?.matched === 3, "an unknown rule is ignored, not an error");
}
{
  const answer = await call(handler, fakeRequest({ url: `${ROUTE_PATH}?sessionId=sess-1` }));
  check(answer.json?.matched === 3, "session filter accepts the matching session");
}
{
  const answer = await call(handler, fakeRequest({ url: `${ROUTE_PATH}?sessionId=other` }));
  check(answer.json?.matched === 0, "session filter rejects a different session");
}
{
  const answer = await call(handler, fakeRequest({ url: `${ROUTE_PATH}?limit=1` }));
  check(answer.json?.entries?.length === 1, "limit trims the returned entries");
  check(answer.json?.matched === 3, "limit leaves the match count intact");
}
{
  const answer = await call(handler, fakeRequest({ url: `${ROUTE_PATH}?limit=0` }));
  check(answer.json?.entries?.length === 3, "a zero limit falls back to the default");
}
{
  const answer = await call(handler, fakeRequest({ url: `${ROUTE_PATH}?limit=99999` }));
  check(answer.json?.entries?.length === 3, "an oversized limit is clamped, not refused");
}
{
  const answer = await call(handler, fakeRequest({ url: `${ROUTE_PATH}?since=1767225700000` }));
  check(answer.json?.matched === 1, "since keeps only newer records");
}

console.log("\n--- 7. methods and mutations ---");
{
  const answer = await call(handler, fakeRequest({ method: "DELETE" }));
  check(answer.status === 405, "an unsupported method gets 405");
  check(answer.headers?.allow === "GET, POST", "405 advertises the allowed methods");
}
{
  const answer = await call(handler, fakeRequest({ method: "POST", body: "not json" }));
  check(answer.status === 400, "a malformed body gets 400");
}
{
  const answer = await call(handler, fakeRequest({ method: "POST", body: JSON.stringify({ action: "nope" }) }));
  check(answer.status === 400, "an unsupported action gets 400");
  const after = await call(handler, fakeRequest());
  check(after.json?.total === 3, "a rejected action changes nothing");
}
{
  const answer = await call(handler, fakeRequest({ method: "POST", body: JSON.stringify({ action: "clear" }) }));
  check(answer.status === 200, "clear is accepted over POST");
  check(answer.json?.removed === true, "clear reports what it removed");
  const after = await call(handler, fakeRequest());
  check(after.json?.total === 0, "clear empties the journal");
  check(after.json?.stats?.count === 0, "clear empties the stats");
}
{
  const answer = await call(handler, fakeRequest({ method: "POST", body: JSON.stringify({ action: "clear" }) }));
  check(answer.json?.removed === false, "clearing an empty journal reports nothing removed");
}
{
  let destroyed = false;
  const answer = await call(
    handler,
    fakeRequest({ method: "POST", body: "x".repeat(20 * 1024), onDestroy: () => { destroyed = true; } }),
  );
  check(answer.status === 413, "an oversized body gets 413");
  check(destroyed === true, "an oversized body stops being read");
}

console.log("\n--- 8. a disabled journal says so ---");
{
  const offHandler = createLogRouteHandler({ journal: { ...journal, enabled: false } });
  const answer = await call(offHandler, fakeRequest());
  check(answer.json?.enabled === false, "a disabled journal is reported as disabled");
}
{
  const disabledInConfig = createLogRouteHandler({ journal, enabled: false });
  const answer = await call(disabledInConfig, fakeRequest());
  check(answer.json?.enabled === false, "the route-level switch also reports disabled");
}

console.log("\n--- 9. registration goes through the service ---");
{
  const registered = [];
  const ctx = { webServer: { register: (route) => { registered.push(route); return () => {}; } } };
  const dispose = registerLogRoute(ctx, { journal, pluginVersion: "0.1.0" });
  check(registered.length === 1, "exactly one route is registered");
  check(registered[0].path === ROUTE_PATH, "the route registers the card's path");
  check(registered[0].name === ROUTE_NAME, "the route registers its stable name");
  check(registered[0].kind === "exact", "the route is exact, not a prefix");
  check(typeof registered[0].handler === "function", "the route carries the handler");
  check(typeof dispose === "function", "registration returns the disposer");
}

console.log("\n--- 10. the browser half is a loadable lazy-CJS bundle ---");
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      loaded.push(entry);
      return entry;
    },
  },
};
await import(new URL("../lib/client.js", import.meta.url).href);
check(loaded.length === 1, "the bundle loads exactly one module");
check(loaded[0]?.id === "dsh-reasoning-loop-guard", "the bundle declares its package id");
check(typeof loaded[0]?.factory === "function", "the bundle declares a factory");
const card = loaded[0].factory((name) => {
  throw new Error(`unexpected require(${name})`);
});
check(typeof card.apply === "function", "the bundle exports apply");
check(Array.isArray(card.inject) && card.inject.length === 0, "no hard inject: optional services ride scoped injects");
check(card.name === "reasoning-loop-guard-log-card", "the bundle names itself");
check(source.includes("window.__ModuleLoader__.load"), "the source uses the lazy-CJS protocol");
check(!/\bimport\s/.test(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "the bundle uses no ESM imports");

console.log("\n--- 11. card helpers ---");
const helpers = card.__card;
check(helpers.ROUTE === "/reasoning-loop-guard/log", "the card fetches the host route");
check(helpers.PAGE_LIMIT === 50, "the card asks for one page");
check(helpers.labelsFor("zh") === helpers.STRINGS.zh, "zh selects the Chinese dictionary");
check(helpers.labelsFor("zh-CN") === helpers.STRINGS.zh, "zh-CN also selects Chinese");
check(helpers.labelsFor("en") === helpers.STRINGS.en, "en selects the English dictionary");
check(helpers.labelsFor(undefined) === helpers.STRINGS.en, "an absent language falls back to English");
check(helpers.labelsFor("ja") === helpers.STRINGS.en, "an unknown language falls back to English");
for (const key of Object.keys(helpers.STRINGS.en)) {
  check(typeof helpers.STRINGS.zh[key] === "string", `zh covers the ${key} label`);
}
check(helpers.fill("{a} of {b}", { a: 1, b: 2 }) === "1 of 2", "fill substitutes every placeholder");
check(helpers.fill("{a} {missing}", { a: 1 }) === "1 {missing}", "fill leaves unknown placeholders alone");
check(helpers.formatWhen({ iso: "2026-10-06T12:34:56.789Z" }) === "2026-10-06 12:34:56", "formatWhen trims an ISO stamp");
check(helpers.formatWhen({ at: 1767225600000 }) === "2026-01-01 00:00:00", "formatWhen falls back to the epoch");
check(helpers.formatWhen(undefined) === "?", "formatWhen survives a missing record");
check(helpers.measureOf({ rule: "periodic-run", period: 64, units: 6 }) === "period=64 · units=6", "measureOf reports a periodic run");
check(helpers.measureOf({ rule: "kgram-repeat", count: 20 }) === "count=20", "measureOf reports a k-gram repeat");
check(helpers.measureOf(undefined) === "", "measureOf survives a missing record");
check(helpers.whereOf({ provider: "deepseek", model: "v4" }) === "deepseek / v4", "whereOf joins provider and model");
check(helpers.whereOf({ model: "v4" }) === "v4", "whereOf tolerates a missing provider");
check(helpers.whereOf({}) === "—", "whereOf shows a dash when both are missing");
check(helpers.isEmpty({ entries: [] }) === true, "an empty list reads as empty");
check(helpers.isEmpty({ entries: [{ at: 1 }] }) === false, "a populated list does not");
check(helpers.isEmpty(null) === true, "a missing summary reads as empty");
check(helpers.countsText({ a: 2, b: 1 }) === "a × 2  ·  b × 1", "countsText renders a counter map");
check(helpers.countsText({}) === "—", "countsText shows a dash for no counters");
check(helpers.countsText(undefined) === "—", "countsText survives a missing map");

console.log("\n--- 12. the card renders ---");
{
  // A tiny React stand-in: enough of the API for the card, and it records the
  // element tree so the test can assert on what a user would actually see.
  const hooks = [];
  let cursor = 0;
  const fakeReact = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat().filter((child) => child !== null && child !== undefined),
    }),
    useState: (initial) => {
      if (cursor < hooks.length) return hooks[cursor++];
      const slot = [initial, (value) => { slot[0] = value; }];
      hooks.push(slot);
      cursor += 1;
      return slot;
    },
    useRef: (initial) => {
      if (cursor < hooks.length) return hooks[cursor++];
      const slot = { current: initial };
      hooks.push(slot);
      cursor += 1;
      return slot;
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, read) => read(),
  };
  const fakeUi = {
    Button: function Button() {},
    IconRefreshOutlineMedium: function IconRefreshOutlineMedium() {},
    writeClipboard: () => Promise.resolve(),
  };
  const View = helpers.LoopGuardCard(fakeReact, fakeUi, { current: null });
  cursor = 0;
  hooks.length = 0;
  const tree = View({ view: "page" });
  check(tree !== null && tree !== undefined, "the card renders a tree");
  const seen = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string" || typeof node === "number") {
      seen.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(tree);
  const text = seen.join(" | ");
  check(text.includes(helpers.STRINGS.en.title) === false, "the page view omits the card's own title");
  check(seen.some((piece) => piece.includes("Fire journal") || piece.includes("Trigger") || piece.includes("Loading")), "the card renders status copy");
  check(typeof View({ view: "summary" }) === "object", "the summary view renders its own frame");
}

rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CARD CHECKS PASSED" : `\n${failures} CARD CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
