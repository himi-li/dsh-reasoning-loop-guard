/**
 * dsh-reasoning-loop-guard — the log route (host half).
 *
 * Serves the fire journal over HTTP so the browser half can render it as a card
 * on the plugin page. The guard itself never depends on this route: it rides a
 * scoped `ctx.inject(["webServer"], …)` in `./index.js`, so a headless or tui
 * profile simply never calls {@link registerLogRoute} and the plugin stays
 * exactly as useful as it was before the card existed.
 *
 * Two things are worth stating because they are easy to get wrong:
 *
 *  1. **The fence is ours to write.** `@deepseek-ai/dsh-host-webserver` is
 *     explicit that it "provides no server-level TLS, auth, or origin policy".
 *     The server listens on loopback, but any page in the same browser can
 *     still reach it, so every request is checked for a loopback `Host`, a
 *     non-`cross-site` fetch metadata hint, and — when an `Origin` is present —
 *     an origin matching that host. Anything else gets 403 and no data.
 *  2. **Reads are bounded, writes are explicit.** The journal is capped by its
 *     own rotation, and the route additionally clamps `limit` so one request
 *     can never pull an unbounded payload into the page.
 *
 * The handler is a pure function of the journal handle and the request, which
 * keeps the whole surface unit-testable without booting a server.
 *
 * @module dsh-reasoning-loop-guard/log-route
 */

/** Absolute path the card fetches; document-relative use aside, it is fixed. */
export const ROUTE_PATH = "/reasoning-loop-guard/log";

/** Route name registered with `ctx.webServer`. */
export const ROUTE_NAME = "reasoning-loop-guard-log";

/** Body returned with every refusal, so a stray caller learns nothing else. */
export const ROUTE_REFUSAL = "request refused: this route answers same-origin loopback only";

/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 16 * 1024;

/** Entries returned when the caller does not ask for a specific count. */
const DEFAULT_LIMIT = 50;

/** Hard ceiling on entries per response, whatever the caller asks for. */
const MAX_LIMIT = 500;

/** Rules the card may filter by; anything else is ignored, not an error. */
const RULES = ["periodic-run", "kgram-repeat"];

/**
 * Whether a URL hostname names the local machine.
 * @param hostname - hostname from a parsed URL (IPv6 keeps its brackets).
 * @returns whether the name is loopback.
 */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== "string" || hostname === "") return false;
  if (hostname === "localhost") return true;
  if (hostname === "[::1]" || hostname === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return v4 !== null && v4[1] === "127";
}

/**
 * Apply the same-origin loopback fence to one request.
 * @param req - Node request (only `headers` is read).
 * @returns whether the request may be answered.
 */
export function isTrustedRequest(req) {
  const host = req?.headers?.host;
  if (typeof host !== "string" || host === "") return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * Clamp a caller-supplied limit into the accepted range.
 * @param value - raw `limit` from the query string.
 * @returns a positive entry count no larger than {@link MAX_LIMIT}.
 */
function clampLimit(value) {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Read one optional string parameter, treating blanks as absent.
 * @param search - parsed query string.
 * @param key - parameter name.
 * @returns the trimmed value, or undefined.
 */
function optional(search, key) {
  const raw = search.get(key);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Collect a request body, refusing anything oversized.
 * @param req - Node request.
 * @returns the raw body text.
 * @throws {Error} when the body exceeds {@link MAX_BODY_BYTES}.
 */
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Build the route handler over one journal handle.
 *
 * `GET` answers the card's read: journal identity plus the newest entries and
 * the maintenance counters, filtered by the query string. `POST` accepts the
 * single explicit mutation, `{"action":"clear"}`, because clearing is
 * destructive and must not be reachable by a link or a prefetch.
 *
 * @param options - the journal handle, plus identity for the response.
 * @returns an async `(req, res) => void` handler for `ctx.webServer.register`.
 */
export function createLogRouteHandler({ journal, pluginVersion, enabled = true }) {
  return async function handle(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!isTrustedRequest(req)) {
      send(403, { error: ROUTE_REFUSAL });
      return;
    }

    if (req.method === "GET") {
      try {
        const search = new URL(req.url ?? ROUTE_PATH, "http://localhost").searchParams;
        const rule = optional(search, "rule");
        const sessionId = optional(search, "sessionId");
        const sinceRaw = optional(search, "since");
        const since = sinceRaw === undefined ? undefined : Number(sinceRaw);
        const result = journal.read({
          limit: clampLimit(search.get("limit")),
          ...(rule !== undefined && RULES.includes(rule) ? { rule } : {}),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(Number.isFinite(since) ? { since } : {}),
        });
        send(200, {
          path: journal.path,
          enabled: journal.enabled === true && enabled === true,
          ...(pluginVersion === undefined ? {} : { version: pluginVersion }),
          stats: journal.stats(),
          total: result.total,
          matched: result.matched,
          entries: result.entries,
        });
      } catch (error) {
        send(500, { error: String(error?.message ?? error) });
      }
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "GET, POST" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      send(413, { error: String(error?.message ?? error) });
      // Stop reading, so an oversized body cannot keep buffering after we have
      // already answered. Best-effort: the answer above is the contract.
      if (typeof req.destroy === "function") req.destroy();
      return;
    }
    let payload;
    try {
      payload = body.trim() === "" ? {} : JSON.parse(body);
    } catch {
      send(400, { error: "request body must be JSON" });
      return;
    }
    if (payload?.action !== "clear") {
      send(400, { error: "unsupported action" });
      return;
    }
    send(200, { action: "clear", removed: journal.clear() === true, path: journal.path });
  };
}

/**
 * Register the log route on the web server service.
 *
 * Called from inside `ctx.inject(["webServer"], …)`, so `ctx.webServer` is
 * present by construction. A duplicate registration throws inside cordis; the
 * caller wraps this so one bad route can never take the plugin down.
 *
 * @param ctx - the injected scope carrying `webServer`.
 * @param options - passed through to {@link createLogRouteHandler}.
 * @returns the route disposer.
 */
export function registerLogRoute(ctx, options) {
  return ctx.webServer.register({
    name: ROUTE_NAME,
    kind: "exact",
    path: ROUTE_PATH,
    handler: createLogRouteHandler(options),
  });
}
