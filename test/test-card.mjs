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
check(helpers.PAGE_LIMIT === 100, "the card asks for one page, capped at a hundred records");
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
check(helpers.measureOf({ rule: "block-repeat", blockLen: 120, count: 3 }) === "block=120 · reuses=3", "measureOf reports a repeated block");
check(helpers.measureOf({ rule: "line-repeat", lineLen: 14, count: 2 }) === "line=14 · reuses=2", "measureOf reports a repeated line");
check(helpers.measureOf({ rule: "kgram-repeat", count: 20 }) === "count=20", "measureOf reports a k-gram repeat");
check(helpers.measureOf({ rule: "filler-run", count: 4000 }) === "run=4000 chars", "measureOf reports a decoration run");
check(helpers.measureOf(undefined) === "", "measureOf survives a missing record");
check(
  helpers.REPEAT_RULES.join(",") === "periodic-run,block-repeat,line-repeat,kgram-repeat,filler-run",
  "the card knows every rule the journal can carry",
);
check(helpers.detailOf(undefined) === "", "detailOf survives a missing record");
check(helpers.detailOf({}) === "", "detailOf stays empty for an old record");
{
  const line = helpers.detailOf({
    turn: 61,
    step: 12,
    reasoningEffort: "max",
    maxTokens: 32000,
    temperature: 0.6,
    elapsedMs: 205000,
    reasoningChars: 20692,
    cwd: "C:\\work\\proj",
  });
  check(line.includes("turn=61") && line.includes("step=12"), "detailOf reports the turn and step");
  check(line.includes("effort=max") && line.includes("maxTokens=32000"), "detailOf reports the request settings");
  check(line.includes("elapsed=205000ms") && line.includes("reasoning=20692chars"), "detailOf reports the timing");
  check(line.includes("cwd=C:\\work\\proj"), "detailOf reports the working directory");
  check(helpers.detailOf({ turn: 0 }) === "turn=0", "detailOf keeps a zero-valued field");
}
{
  const line = helpers.detailOf({ elapsedMs: 205000, ttftMs: 1200, reasoningChars: 20692 });
  check(line.includes("ttft=1200ms"), "detailOf separates time-to-first-token from the loop");
}
check(helpers.originOf(undefined) === "", "originOf survives a missing record");
check(helpers.originOf({}) === "", "originOf stays empty for an old record");
{
  const line = helpers.originOf({
    failureCode: "REASONING_LOOP",
    attemptId: "attempt-7",
    sessionId: "session-abc",
    purpose: "chat",
    pluginVersion: "0.2.0",
    fromStartMs: 206200,
  });
  check(line.includes("code=REASONING_LOOP"), "originOf reports the failure code");
  check(line.includes("attempt=attempt-7") && line.includes("session=session-abc"), "originOf reports the attempt identity");
  check(line.includes("purpose=chat") && line.includes("version=0.2.0"), "originOf reports the purpose and build");
  check(line.includes("sinceStart=206200ms"), "originOf reports the total stream lifetime");
  check(
    helpers.originOf({ attemptId: 0, turn: 3 }).includes("attempt=0"),
    "originOf keeps a zero-valued field",
  );
  check(helpers.originOf({ aborted: true }).includes("aborted=user"), "originOf marks a user abort");
  check(!helpers.originOf({ aborted: false }).includes("aborted"), "originOf stays quiet without an abort");
}
check(helpers.thresholdsOf(undefined) === "", "thresholdsOf survives a missing record");
check(helpers.thresholdsOf({}) === "", "thresholdsOf stays empty when no snapshot was taken");
check(helpers.thresholdsOf({ thresholds: {} }) === "", "thresholdsOf stays empty for an empty snapshot");
check(
  helpers.thresholdsOf({ thresholds: { minChars: 800, minUnits: 4 } }) === "minChars=800  ·  minUnits=4",
  "thresholdsOf renders the snapshot in force",
);
check(helpers.previewText("abc") === "abc", "previewText passes real material through");
check(helpers.previewText("") === "", "previewText drops an empty preview");
check(helpers.previewText(undefined) === "", "previewText survives a missing preview");
{
  // The real firing recorded on this machine had an eight-space preview, which
  // used to render as an empty pair of quotes.
  const shown = helpers.previewText("        ", { blankPreview: "whitespace only" });
  check(shown === "whitespace only (8)", `previewText labels whitespace-only material (got ${JSON.stringify(shown)})`);
  check(
    helpers.previewText("   ", helpers.STRINGS.zh).startsWith("纯空白"),
    "previewText falls back to the active dictionary",
  );
}
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
    Switch: function Switch() {},
    Input: function Input() {},
    SegmentedControl: function SegmentedControl() {},
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

console.log("\n--- 13. the settings panel renders from a loaded store ---");
{
  // The panel only exists once the route has answered, so this drives the real
  // component through a mount: the effect runs, the stubbed fetch resolves, and
  // the card is re-rendered with the persisted hooks in place. That is the only
  // way to prove the panel is reachable rather than merely present in source.
  const PAYLOAD = {
    path: "C:\\state\\fires.jsonl",
    enabled: true,
    version: "0.2.0",
    stats: { count: 0, byRule: {}, byModel: {}, earliest: null, latest: null },
    total: 0,
    matched: 0,
    entries: [],
    settings: {
      path: "C:\\state\\config.json",
      values: {
        enabled: true,
        "recovery.enabled": false,
        "recovery.message": "",
        "recovery.maxRetries": 2,
        "effort.enabled": false,
        "effort.value": "low",
        "stripHistory.enabled": false,
      },
      stored: {},
      keys: ["enabled", "recovery.enabled"],
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(PAYLOAD) });

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
      const slot = [initial, (value) => {
        slot[0] = typeof value === "function" ? value(slot[0]) : value;
      }];
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
    useCallback: (fn) => {
      if (cursor < hooks.length) return hooks[cursor++];
      hooks.push(fn);
      cursor += 1;
      return fn;
    },
    useEffect: (fn) => {
      if (cursor < hooks.length) {
        cursor += 1;
        return;
      }
      hooks.push(null);
      cursor += 1;
      fn();
    },
    useSyncExternalStore: (_subscribe, read) => read(),
  };
  const ui = {
    Button: function Button() {},
    IconRefreshOutlineMedium: function IconRefreshOutlineMedium() {},
    Switch: function Switch() {},
    Input: function Input() {},
    SegmentedControl: function SegmentedControl() {},
    writeClipboard: () => Promise.resolve(),
  };

  const render = (View) => {
    cursor = 0;
    return View({ view: "page" });
  };
  /** The display name of an element's component, or its tag for a host node. */
  const nameOf = (node) =>
    typeof node.type === "string" ? node.type : (node.type && node.type.name) || "";
  const types = (node, out = []) => {
    if (node === null || node === undefined) return out;
    if (typeof node === "string" || typeof node === "number") return out;
    if (Array.isArray(node)) {
      node.forEach((child) => types(child, out));
      return out;
    }
    if (typeof node.type === "function" || typeof node.type === "string") out.push(nameOf(node));
    if (Array.isArray(node.children)) node.children.forEach((child) => types(child, out));
    return out;
  };
  const propsOf = (node, name, out = []) => {
    if (node === null || node === undefined || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      node.forEach((child) => propsOf(child, name, out));
      return out;
    }
    // The stand-in keeps children beside the props, so a lookup returns both.
    if (nameOf(node) === name) out.push({ props: node.props, children: node.children ?? [] });
    if (Array.isArray(node.children)) node.children.forEach((child) => propsOf(child, name, out));
    return out;
  };
  /** The rendered text of one element, flattened. */
  const textOf = (entry) => {
    const out = [];
    const walk = (node) => {
      if (typeof node === "string" || typeof node === "number") out.push(String(node));
      else if (Array.isArray(node)) node.forEach(walk);
    };
    walk(entry.children);
    return out.join("");
  };

  const View = helpers.LoopGuardCard(fakeReact, ui, { current: null });
  render(View);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const loaded = render(View);

  const loadedTypes = types(loaded);
  check(loadedTypes.includes("Switch"), "a loaded store renders the toggles");
  const labels = propsOf(loaded, "Switch").map((entry) => entry.props.label);
  check(labels.includes(helpers.STRINGS.en.coreLabel), "the core guard switch is offered");
  check(labels.includes(helpers.STRINGS.en.recoveryLabel), "the recovery toggle is offered");
  check(labels.includes(helpers.STRINGS.en.effortLabel), "the effort toggle is offered");
  check(labels.includes(helpers.STRINGS.en.stripLabel), "the history-strip toggle is offered");
  const switches = propsOf(loaded, "Switch");
  check(
    switches.some(
      (entry) => entry.props.label === helpers.STRINGS.en.coreLabel && entry.props.checked === true,
    ),
    "the core guard reads back armed, as its default promises",
  );
  check(
    switches
      .filter((entry) => entry.props.label !== helpers.STRINGS.en.coreLabel)
      .every((entry) => entry.props.checked === false),
    "every opt-in arm starts off, as the defaults promise",
  );
  check(
    propsOf(loaded, "Input").length === 0,
    "the recovery inputs stay hidden while recovery is off",
  );

  // Flip recovery on the way the panel does, then re-render: the message and
  // retry inputs appear, and the save button turns live.
  hooks[4][1]((current) => Object.assign({}, current, { "recovery.enabled": true }));
  const on = render(View);
  const inputs = propsOf(on, "Input").map((entry) => entry.props);
  check(inputs.length === 2, "enabling recovery reveals the message and retry inputs");
  check(
    inputs.some((props) => props.placeholder === helpers.STRINGS.en.recoveryMessagePlaceholder),
    "the message input carries its placeholder",
  );
  check(
    inputs.some((props) => props.type === "number" && props.max === 10),
    "the retry input is a bounded number field",
  );
  const buttons = propsOf(on, "Button").map(textOf);
  check(buttons.includes(helpers.STRINGS.en.save), "the panel offers a save button");
  check(
    buttons.includes(helpers.STRINGS.en.refresh),
    "the journal toolbar is still there beside the panel",
  );
  check(
    propsOf(on, "Switch").some(
      (entry) => entry.props.label === helpers.STRINGS.en.recoveryLabel && entry.props.checked === true,
    ),
    "the flipped toggle reads back as on",
  );

  globalThis.fetch = originalFetch;
}

console.log("\n--- 14. one rendered record shows everything the journal kept ---");
{
  // The point of this section is the user-visible complaint: the panel showed a
  // timestamp, a rule and a measure, and nothing else. So drive a real mount
  // with one rich record and assert on the text a reader would see.
  const ENTRY = {
    v: 1,
    at: 1767225600000,
    iso: "2026-01-01T00:00:00.000Z",
    rule: "periodic-run",
    atChars: 20692,
    failureCode: "REASONING_LOOP",
    pluginVersion: "0.2.0",
    sessionId: "session-abc",
    provider: "workbuddy",
    model: "deepseek-v4.1-flash",
    units: 4,
    period: 8,
    turn: 61,
    step: 12,
    attemptId: "attempt-7",
    reasoningEffort: "max",
    maxTokens: 32000,
    elapsedMs: 205000,
    ttftMs: 1200,
    fromStartMs: 206200,
    reasoningChars: 20692,
    cwd: "C:\\work\\proj",
    preview: "Let me write. Go. Emit. OK.",
    previewRaw: "Let me write.\nGo. Emit. OK.",
    thresholds: { minChars: 800, minUnits: 4 },
  };
  const PAYLOAD = {
    path: "C:\\state\\fires.jsonl",
    enabled: true,
    version: "0.2.0",
    stats: { count: 1, byRule: { "periodic-run": 1 }, byModel: {}, earliest: ENTRY.at, latest: ENTRY.at },
    total: 1,
    matched: 1,
    entries: [ENTRY],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(PAYLOAD) });

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
      const slot = [initial, (value) => {
        slot[0] = typeof value === "function" ? value(slot[0]) : value;
      }];
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
    useCallback: (fn) => {
      if (cursor < hooks.length) return hooks[cursor++];
      hooks.push(fn);
      cursor += 1;
      return fn;
    },
    useEffect: (fn) => {
      if (cursor < hooks.length) {
        cursor += 1;
        return;
      }
      hooks.push(null);
      cursor += 1;
      fn();
    },
    useSyncExternalStore: (_subscribe, read) => read(),
  };
  const ui = {
    Button: function Button() {},
    IconRefreshOutlineMedium: function IconRefreshOutlineMedium() {},
    Switch: function Switch() {},
    Input: function Input() {},
    SegmentedControl: function SegmentedControl() {},
    writeClipboard: () => Promise.resolve(),
  };

  /** Every string a reader would see, flattened. */
  const flatten = (node, out = []) => {
    if (node === null || node === undefined) return out;
    if (typeof node === "string" || typeof node === "number") {
      out.push(String(node));
      return out;
    }
    if (Array.isArray(node)) {
      node.forEach((child) => flatten(child, out));
      return out;
    }
    if (Array.isArray(node.children)) node.children.forEach((child) => flatten(child, out));
    return out;
  };

  const View = helpers.LoopGuardCard(fakeReact, ui, { current: null });
  cursor = 0;
  View({ view: "page" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  cursor = 0;
  const text = flatten(View({ view: "page" })).join(" | ");

  check(text.includes("2026-01-01 00:00:00"), "the record shows its timestamp");
  check(text.includes("periodic-run"), "the record shows its rule");
  check(text.includes("period=8") && text.includes("units=4"), "the record shows its measure");
  check(text.includes("20692"), "the record shows the offset it fired at");
  check(text.includes("workbuddy / deepseek-v4.1-flash"), "the record shows the route");
  check(text.includes("turn=61") && text.includes("step=12"), "the record shows the attempt position");
  check(text.includes("elapsed=205000ms"), "the record shows the loop duration");
  check(text.includes("ttft=1200ms"), "the record shows the time to first token");
  check(text.includes("reasoning=20692chars"), "the record shows the reasoning volume");
  check(text.includes("cwd=C:\\work\\proj"), "the record shows the working directory");
  check(text.includes("code=REASONING_LOOP"), "the record shows the failure code");
  check(text.includes("attempt=attempt-7"), "the record shows which attempt it was");
  check(text.includes("session=session-abc"), "the record shows which session it was");
  check(text.includes("version=0.2.0"), "the record shows which build caught it");
  check(text.includes("sinceStart=206200ms"), "the record shows the total stream lifetime");
  check(text.includes("Let me write. Go. Emit. OK."), "the record shows the repeating material");
  check(text.includes(helpers.STRINGS.en.previewLabel), "the preview is labelled");
  check(text.includes(helpers.STRINGS.en.rawLabel), "the raw tail is labelled");
  check(text.includes(helpers.STRINGS.en.thresholds), "the threshold block is labelled");
  check(text.includes("minChars=800") && text.includes("minUnits=4"), "the record shows the thresholds in force");
  check(text.includes("effort=max") && text.includes("maxTokens=32000"), "the record shows the request settings");
  check(text.includes("maxPeriod=400") === false, "a record does not invent fields it never stored");

  globalThis.fetch = originalFetch;
}

console.log("\n--- 15. the record list folds, newest open ---");
{
  // With a hundred records on screen an always-expanded list is unreadable, so
  // the rows fold. The newest fire is the one usually being explained, so it
  // starts open; every older row keeps its detail behind a click, and the
  // toolbar can open or close the whole list at once.
  const record = (index, rule) => ({
    v: 1,
    at: 1767225600000 - index * 1000,
    iso: new Date(1767225600000 - index * 1000).toISOString(),
    rule,
    atChars: 1000 + index,
    failureCode: "REASONING_LOOP",
    turn: index,
    step: 1,
    preview: `material-${index}`,
    thresholds: { minChars: 800 },
  });
  const ENTRIES = [record(0, "periodic-run"), record(1, "line-repeat"), record(2, "filler-run")];
  const PAYLOAD = {
    path: "C:\\state\\fires.jsonl",
    enabled: true,
    version: "0.2.0",
    stats: { count: 3, byRule: {}, byModel: {}, earliest: ENTRIES[2].at, latest: ENTRIES[0].at },
    total: 3,
    matched: 3,
    entries: ENTRIES,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(PAYLOAD) });

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
      const slot = [initial, (value) => {
        slot[0] = typeof value === "function" ? value(slot[0]) : value;
      }];
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
    useCallback: (fn) => {
      if (cursor < hooks.length) return hooks[cursor++];
      hooks.push(fn);
      cursor += 1;
      return fn;
    },
    useEffect: (fn) => {
      if (cursor < hooks.length) {
        cursor += 1;
        return;
      }
      hooks.push(null);
      cursor += 1;
      fn();
    },
    useSyncExternalStore: (_subscribe, read) => read(),
  };
  const ui = {
    Button: function Button() {},
    IconRefreshOutlineMedium: function IconRefreshOutlineMedium() {},
    Switch: function Switch() {},
    Input: function Input() {},
    SegmentedControl: function SegmentedControl() {},
    writeClipboard: () => Promise.resolve(),
  };

  const flatten = (node, out = []) => {
    if (node === null || node === undefined) return out;
    if (typeof node === "string" || typeof node === "number") {
      out.push(String(node));
      return out;
    }
    if (Array.isArray(node)) {
      node.forEach((child) => flatten(child, out));
      return out;
    }
    if (Array.isArray(node.children)) node.children.forEach((child) => flatten(child, out));
    return out;
  };

  const View = helpers.LoopGuardCard(fakeReact, ui, { current: null });
  cursor = 0;
  View({ view: "page" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  cursor = 0;
  const first = View({ view: "page" });
  const text = flatten(first).join(" | ");

  check(text.includes("periodic-run") && text.includes("line-repeat"), "every folded row still shows its header");
  check(text.includes("material-0"), "the newest record is open by default");
  check(text.includes("material-1") === false, "an older record keeps its detail folded");
  check(text.includes("material-2") === false, "and so does the oldest");
  check(text.includes("turn=0"), "the newest record shows its provenance");
  check(text.includes(helpers.STRINGS.en.expandAll), "the toolbar offers expand-all");
  check(text.includes(helpers.STRINGS.en.collapseAll), "the toolbar offers collapse-all");

  /** Find the props of the row whose header carries this preview marker. */
  const headerOf = (node, marker, out = []) => {
    if (node === null || node === undefined || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      node.forEach((child) => headerOf(child, marker, out));
      return out;
    }
    if (Array.isArray(node.children)) {
      if (node.props && node.props.onClick && flatten(node).includes(marker)) out.push(node.props);
      node.children.forEach((child) => headerOf(child, marker, out));
    }
    return out;
  };

  const rowHeaders = headerOf(first, "line-repeat");
  check(rowHeaders.length >= 1, "the folded row's header is clickable");
  check(rowHeaders[0]["aria-expanded"] === "false", "a folded row reports itself collapsed");
  rowHeaders[0].onClick();
  cursor = 0;
  const afterClick = flatten(View({ view: "page" })).join(" | ");
  check(afterClick.includes("material-1"), "clicking a folded row opens it");

  // The bulk controls must win over per-row choices, or "collapse all" would
  // silently leave the rows the user had opened still expanded.
  const buttons = [];
  const collectButtons = (node) => {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(collectButtons);
      return;
    }
    if (node.type === ui.Button && node.props && typeof node.props.onClick === "function") {
      buttons.push(node);
    }
    if (Array.isArray(node.children)) node.children.forEach(collectButtons);
  };
  // The hook cursor must be rewound before this render too, or the buttons
  // collected here close over a fresh set of state slots instead of the mounted
  // ones and clicking them changes nothing a later render can see.
  cursor = 0;
  collectButtons(View({ view: "page" }));
  const collapseAll = buttons.find((node) => flatten(node).includes(helpers.STRINGS.en.collapseAll));
  check(collapseAll !== undefined, "collapse-all is reachable");
  collapseAll.props.onClick();
  cursor = 0;
  const collapsed = flatten(View({ view: "page" })).join(" | ");
  check(collapsed.includes("material-0") === false, "collapse-all closes even the newest row");
  check(collapsed.includes("material-1") === false, "collapse-all closes a row the user had opened");

  // The list fold is the coarser control: it hides the rows themselves rather
  // than their details, so even the row headers disappear.
  cursor = 0;
  const listView = View({ view: "page" });
  const listText = flatten(listView).join(" | ");
  check(listText.includes(helpers.STRINGS.en.collapseList), "the toolbar offers the list fold");
  buttons.length = 0;
  cursor = 0;
  collectButtons(View({ view: "page" }));
  const listFold = buttons.find((node) => flatten(node).includes(helpers.STRINGS.en.collapseList));
  check(listFold !== undefined, "the list fold is reachable");
  listFold.props.onClick();
  cursor = 0;
  const foldedList = flatten(View({ view: "page" })).join(" | ");
  check(foldedList.includes("periodic-run") === false, "the list fold hides every row header");
  check(
    foldedList.includes(helpers.STRINGS.en.expandList),
    "the list fold turns into its expand counterpart",
  );

  globalThis.fetch = originalFetch;
}

rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CARD CHECKS PASSED" : `\n${failures} CARD CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
