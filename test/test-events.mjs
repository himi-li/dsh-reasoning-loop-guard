/**
 * Offline validation of the fire channel and its SSE route.
 *
 * The whole surface is a pure function of a channel and two Node streams, so
 * everything here runs with no server and no browser: a fake request/response
 * pair is enough to drive one connection from open to close.
 *
 * Run: node test/test-events.mjs
 */
import {
  EVENTS_NAME,
  EVENTS_PATH,
  createFireChannel,
  createFireStream,
  registerEventRoute,
} from "../lib/events.js";
import { ROUTE_REFUSAL } from "../lib/log-route.js";

let failures = 0;
const check = (ok, label) => {
  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${label}`);
  } else {
    console.log(`ok    ${label}`);
  }
};

/** A minimal stand-in for a Node request. */
const fakeRequest = ({ method = "GET", headers = {} } = {}) => ({
  method,
  headers: { host: "127.0.0.1:43120", ...headers },
});

/** A minimal stand-in for a Node response that records writes and handlers. */
const fakeResponse = () => {
  const out = { status: 0, headers: null, body: "", destroyed: false };
  const handlers = new Map();
  return {
    out,
    handlers,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    write(chunk) {
      out.body += chunk;
    },
    end(text) {
      out.body += text ?? "";
    },
    destroy() {
      out.destroyed = true;
    },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
    },
    emit(name) {
      for (const handler of handlers.get(name) ?? []) handler();
    },
  };
};

/** The `data:` payloads written so far, parsed. */
const frames = (response) =>
  response.out.body
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)));

console.log("--- 1. the channel is a fan-out, not a queue ---");
{
  const channel = createFireChannel();
  const first = [];
  const second = [];
  const detach = channel.subscribe((record) => first.push(record));
  channel.subscribe((record) => second.push(record));

  check(channel.size() === 2, "both listeners are attached");
  channel.publish({ rule: "line-repeat" });
  check(first.length === 1 && second.length === 1, "one publish reaches every listener");
  check(first[0].rule === "line-repeat", "the record arrives intact");

  detach();
  check(channel.size() === 1, "the disposer detaches its own listener");
  channel.publish({ rule: "periodic-run" });
  check(first.length === 1, "a detached listener hears nothing more");
  check(second.length === 2, "the other listener keeps hearing");

  let threw = false;
  try {
    channel.subscribe("not a function");
  } catch {
    threw = true;
  }
  check(threw, "a non-function listener is refused rather than stored");
}

console.log("\n--- 2. a throwing listener is dropped, never propagated ---");
{
  // This is the load-bearing property: publish() runs inside the stream
  // middleware that is already aborting a request. An exception escaping here
  // would replace the guard's own failure with an unrelated one.
  const channel = createFireChannel();
  const survivor = [];
  channel.subscribe(() => {
    throw new Error("display bug");
  });
  channel.subscribe((record) => survivor.push(record));

  let escaped = false;
  try {
    channel.publish({ rule: "block-repeat" });
  } catch {
    escaped = true;
  }
  check(escaped === false, "a throwing listener does not escape publish");
  check(survivor.length === 1, "the other listener still received the record");
  check(channel.size() === 1, "the thrower was removed");

  channel.publish({ rule: "block-repeat" });
  check(survivor.length === 2, "a later firing is not swallowed by the dead listener");
}

/** Open one stream and return its response plus the release handle. */
const openStream = (stream, { method = "GET", headers = {} } = {}) => {
  const response = fakeResponse();
  stream.handler(fakeRequest({ method, headers }), response);
  return response;
};

console.log("\n--- 3. the route answers one event stream ---");
{
  const channel = createFireChannel();
  const stream = createFireStream({ channel, heartbeatMs: 60_000 });

  const response = openStream(stream);
  check(response.out.status === 200, "a trusted GET opens the stream");
  check(
    response.out.headers["content-type"] === "text/event-stream",
    "the content type is the event-stream type",
  );
  check(response.out.headers["cache-control"] === "no-cache", "the stream is uncacheable");
  check(response.out.body.includes(": connected"), "an opening comment proves the stream is live");
  check(response.out.body.includes("retry:"), "a reconnect delay is hinted to the browser");
  check(channel.size() === 1, "the connection subscribed to the channel");

  channel.publish({ rule: "line-repeat", count: 5 });
  const sent = frames(response);
  check(sent.length === 1, "one firing becomes one frame");
  check(sent[0].type === "fire", "the frame names its kind");
  check(sent[0].record.rule === "line-repeat", "the frame carries the record");

  stream.close();
  check(response.out.destroyed === true, "closing the route tears the socket down");
  check(channel.size() === 0, "and detaches its subscription");
}

console.log("\n--- 4. the fence is the log route's fence ---");
{
  const channel = createFireChannel();
  const stream = createFireStream({ channel, heartbeatMs: 60_000 });

  const foreign = openStream(stream, { headers: { host: "evil.example" } });
  check(foreign.out.status === 403, "a non-loopback Host is refused");
  check(String(foreign.out.body).includes(ROUTE_REFUSAL), "the refusal reuses the shared message");
  check(channel.size() === 0, "a refused request never subscribes");

  const crossSite = openStream(stream, { headers: { "sec-fetch-site": "cross-site" } });
  check(crossSite.out.status === 403, "a cross-site fetch is refused");

  const post = openStream(stream, { method: "POST" });
  check(post.out.status === 405, "a mutating method is refused");
  check(post.out.headers.allow === "GET", "the refusal names the one allowed method");
  check(channel.size() === 0, "a refused method never subscribes");

  stream.close();
}

console.log("\n--- 5. a closed socket releases itself ---");
{
  const channel = createFireChannel();
  const stream = createFireStream({ channel, heartbeatMs: 60_000 });
  const response = openStream(stream);
  check(channel.size() === 1, "the connection is live");

  response.emit("close");
  check(channel.size() === 0, "the close handler detaches the subscription");
  check(response.out.destroyed === true, "and destroys the socket");

  // Releasing twice must be a no-op: `close` and `error` both fire on some
  // teardown paths, and a second unsubscribe must not throw.
  let threw = false;
  try {
    response.emit("error");
  } catch {
    threw = true;
  }
  check(threw === false, "a second release is harmless");
}

console.log("\n--- 6. the mute switch is re-read per firing ---");
{
  // The switch lives in a file the route re-reads, so a page opened before the
  // change must honour it. Capturing the value at subscribe time would leave the
  // user turning the switch off and still being interrupted.
  const channel = createFireChannel();
  let muted = false;
  const stream = createFireStream({ channel, muted: () => muted, heartbeatMs: 60_000 });
  const response = openStream(stream);

  channel.publish({ rule: "line-repeat" });
  check(frames(response).length === 1, "an unmuted firing is sent");

  muted = true;
  channel.publish({ rule: "periodic-run" });
  check(frames(response).length === 1, "a muted firing is not sent");

  muted = false;
  channel.publish({ rule: "block-repeat" });
  check(frames(response).length === 2, "unmuting takes effect on the same open stream");

  stream.close();
}

console.log("\n--- 7. registration goes through the service ---");
{
  const channel = createFireChannel();
  const registered = [];
  const ctx = {
    webServer: {
      register: (route) => {
        registered.push(route);
        return () => {
          route.disposed = true;
        };
      },
    },
  };

  const dispose = registerEventRoute(ctx, { channel });
  check(registered.length === 1, "exactly one route is registered");
  check(registered[0].path === EVENTS_PATH, "the route registers the event path");
  check(registered[0].name === EVENTS_NAME, "the route registers its stable name");
  check(registered[0].kind === "exact", "the route is exact, not a prefix");
  check(typeof registered[0].handler === "function", "the route carries the handler");
  check(typeof dispose === "function", "registration returns the disposer");

  // One disposer has to do both jobs: a removed route that keeps a socket alive
  // would be writing to a page that can no longer be reached through it.
  const response = openStream({ handler: registered[0].handler });
  check(channel.size() === 1, "the registered handler subscribes");
  dispose();
  check(registered[0].disposed === true, "the disposer removes the route");
  check(channel.size() === 0, "and closes the connections it owned");
  check(response.out.destroyed === true, "including the socket itself");
}

console.log(failures === 0 ? "\nALL EVENT CHECKS PASSED" : `\n${failures} EVENT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
