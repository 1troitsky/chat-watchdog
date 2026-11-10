const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const background = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function createWorker(saved = new Map(), clock = { now: 1000000 }) {
  let onMessage;
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
    Date: class extends Date { static now() { return clock.now; } },
    importScripts() {},
    console
  });
  async function state(tabId = 7, url = "https://chatgpt.com/c/a") {
    return new Promise(resolve => {
      assert.equal(onMessage({ type: "GET_SEND_STATE" },
        { tab: { id: tabId, url } }, resolve), true);
    });
  }
  async function claim(token, tabId = 7, url = "https://chatgpt.com/c/a", assistantOrdinal = 1) {
    return new Promise(resolve => {
      const listening = onMessage(
        { type: "CLAIM_SEND", token, assistantOrdinal },
        { tab: { id: tabId, url } },
        resolve
      );
      assert.equal(listening, true, "claim must use an async runtime response");
    });
  }
  function configure(tabId = 7, overrides = {}) {
    saved.set("tab:" + tabId, {
      enabled: true, mode: "auto", origin: "https://chatgpt.com", ...overrides
    });
  }
  return { claim, state, configure, saved, clock,
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
