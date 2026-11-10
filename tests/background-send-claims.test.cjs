const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const background = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function createWorker(saved = new Map(), clock = { now: 1000000 }) {
  let onMessage;
  let nextArmId = 0;
  const pendingArms = new Map();
  let onUpdated;
  let onRemoved;
  const session = {
    async get(keys) {
      const requested = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(requested
        .filter(key => saved.has(key))
        .map(key => [key, saved.get(key)]));
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) saved.set(key, value);
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) saved.delete(key);
    }
  };
  const chrome = {
    runtime: {
      id: "watchdog-test", onMessage: { addListener(fn) { onMessage = fn; } }
    },
    tabs: {
      onUpdated: { addListener(fn) { onUpdated = fn; } },
      onRemoved: { addListener(fn) { onRemoved = fn; } }
    },
    storage: { session }
  };
  vm.runInNewContext(background, {
    chrome, URL, Map, Promise,
    crypto: { randomUUID: () => "test-arm-" + (++nextArmId) },
    Date: class extends Date { static now() { return clock.now; } },
    importScripts() {},
    console
  });
  async function clicked(tabId = 7, url = "https://chatgpt.com/c/a", assistantOrdinal = 1) {
    return new Promise(resolve => {
      assert.equal(onMessage({ type: "WATCHDOG_SEND_CLICKED", assistantOrdinal },
        { tab: { id: tabId, url } }, resolve), true);
    });
  }
  async function userTurn(tabId = 7, url = "https://chatgpt.com/c/a",
      observation = "no-recent-composer-event") {
    return new Promise(resolve => {
      assert.equal(onMessage({ type: "WATCHDOG_USER_TURN", observation },
        { tab: { id: tabId, url } }, resolve), true);
    });
  }
  async function state(tabId = 7, url = "https://chatgpt.com/c/a") {
    return new Promise(resolve => {
      assert.equal(onMessage({ type: "GET_SEND_STATE" },
        { tab: { id: tabId, url } }, resolve), true);
    });
  }
  async function request(message, tabId, url) {
    return new Promise(resolve => {
      assert.equal(onMessage(message, { tab: { id: tabId, url } }, resolve), true);
    });
  }
  async function arm(token, tabId = 7, url = "https://chatgpt.com/c/a", assistantOrdinal = 1) {
    return request({ type: "ARM_SEND", token, assistantOrdinal }, tabId, url);
  }
  async function cancel(armId, tabId = 7, url = "https://chatgpt.com/c/a") {
    return request({ type: "CANCEL_ARM", armId }, tabId, url);
  }
  async function rawClaim(token, tabId = 7, url = "https://chatgpt.com/c/a",
      assistantOrdinal = 1, armId) {
    return request({ type: "CLAIM_SEND", token, assistantOrdinal, armId }, tabId, url);
  }
  async function claim(token, tabId = 7, url = "https://chatgpt.com/c/a", assistantOrdinal = 1) {
    // Upgrade existing claim tests to the new worker-issued arm protocol.
    // Share an arm for simultaneous contenders, as happens with duplicated
    // observers of the SAME assistant reply.
    const cacheKey = tabId + ":" + url + ":" + token + ":" + assistantOrdinal;
    if (!pendingArms.has(cacheKey))
      pendingArms.set(cacheKey, arm(token, tabId, url, assistantOrdinal));
    const armed = await pendingArms.get(cacheKey);
    if (!armed.ok) pendingArms.delete(cacheKey);
    if (armed.ok) clock.now = Math.max(clock.now, armed.dueAt);
    return rawClaim(token, tabId, url, assistantOrdinal, armed.armId);
  }
  function configure(tabId = 7, overrides = {}) {
    saved.set("tab:" + tabId, {
      enabled: true, mode: "auto", origin: "https://chatgpt.com", ...overrides
    });
  }
  return { claim, rawClaim, arm, cancel, clicked, userTurn, state, configure, saved, clock,
    get onUpdated() { return onUpdated; }, get onRemoved() { return onRemoved; } };
}

test("one background claim wins even with twenty simultaneous senders", async () => {
  const app = createWorker();
  app.configure();
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => app.claim("chat/a|user:42"))
  );
  assert.equal(responses.filter(result => result.ok).length, 1);
  assert.equal(responses.filter(result => result.reason === "duplicate").length, 19);
  const conversation = app.saved.get("watchdog:conversation:https://chatgpt.com/c/a");
  assert.deepEqual(Array.from(conversation.tokens), ["chat/a|user:42"]);
  assert.equal(conversation.maxAssistantOrdinal, 1);
});

test("restarting background service worker cannot replay an already claimed turn", async () => {
  const saved = new Map();
  const clock = { now: 1000000 };
  const first = createWorker(saved, clock);
  first.configure();
  assert.equal((await first.claim("chat/a|user:42")).ok, true);
  const restarted = createWorker(saved, clock);
  assert.equal((await restarted.claim("chat/a|user:42")).ok, false);
  assert.equal((await restarted.claim("chat/a|user:43", 7, "https://chatgpt.com/c/a", 1)).reason,
    "assistant-already-handled");
  assert.equal((await restarted.claim("chat/a|user:43", 7, "https://chatgpt.com/c/a", 2)).reason,
    "cooldown");
  clock.now += 46000;
  assert.equal((await restarted.claim("chat/a|user:43", 7, "https://chatgpt.com/c/a", 2)).ok, true);
});

test("claims are rejected in error-only mode, when OFF, or from the wrong origin", async () => {
  const app = createWorker();
  app.configure(7, { mode: "errors" });
  assert.equal((await app.claim("a")).ok, false);
  app.configure(7, { enabled: false });
  assert.equal((await app.claim("a")).ok, false);
  app.configure();
  assert.equal((await app.claim("a", 7, "https://example.com/c/a")).ok, false);
  assert.equal((await app.claim("")).ok, false);
  assert.equal((await app.claim("a".repeat(2049))).ok, false);
});

test("global cooldown blocks distinct tokens from multiple observers", async () => {
  const app = createWorker();
  app.configure(7, { cooldownSeconds: 45 });
  assert.equal((await app.claim("answer-one")).ok, true);
  const second = await app.claim("answer-two", 7, "https://chatgpt.com/c/a", 2);
  assert.equal(second.reason, "cooldown");
  assert.equal(second.retryAfterSeconds, 45);
  app.clock.now += 44999;
  assert.equal((await app.claim("answer-two", 7, "https://chatgpt.com/c/a", 2)).reason, "cooldown");
  app.clock.now += 1;
  assert.equal((await app.claim("answer-two", 7, "https://chatgpt.com/c/a", 2)).ok, true);
  app.clock.now += 90000;
  assert.equal((await app.claim("answer-one")).reason, "duplicate");
});

test("tab A and tab B have independent conversations", async () => {
  const app = createWorker();
  app.configure(7);
  app.configure(8);
  const [first, second] = await Promise.all([
    app.claim("chat/a|user:42", 7, "https://chatgpt.com/c/a"),
    app.claim("chat/a|user:42", 8, "https://chatgpt.com/c/b")
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});


test("a changed assistant DOM ID cannot reopen the same ordinal, even after cooldown", async () => {
  const app = createWorker();
  app.configure(7);
  assert.equal((await app.claim("reply-1", 7, "https://chatgpt.com/c/a", 7)).ok, true);
  app.clock.now += 90000;
  const changed = await app.claim("rerendered-reply-1", 7, "https://chatgpt.com/c/a", 7);
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, "assistant-already-handled");
  assert.equal((await app.claim("new-reply", 7, "https://chatgpt.com/c/a", 8)).ok, true);
});

test("two open tabs of the SAME chat share one serialized send ledger", async () => {
  const app = createWorker();
  app.configure(7);
  app.configure(8);
  const responses = await Promise.all([
    app.claim("tab-A-reply", 7, "https://chatgpt.com/c/a", 7),
    app.claim("tab-B-different-DOM-id", 8, "https://chatgpt.com/c/a", 7)
  ]);
  assert.equal(responses.filter(value => value.ok).length, 1);
  assert.equal(responses.filter(value => value.reason === "assistant-already-handled").length, 1);
  app.clock.now += 90000;
  assert.equal((await app.claim("tab-B-late", 8, "https://chatgpt.com/c/a", 7)).ok, false);
});

test("a lower assistant ordinal fails closed after DOM virtualizes history", async () => {
  const app = createWorker();
  app.configure();
  assert.equal((await app.claim("reply-10", 7, "https://chatgpt.com/c/a", 10)).ok, true);
  app.clock.now += 90000;
  assert.equal((await app.claim("reply-9", 7, "https://chatgpt.com/c/a", 9)).reason,
    "assistant-already-handled");
});


test("stored global lock deadline persists across worker restart and isolates conversations", async () => {
  const saved = new Map(), clock = { now: 1000000 };
  const app = createWorker(saved, clock);
  app.configure(7);
  app.configure(8);
  assert.equal((await app.state()).lockedUntil, 0);
  const claim = await app.claim("answer-1", 7, "https://chatgpt.com/c/a", 1);
  assert.equal(claim.ok, true);
  assert.equal(claim.lockedUntil, clock.now + 45000);
  const restarted = createWorker(saved, clock);
  assert.equal((await restarted.state(7, "https://chatgpt.com/c/a")).lockedUntil, clock.now + 45000);
  assert.equal((await restarted.state(8, "https://chatgpt.com/c/b")).lockedUntil, 0);
  clock.now += 20000;
  assert.equal((await restarted.claim("answer-2", 7, "https://chatgpt.com/c/a", 2)).reason, "cooldown");
  clock.now += 25000;
  assert.equal((await restarted.claim("answer-2", 7, "https://chatgpt.com/c/a", 2)).ok, true);
});


test("shared audit shows accepted/blocked claims and click caller across tabs without tokens", async () => {
  const app = createWorker();
  app.configure(7);
  app.configure(8, { enabled: false });
  assert.equal((await app.claim("private-token-1", 7, "https://chatgpt.com/c/abcXYZ", 1)).ok, true);
  assert.equal((await app.clicked(7, "https://chatgpt.com/c/abcXYZ", 1)).ok, true);
  assert.equal((await app.claim("private-token-2", 8, "https://chatgpt.com/c/otherQQ", 1)).reason, "inactive");
  const events = app.saved.get("watchdog:send-audit")
    .filter(e => e.event !== "arm");
  assert.equal(events.length, 3);
  assert.deepEqual(Array.from(events.map(e => e.event)), ["claim", "click-called", "claim"]);
  assert.deepEqual(Array.from(events.map(e => e.outcome)), ["allowed", "content-script-reported", "inactive"]);
  assert.deepEqual(Array.from(events.map(e => e.tabId)), [7, 7, 8]);
  assert.equal(events[2].mode, "OFF");
  assert.equal(JSON.stringify(events).includes("private-token"), false);
  assert.equal(JSON.stringify(events).includes("abcXYZ"), true); // Only last six chars are kept.
});


test("user-turn observation is logged independently from send claims, without chat text", async () => {
  const app = createWorker();
  app.configure(7);
  assert.equal((await app.userTurn(7, "https://chatgpt.com/c/a", "no-recent-composer-event")).ok, true);
  assert.equal((await app.userTurn(7, "https://chatgpt.com/c/a", "send-click:trusted")).ok, true);
  const audit = app.saved.get("watchdog:send-audit");
  assert.equal(audit.length, 2);
  assert.deepEqual(Array.from(audit.map(e => e.event)), ["user-turn", "user-turn"]);
  assert.equal(audit[0].outcome, "no-recent-composer-event");
  assert.equal(audit[1].outcome, "send-click:trusted");
  assert.equal(app.saved.has("watchdog:conversation:https://chatgpt.com/c/a"), false);
});


test("bare legacy claims are rejected, even for a valid current reply", async () => {
  const app = createWorker();
  app.configure(7);
  assert.equal((await app.rawClaim("reply-1")).reason, "unarmed");
  assert.equal(app.saved.has("watchdog:conversation:https://chatgpt.com/c/a"), false);
});

test("worker refuses early claims and allows one only after its own deadline", async () => {
  const app = createWorker();
  app.configure(7, { delaySeconds: 30 });
  const armed = await app.arm("reply-1");
  assert.equal(armed.ok, true);
  assert.equal(armed.dueAt, app.clock.now + 30000);
  assert.equal((await app.rawClaim("reply-1", 7, "https://chatgpt.com/c/a", 1, armed.armId)).reason,
    "too-early");
  assert.equal(app.saved.has("watchdog:conversation:https://chatgpt.com/c/a"), false);
  app.clock.now += 29999;
  assert.equal((await app.rawClaim("reply-1", 7, "https://chatgpt.com/c/a", 1, armed.armId)).reason,
    "too-early");
  app.clock.now += 1;
  assert.equal((await app.rawClaim("reply-1", 7, "https://chatgpt.com/c/a", 1, armed.armId)).ok, true);
  assert.equal((await app.rawClaim("reply-1", 7, "https://chatgpt.com/c/a", 1, armed.armId)).reason,
    "duplicate");
});

test("user turn revokes a prior background arm, so stale timers cannot send", async () => {
  const app = createWorker();
  app.configure(7);
  const armed = await app.arm("reply-1");
  assert.equal(armed.ok, true);
  await app.userTurn();
  app.clock.now = armed.dueAt + 20000;
  assert.equal((await app.rawClaim("reply-1", 7, "https://chatgpt.com/c/a", 1, armed.armId)).reason,
    "unarmed");
});

test("two tabs cannot both arm the same conversation, but different chats can", async () => {
  const app = createWorker();
  app.configure(7);
  app.configure(8);
  const same = await Promise.all([
    app.arm("reply-1", 7, "https://chatgpt.com/c/a", 1),
    app.arm("other-id", 8, "https://chatgpt.com/c/a", 1)
  ]);
  assert.equal(same.filter(e => e.ok).length, 1);
  assert.equal((await app.arm("reply-1", 8, "https://chatgpt.com/c/b", 1)).ok, true);
});


test("an arm capability cannot be claimed from another tab or with a forged identifier", async () => {
  const app = createWorker();
  app.configure(7);
  app.configure(8);
  const armed = await app.arm("answer", 7, "https://chatgpt.com/c/a", 3);
  app.clock.now = armed.dueAt;
  assert.equal((await app.rawClaim("answer", 7, "https://chatgpt.com/c/a", 3, "forged")).reason, "unarmed");
  assert.equal((await app.rawClaim("answer", 8, "https://chatgpt.com/c/a", 3, armed.armId)).reason, "unarmed");
  assert.equal((await app.rawClaim("answer", 7, "https://chatgpt.com/c/a", 3, armed.armId)).ok, true);
});

test("armed deadlines survive background worker restarts without legacy bypass", async () => {
  const saved = new Map();
  const clock = { now: 1000000 };
  const oldWorker = createWorker(saved, clock);
  oldWorker.configure(7, { delaySeconds: 30 });
  const armed = await oldWorker.arm("answer");
  const restarted = createWorker(saved, clock);
  assert.equal((await restarted.rawClaim("answer")).reason, "unarmed");
  clock.now = armed.dueAt - 1;
  assert.equal((await restarted.rawClaim("answer", 7, "https://chatgpt.com/c/a", 1, armed.armId)).reason,
    "too-early");
  clock.now++;
  assert.equal((await restarted.rawClaim("answer", 7, "https://chatgpt.com/c/a", 1, armed.armId)).ok,
    true);
});

test("cancel revokes the exact arm; a stale cancellation cannot revoke a newer one", async () => {
  const app = createWorker();
  app.configure(7);
  const first = await app.arm("old-answer");
  assert.equal((await app.cancel(first.armId)).ok, true);
  const next = await app.arm("new-answer", 7, "https://chatgpt.com/c/a", 2);
  assert.equal(next.ok, true);
  assert.equal((await app.cancel(first.armId)).ok, false);
  app.clock.now = next.dueAt;
  assert.equal((await app.rawClaim("old-answer", 7, "https://chatgpt.com/c/a", 1, first.armId)).reason,
    "unarmed");
  assert.equal((await app.rawClaim("new-answer", 7, "https://chatgpt.com/c/a", 2, next.armId)).ok,
    true);
});

test("mode switched off after arming cannot claim even after the deadline", async () => {
  const app = createWorker();
  app.configure(7);
  const armed = await app.arm("answer");
  app.configure(7, { mode: "errors" });
  app.clock.now = armed.dueAt;
  assert.equal((await app.rawClaim("answer", 7, "https://chatgpt.com/c/a", 1, armed.armId)).reason,
    "inactive");
});
