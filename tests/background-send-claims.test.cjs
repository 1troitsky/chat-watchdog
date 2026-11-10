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
  async function claim(token, tabId = 7, url = "https://chatgpt.com/c/a") {
    return new Promise(resolve => {
      const listening = onMessage(
        { type: "CLAIM_SEND", token },
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
  return { claim, configure, saved, clock,
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
  assert.deepEqual(Array.from(app.saved.get("watchdog:sent:7").tokens), ["chat/a|user:42"]);
});

test("restarting background service worker cannot replay an already claimed turn", async () => {
  const saved = new Map();
  const clock = { now: 1000000 };
  const first = createWorker(saved, clock);
  first.configure();
  assert.equal((await first.claim("chat/a|user:42")).ok, true);
  const restarted = createWorker(saved, clock);
  assert.equal((await restarted.claim("chat/a|user:42")).ok, false);
  assert.equal((await restarted.claim("chat/a|user:43")).reason, "cooldown");
  clock.now += 46000;
  assert.equal((await restarted.claim("chat/a|user:43")).ok, true);
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
  const second = await app.claim("answer-two");
  assert.equal(second.reason, "cooldown");
  assert.equal(second.retryAfterSeconds, 45);
  app.clock.now += 44999;
  assert.equal((await app.claim("answer-two")).reason, "cooldown");
  app.clock.now += 1;
  assert.equal((await app.claim("answer-two")).ok, true);
  app.clock.now += 90000;
  assert.equal((await app.claim("answer-one")).reason, "duplicate");
});

test("tab A and tab B have independent claims", async () => {
  const app = createWorker();
  app.configure(7);
  app.configure(8);
  const [first, second] = await Promise.all([
    app.claim("chat/a|user:42", 7), app.claim("chat/a|user:42", 8)
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});
