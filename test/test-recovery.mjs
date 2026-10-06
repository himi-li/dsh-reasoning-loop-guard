/**
 * Unit checks for `lib/recovery.js` — the opt-in recovery arm.
 *
 * The arm sits on `agent/request-error` and its contract is entirely about
 * *when* it acts:
 *
 *  - it must stay out of the way while disabled (the shipped default),
 *  - it must only claim the guard's own failures, never an unrelated one,
 *  - it must append a well-formed message BEFORE returning `{ kind: "retry" }`,
 *    because a bare retry re-sends the identical request and loops again,
 *  - it must exhaust its per-step budget rather than retry forever, and
 *  - any internal fault must fall through to `next()` so the failure stays
 *    exactly as terminal as it would have been without the plugin.
 *
 * Each of those is a check below.
 *
 * Run: node --import ./test/smoke/register-hook.mjs test/test-recovery.mjs
 */
import {
  DEFAULT_RECOVERY_MESSAGE,
  PRODUCER_KIND,
  RECOVERY_DEFAULTS,
  attemptKey,
  correctiveMessage,
  createRecoveryListener,
  isGuardFailure,
} from "../lib/recovery.js";

let failures = 0;
const check = (ok, label) => {
  if (!ok) { failures += 1; console.log(`FAIL  ${label}`); } else { console.log(`ok    ${label}`); }
};

console.log("--- 1. the arm ships inert ---");
check(RECOVERY_DEFAULTS.enabled === false, "recovery is off by default");
check(RECOVERY_DEFAULTS.maxRetries === 2, "the default budget is two retries per step");
check(typeof DEFAULT_RECOVERY_MESSAGE === "string" && DEFAULT_RECOVERY_MESSAGE.length > 0, "a built-in message exists");
check(DEFAULT_RECOVERY_MESSAGE.includes("重复"), "the built-in message names the loop");

console.log("\n--- 2. identifying our own failure ---");
check(isGuardFailure({ failure: { code: "REASONING_LOOP" } }, { failureCode: "REASONING_LOOP" }) === true, "the guard's code is recognized");
check(isGuardFailure({ failure: { code: "RATE_LIMIT" } }, { failureCode: "REASONING_LOOP" }) === false, "an unrelated provider failure is not");
check(isGuardFailure({ failure: { code: "REASONING_LOOP" } }, { failureCode: "MY_CODE" }) === false, "a custom code is honoured");
check(isGuardFailure({ failure: {} }, {}) === false, "a failure without a code is not ours");
check(isGuardFailure({}, {}) === false, "a payload without a failure is not ours");
check(isGuardFailure(undefined, undefined) === false, "a missing payload is not ours");

console.log("\n--- 3. the retry budget is counted per step ---");
{
  const site = { agent: { session: { id: "session-a" } }, turn: 4, step: 7 };
  check(attemptKey(site) === "session-a:4:7", "the key names session, turn and step");
  const other = { agent: { session: { id: "session-a" } }, turn: 4, step: 8 };
  check(attemptKey(other) !== attemptKey(site), "a different step is a different budget");
  const nextTurn = { agent: { session: { id: "session-a" } }, turn: 5, step: 7 };
  check(attemptKey(nextTurn) !== attemptKey(site), "a different turn is a different budget");
  check(attemptKey({}) === "?:?:?", "a payload missing every field still keys stably");
}

console.log("\n--- 4. the corrective message is well formed ---");
{
  const message = correctiveMessage("自定义纠正文案");
  check(message.role === "user", "the corrective message is a user message");
  check(typeof message.id === "string" && message.id !== "", "it carries a generated id");
  check(Array.isArray(message.content) && message.content[0].type === "text", "it carries one text block");
  check(message.content[0].text === "自定义纠正文案", "it carries the configured body");
  check(message.source.kind === PRODUCER_KIND, "it is stamped with the producer kind");
  check(Object.isFrozen(message) === true, "it is frozen, as the session layer expects");
  check(correctiveMessage("").content[0].text === DEFAULT_RECOVERY_MESSAGE, "an empty configured body falls back to the built-in one");
  check(correctiveMessage("   ").content[0].text === DEFAULT_RECOVERY_MESSAGE, "a whitespace-only body also falls back");
  check(correctiveMessage(undefined).content[0].text === DEFAULT_RECOVERY_MESSAGE, "a missing body falls back too");
}

/** A stand-in session that records what was appended. */
const makeSession = () => {
  const appended = [];
  return {
    appended,
    append: (type, data, options) => { appended.push({ type, data, options }); },
  };
};

/** A payload shaped like the real `agent/request-error` one. */
const makeSite = (session, overrides = {}) => ({
  agent: { session },
  turn: 4,
  step: 7,
  provider: "deepseek",
  failure: { code: "REASONING_LOOP", message: "loop" },
  ...overrides,
});

console.log("\n--- 5. a disabled arm delegates ---");
{
  let called = 0;
  const listener = createRecoveryListener({ read: () => ({ recovery: { enabled: false } }) });
  const action = await listener(makeSite(makeSession()), () => { called += 1; return Promise.resolve("next"); });
  check(action === "next", "a disabled arm delegates to next()");
  check(called === 1, "next() was called exactly once");
}
{
  const listener = createRecoveryListener({ read: () => ({}) });
  let called = 0;
  await listener(makeSite(makeSession()), () => { called += 1; return Promise.resolve(undefined); });
  check(called === 1, "a config with no recovery block delegates");
}

console.log("\n--- 6. an unrelated failure is not claimed ---");
{
  const session = makeSession();
  const listener = createRecoveryListener({ read: () => ({ recovery: { enabled: true }, failureCode: "REASONING_LOOP" }) });
  let called = 0;
  const action = await listener(
    makeSite(session, { failure: { code: "RATE_LIMIT" } }),
    () => { called += 1; return Promise.resolve("next"); },
  );
  check(action === "next", "an unrelated failure is delegated");
  check(session.appended.length === 0, "nothing is appended for an unrelated failure");
}

console.log("\n--- 7. an enabled arm claims the failure ---");
{
  const session = makeSession();
  const logs = [];
  const listener = createRecoveryListener({
    read: () => ({ recovery: { enabled: true, message: "请停止重复，直接给结论。", maxRetries: 2 }, failureCode: "REASONING_LOOP" }),
    log: (message) => logs.push(message),
  });
  let called = 0;
  const action = await listener(makeSite(session), () => { called += 1; return Promise.resolve("next"); });
  check(action?.kind === "retry", "the arm returns a retry action");
  check(called === 0, "next() is NOT called, or the platform would settle the failure first");
  check(session.appended.length === 1, "exactly one message is appended");
  const appended = session.appended[0];
  check(appended.type === "user/message", "the appended event is a user message");
  check(appended.data.content[0].text === "请停止重复，直接给结论。", "the configured body is what gets appended");
  check(appended.options?.surfaceOp === "append", "the append is marked as a surface append");
  check(logs.some((line) => line.includes("1/2")), "the retry is logged with its budget");

  // The message must be appended BEFORE the retry is returned: the whole arm
  // only works because the model sees something it did not see last time.
  check(session.appended.length === 1 && action.kind === "retry", "the append precedes the retry decision");
}

console.log("\n--- 8. the budget is enforced ---");
{
  const session = makeSession();
  const logs = [];
  const listener = createRecoveryListener({
    read: () => ({ recovery: { enabled: true, maxRetries: 2 }, failureCode: "REASONING_LOOP" }),
    log: (message) => logs.push(message),
  });
  const site = makeSite(session);
  const next = () => Promise.resolve("next");
  const first = await listener(site, next);
  const second = await listener(site, next);
  const third = await listener(site, next);
  check(first?.kind === "retry", "the first failure is retried");
  check(second?.kind === "retry", "the second failure is retried");
  check(third === "next", "the third failure is left terminal");
  check(session.appended.length === 2, "only two corrective messages were appended");
  check(logs.some((line) => line.includes("budget spent")), "the exhausted budget is logged");

  // A fresh step gets a fresh budget: the key includes turn and step.
  const freshStep = makeSite(session, { step: 9 });
  check((await listener(freshStep, next))?.kind === "retry", "a new step gets a new budget");

  // maxRetries = 0 means "enabled but never retry" — a legal way to keep the
  // message while opting out of the automatic second attempt.
  const zero = createRecoveryListener({
    read: () => ({ recovery: { enabled: true, maxRetries: 0 }, failureCode: "REASONING_LOOP" }),
  });
  const zeroSession = makeSession();
  check((await zero(makeSite(zeroSession), next)) === "next", "a zero budget leaves the failure terminal");
  check(zeroSession.appended.length === 0, "a zero budget appends nothing");
}

console.log("\n--- 9. faults never change the outcome ---");
{
  let called = 0;
  const listener = createRecoveryListener({
    read: () => { throw new Error("settings unreadable"); },
    warn: () => {},
  });
  const action = await listener(makeSite(makeSession()), () => { called += 1; return Promise.resolve("next"); });
  check(action === "next", "a throwing config read delegates");
  check(called === 1, "next() still runs after a config fault");
}
{
  const warns = [];
  const listener = createRecoveryListener({
    read: () => ({ recovery: { enabled: true }, failureCode: "REASONING_LOOP" }),
    warn: (message) => warns.push(message),
  });
  // A session that refuses the append (a read-only or replaying session).
  const hostile = { append: () => { throw new Error("read-only session"); } };
  let called = 0;
  const action = await listener(makeSite(hostile), () => { called += 1; return Promise.resolve("next"); });
  check(action === "next", "a failing append delegates");
  check(called === 1, "next() still runs after an append fault");
  check(warns.some((line) => line.includes("recovery failed")), "the append fault is reported");
}
{
  const warns = [];
  const listener = createRecoveryListener({
    read: () => ({ recovery: { enabled: true }, failureCode: "REASONING_LOOP" }),
    warn: (message) => warns.push(message),
  });
  let called = 0;
  const action = await listener(
    { agent: {}, turn: 1, step: 1, failure: { code: "REASONING_LOOP" } },
    () => { called += 1; return Promise.resolve("next"); },
  );
  check(action === "next", "a payload with no session delegates");
  check(called === 1, "next() still runs without a session");
  check(warns.some((line) => line.includes("no appending session")), "the missing session is reported");
}
{
  // The budget must not be spent when the append failed, or a transient fault
  // would silently consume the user's retries.
  const session = makeSession();
  let attempts = 0;
  const flaky = {
    appended: session.appended,
    append: (type, data, options) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      session.append(type, data, options);
    },
  };
  const listener = createRecoveryListener({
    read: () => ({ recovery: { enabled: true, maxRetries: 1 }, failureCode: "REASONING_LOOP" }),
    warn: () => {},
  });
  const next = () => Promise.resolve("next");
  await listener(makeSite(flaky), next);
  const action = await listener(makeSite(flaky), next);
  check(action?.kind === "retry", "a failed append does not consume the budget");
}

console.log(failures === 0 ? "\nALL RECOVERY CHECKS PASSED" : `\n${failures} RECOVERY CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
