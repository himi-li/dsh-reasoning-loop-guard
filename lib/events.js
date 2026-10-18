/**
 * dsh-reasoning-loop-guard — the fire channel and its SSE route (host half).
 *
 * The log card answers "what does the journal hold" on demand. This module
 * answers a different question: "the guard just aborted my stream — tell me
 * now". Polling the journal could not do that without either a short interval
 * (a request every second per open page) or a lag the user would read as the
 * abort having come from somewhere else.
 *
 * So the host keeps a small in-process fan-out, and the browser half holds one
 * `EventSource` per page. Two properties are deliberate:
 *
 *  1. **The channel is not the journal.** A firing is published whether or not
 *     the journal is enabled, and a journal write failure must not swallow the
 *     notification. The journal is a post-mortem record; this is a live signal.
 *  2. **Every subscriber is isolated.** A listener that throws is dropped with a
 *     warning rather than propagating back into the guard's stream middleware,
 *     where an exception would surface as a broken stream instead of a loop.
 *
 * The fence is the log route's, reused rather than re-derived: the server has
 * no auth of its own (see `./log-route.js`), so an SSE endpoint reachable from
 * any page in the same browser would otherwise leak the fact that a given
 * profile is aborting streams, along with the record's previews.
 *
 * @module dsh-reasoning-loop-guard/events
 */

import { isTrustedRequest, ROUTE_REFUSAL } from "./log-route.js";

/** Absolute path the browser half subscribes to. */
export const EVENTS_PATH = "/reasoning-loop-guard/events";

/** Route name registered with `ctx.webServer`. */
export const EVENTS_NAME = "reasoning-loop-guard-events";

/** Comment line written every so often so a dead connection is noticed. */
const HEARTBEAT_MS = 25_000;

/** Reconnect delay hinted to the browser, in milliseconds. */
const RETRY_MS = 5_000;

/**
 * Create the in-process fan-out for firings.
 *
 * Subscriptions are returned as disposers, because the SSE handler is closed by
 * the socket rather than by an answer: the caller has to be able to detach.
 *
 * @returns a channel with `subscribe`, `publish` and `size`.
 */
export function createFireChannel() {
  const listeners = new Set();

  return {
    /**
     * Attach one listener.
     * @param listener - called with each published record.
     * @returns the disposer removing it.
     */
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Fan one record out to every listener.
     *
     * A listener that throws is removed: it would throw again on the next
     * firing, and this function is called from the middleware that is already
     * in the middle of aborting a stream. Never let a display problem become a
     * stream problem.
     *
     * @param record - the journal record for this firing.
     */
    publish(record) {
      for (const listener of listeners) {
        try {
          listener(record);
        } catch {
          listeners.delete(listener);
        }
      }
    },

    /** @returns how many listeners are attached right now. */
    size() {
      return listeners.size;
    },
  };
}

/**
 * Build the SSE handler over one fire channel.
 *
 * The handler owns the response for as long as the page stays connected, so it
 * never calls `end()`. Teardown has three triggers, all of which unsubscribe:
 * the socket closing, the connection erroring, and the returned disposer being
 * called (which happens when the plugin unloads).
 *
 * `muted` is read per firing rather than captured once, because the switch is
 * saved to a file and takes effect on the next request — a channel that
 * captured it at registration would keep notifying after the user turned it
 * off, which reads as the switch being broken.
 *
 * @param options - `{ channel, muted?, heartbeatMs? }`.
 * @returns `{ handler, close }`, where `close` drops every live connection.
 */
export function createFireStream(options) {
  const { channel, muted = () => false, heartbeatMs = HEARTBEAT_MS } = options;
  const connections = new Set();

  /** Stop one connection and detach its subscription. */
  const release = (state) => {
    if (connections.delete(state) === false) return;
    clearInterval(state.timer);
    state.unsubscribe();
    try {
      state.res.destroy();
    } catch {
      // Already gone; the set no longer references it either way.
    }
  };

  const handler = (req, res) => {
    if (!isTrustedRequest(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: ROUTE_REFUSAL }));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json", allow: "GET" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // A comment first, so a proxy or the browser knows the stream is open
    // before the first firing arrives, and a `retry:` hint so a dropped page
    // reconnects on our schedule rather than the browser's default.
    res.write(": connected\n\n");
    res.write(`retry: ${String(RETRY_MS)}\n\n`);

    const state = {
      res,
      timer: null,
      unsubscribe: () => {},
    };
    state.unsubscribe = channel.subscribe((record) => {
      // Checked here, not at subscribe time: the mute switch is a file the
      // route re-reads, and it must apply to a page that is already open.
      if (muted() === true) return;
      try {
        res.write(`data: ${JSON.stringify({ type: "fire", record })}\n\n`);
      } catch {
        release(state);
      }
    });
    state.timer = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        release(state);
      }
    }, heartbeatMs);
    // A heartbeat must never hold the process open on its own.
    if (typeof state.timer.unref === "function") state.timer.unref();
    connections.add(state);

    res.on("close", () => release(state));
    res.on("error", () => release(state));
  };

  /** Drop every live stream; called when the plugin unloads. */
  const close = () => {
    for (const state of [...connections]) release(state);
  };

  return { handler, close };
}

/**
 * Register the event route on the web server service.
 *
 * Called from inside `ctx.inject(["webServer"], …)`, so `ctx.webServer` is
 * present by construction. The disposer both removes the route and tears down
 * the connections it owns: a route that is gone must not leave a live socket
 * writing to nowhere.
 *
 * @param ctx - the injected scope carrying `webServer`.
 * @param options - `{ channel, muted?, heartbeatMs? }`.
 * @returns the route disposer.
 */
export function registerEventRoute(ctx, options) {
  const { handler, close } = createFireStream(options);
  const disposeRoute = ctx.webServer.register({
    name: EVENTS_NAME,
    kind: "exact",
    path: EVENTS_PATH,
    handler,
  });
  return () => {
    disposeRoute();
    close();
  };
}
