const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const background = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function createWorker(saved = new Map(), clock = { now: 1000000 }, alarmState = { count: 0, current: null }) {
  let onMessage;
  let onUpdated;
  let onRemoved;
  let onAlarm;
  const healthEvents = [];
  let tabs = [];
  let reachable = true;
  const session = {
    async get(keys) {
      const requested = keys == null ? [...saved.keys()] :
        (typeof keys === "string" ? [keys] : keys);
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
  const playback = [];
  const chrome = {
    runtime: {
      id: "watchdog-test", onMessage: { addListener(fn) { onMessage = fn; } },
      getContexts: async () => [{ contextType: "OFFSCREEN_DOCUMENT" }],
      getURL: path => "chrome-extension://watchdog-test/" + path,
      sendMessage: async message => { playback.push(message); return { ok: true }; }
    },
    offscreen: { createDocument: async () => {} },
    tabs: {
      onUpdated: { addListener(fn) { onUpdated = fn; } },
      onRemoved: { addListener(fn) { onRemoved = fn; } },
      query: async () => tabs,
      sendMessage: async (tabId, message) => {
        healthEvents.push(message.type);
        if (!reachable) throw new Error("content script unavailable");
        return { ok: true, enabled: true };
      }
    },
    storage: { session },
    alarms: {
      onAlarm: { addListener(fn) { onAlarm = fn; } },
      get: async () => alarmState.current,
      create: async (name, options) => {
        alarmState.count++;
        alarmState.current = { name, ...options };
      }
    },
    scripting: { async executeScript() { reachable = true; healthEvents.push("inject"); } }
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
  async function claim(token, tabId = 7, url = "https://chatgpt.com/c/a", assistantOrdinal = 1, userTurnKey = null, assistantStable = false) {
    return new Promise(resolve => {
      const listening = onMessage(
        { type: "CLAIM_SEND", token, assistantOrdinal, userTurnKey, assistantStable },
        { tab: { id: tabId, url } },
        resolve
      );
      assert.equal(listening, true, "claim must use an async runtime response");
    });
  }
  async function release(token, leaseId, tabId = 7, url = "https://chatgpt.com/c/a") {
    return new Promise(resolve => {
      assert.equal(onMessage({ type: "RELEASE_UNCLICKED_SEND", token, leaseId },
        { tab: { id: tabId, url } }, resolve), true);
    });
  }
  async function claimErrorDialog(incidentKey, tabId = 7, url = "https://chatgpt.com/c/a") {
    return new Promise(resolve => {
      assert.equal(onMessage({ type: "CLAIM_ERROR_DIALOG", incidentKey },
        { tab: { id: tabId, url } }, resolve), true);
    });
  }
  async function releaseErrorDialog(leaseId, tabId = 7, url = "https://chatgpt.com/c/a") {
    return new Promise(resolve => {
      assert.equal(onMessage({ type: "RELEASE_ERROR_DIALOG", leaseId },
        { tab: { id: tabId, url } }, resolve), true);
    });
  }
  async function error(tabId = 7, url = "https://chatgpt.com/c/a") {
    return new Promise(resolve => {
      assert.equal(onMessage({ type: "PLAY_ERROR" },
        { tab: { id: tabId, url } }, resolve), true);
    });
  }
  async function completion(token, tabId = 7, url = "https://chatgpt.com/c/a") {
    return new Promise(resolve => {
      assert.equal(onMessage({ type: "PLAY_COMPLETION", token },
        { tab: { id: tabId, url } }, resolve), true);
    });
  }
  function configure(tabId = 7, overrides = {}) {
    saved.set("tab:" + tabId, {
      enabled: true, mode: "auto", origin: "https://chatgpt.com", ...overrides
    });
  }
  return { claim, release, claimErrorDialog, releaseErrorDialog, completion, error, state, configure, saved, clock, playback,
    setHealthTabs(value, isReachable) { tabs = value; reachable = isReachable; },
    async runHealthAlarm() { onAlarm({ name: "chat-watchdog-health" });
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); },
    healthEvents, alarmState,
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
  assert.equal(claim.lockedUntil, clock.now + 30000);
  const restarted = createWorker(saved, clock);
  assert.equal((await restarted.state(7, "https://chatgpt.com/c/a")).lockedUntil, clock.now + 30000);
  assert.equal((await restarted.state(8, "https://chatgpt.com/c/b")).lockedUntil, 0);
  clock.now += 20000;
  assert.equal((await restarted.claim("answer-2", 7, "https://chatgpt.com/c/a", 2)).reason, "cooldown");
  clock.now += 10000;
  assert.equal((await restarted.claim("answer-2", 7, "https://chatgpt.com/c/a", 2)).ok, true);
});


test("completion audio is claimed only once, including after worker restart", async () => {
  const saved = new Map();
  const app = createWorker(saved);
  app.configure(7, { completionAudioName: "finished.mp3" });
  const res = await Promise.all(Array.from({ length: 8 }, () => app.completion("turn-41")));
  assert.equal(res.filter(x => x.ok).length, 1);
  assert.equal(res.filter(x => x.reason === "duplicate").length, 7);
  assert.equal(app.playback.filter(x => x.type === "OFFSCREEN_PLAY" &&
    x.kind === "completion").length, 1);
  const restarted = createWorker(saved);
  assert.equal((await restarted.completion("turn-41")).reason, "duplicate");
  assert.equal(restarted.playback.length, 0);
  assert.equal((await restarted.completion("turn-42")).ok, true);
  assert.equal(restarted.playback.length, 1);
});

test("completion sound can play for the continue-only and errors-only modes", async () => {
  const app = createWorker();
  app.configure(7, { mode: "errors", completionAudioName: "done.wav" });
  assert.equal((await app.completion("first")).ok, true);
  app.configure(7, { mode: "continue", completionAudioName: "done.wav" });
  assert.equal((await app.completion("second")).ok, true);
  assert.equal(app.playback.length, 2);
  assert.equal((await app.claim("new-send", 7, "https://chatgpt.com/c/a", 1)).ok, true);
});

test("completion notifications reject the wrong origin and disabled tabs", async () => {
  const app = createWorker();
  app.configure(7, { completionAudioName: "done.wav" });
  assert.equal((await app.completion("token", 7, "https://example.com/c/a")).reason, "inactive");
  app.configure(7, { enabled: false, completionAudioName: "done.wav" });
  assert.equal((await app.completion("token")).reason, "inactive");
  assert.equal(app.playback.length, 0);
});

test('a pre-click claim can be safely released and retried without cooldown', async () => {
  const app = createWorker(); app.configure();
  const first = await app.claim('assistant-one');
  assert.equal(first.ok, true);
  assert.equal(typeof first.leaseId, 'string');
  assert.equal((await app.claim('assistant-one')).reason, 'duplicate');
  const result = await app.release('assistant-one', first.leaseId);
  assert.equal(result.ok, true);
  assert.equal((await app.state()).lockedUntil, 0);
  const retried = await app.claim('assistant-one');
  assert.equal(retried.ok, true);
  assert.notEqual(retried.leaseId, first.leaseId);
  assert.equal((await app.release('assistant-one', first.leaseId)).reason, 'lease-mismatch');
  assert.equal((await app.claim('assistant-one')).reason, 'duplicate');
});

test('a different tab or stale lease cannot release an active send reservation', async () => {
  const app = createWorker(); app.configure(7); app.configure(8);
  const claim = await app.claim('token', 7);
  assert.equal((await app.release('token', claim.leaseId, 8)).reason, 'lease-mismatch');
  assert.equal((await app.release('another-token', claim.leaseId, 7)).reason, 'lease-mismatch');
  assert.equal((await app.release('token', 'wrong-lease', 7)).reason, 'lease-mismatch');
  assert.equal((await app.claim('token', 8)).reason, 'duplicate');
  assert.equal((await app.release('token', claim.leaseId, 7)).ok, true);
  assert.equal((await app.claim('token', 8)).ok, true);
});

test('releasing a second claim restores earlier committed cooldown and ordinal', async () => {
  const app = createWorker(); app.configure();
  assert.equal((await app.claim('already-sent', 7, 'https://chatgpt.com/c/a', 1)).ok, true);
  app.clock.now += 30001;
  const prepared = await app.claim('not-clicked', 7, 'https://chatgpt.com/c/a', 2);
  assert.equal(prepared.ok, true);
  assert.equal((await app.release('not-clicked', prepared.leaseId)).ok, true);
  const ledger = app.saved.get('watchdog:conversation:https://chatgpt.com/c/a');
  assert.deepEqual(Array.from(ledger.tokens), ['already-sent']);
  assert.equal(ledger.maxAssistantOrdinal, 1);
  assert.equal((await app.claim('already-sent')).reason, 'duplicate');
  assert.equal((await app.claim('different', 7, 'https://chatgpt.com/c/a', 2)).ok, true);
});


test("new stable assistant after a new user turn survives DOM ordinal virtualization", async () => {
  const saved = new Map();
  const app = createWorker(saved);
  app.configure();
  const first = await app.claim("chat|assistant:old", 7, "https://chatgpt.com/c/a", 4,
    "4:14:fingerprint-old", true);
  assert.equal(first.ok, true);
  app.clock.now += 31000;
  const second = await app.claim("chat|assistant:new", 7, "https://chatgpt.com/c/a", 4,
    "5:14:fingerprint-new", true);
  assert.equal(second.ok, true, "new response may have the same rendered ordinal");
  const ledger = saved.get("watchdog:conversation:https://chatgpt.com/c/a");
  assert.equal(ledger.maxAssistantOrdinal, 4);
  assert.equal(ledger.userTurns.length, 2);
});

test("new DOM assistant ID cannot resubmit the SAME user turn, even after cooldown", async () => {
  const app = createWorker();
  app.configure();
  assert.equal((await app.claim("chat|assistant:a", 7, "https://chatgpt.com/c/a", 4,
    "5:14:user", true)).ok, true);
  app.clock.now += 90000;
  assert.equal((await app.claim("chat|assistant:rerender", 7, "https://chatgpt.com/c/a", 4,
    "5:14:user", true)).reason, "user-turn-already-handled");
  assert.equal((await app.claim("chat|assistant:a", 7, "https://chatgpt.com/c/a", 5,
    "6:14:new-user", true)).reason, "duplicate");
});

test("older ledger ordinal collision can migrate after a new identified turn", async () => {
  const saved = new Map();
  const app = createWorker(saved); app.configure();
  saved.set("watchdog:conversation:https://chatgpt.com/c/a", {
    origin: "https://chatgpt.com", tokens: ["chat|assistant:old"],
    maxAssistantOrdinal: 4, lockedUntil: 900000, lastClaimAt: 800000
  });
  app.clock.now = 1000000;
  assert.equal((await app.claim("chat|assistant:new", 7, "https://chatgpt.com/c/a", 4,
    "5:14:user", true)).ok, true);
});

test("ID-less or absent user identity still uses conservative ordinal protection", async () => {
  const app = createWorker(); app.configure();
  assert.equal((await app.claim("first", 7, "https://chatgpt.com/c/a", 4)).ok, true);
  app.clock.now += 90000;
  assert.equal((await app.claim("second", 7, "https://chatgpt.com/c/a", 4,
    "different-user", false)).reason, "assistant-already-handled");
  assert.equal((await app.claim("third", 7, "https://chatgpt.com/c/a", 4,
    null, true)).reason, "assistant-already-handled");
});

test("un-clicked claim releases user-turn lock without leaking duplicate permission", async () => {
  const app = createWorker(); app.configure();
  const first = await app.claim("first", 7, "https://chatgpt.com/c/a", 4,
    "5:14:user", true);
  assert.equal(first.ok, true);
  assert.equal((await app.release("first", first.leaseId)).ok, true);
  const second = await app.claim("second", 7, "https://chatgpt.com/c/a", 4,
    "5:14:user", true);
  assert.equal(second.ok, true);
});


test("one-minute health scan wakes a live observer but does not reinject it", async () => {
  const app = createWorker(); app.configure();
  app.setHealthTabs([{ id: 7, url: "https://chatgpt.com/c/a" }], true);
  await app.runHealthAlarm();
  assert.deepEqual(app.healthEvents, ["WATCHDOG_HEALTH"]);
});

test("a missing observer is re-injected without page refresh", async () => {
  const app = createWorker(); app.configure();
  app.setHealthTabs([{ id: 7, url: "https://chatgpt.com/c/a" }], false);
  await app.runHealthAlarm();
  assert.deepEqual(app.healthEvents,
    ["WATCHDOG_HEALTH", "inject", "WATCHDOG_CONFIG"]);
});

test("health checks never touch disabled or cross-origin tabs", async () => {
  const app = createWorker(); app.configure(7, { enabled: false });
  app.configure(8);
  app.setHealthTabs([
    { id: 7, url: "https://chatgpt.com/c/a" },
    { id: 8, url: "https://example.com/c/a" }
  ], false);
  await app.runHealthAlarm();
  assert.equal(app.healthEvents.length, 0);
});


test("worker restart does not move an already scheduled health alarm", async () => {
  const saved = new Map(), clock = { now: 1000000 };
  const alarms = { count: 0, current: null };
  createWorker(saved, clock, alarms);
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(alarms.count, 1);
  assert.equal(alarms.current.periodInMinutes, 1);
  createWorker(saved, clock, alarms);
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(alarms.count, 1, "restarting service worker must preserve the existing alarm");
});


test("completion audio works by default without a user-selected sound", async () => {
  const app = createWorker();
  app.configure(7, { completionAudioName: "", audioName: "" });
  assert.equal((await app.completion("first")).ok, true);
  assert.equal((await app.completion("first")).reason, "duplicate");
  assert.equal((await app.completion("second")).ok, true);
  assert.equal(app.playback.filter(x =>
    x.type === "OFFSCREEN_PLAY" && x.kind === "completion").length, 2);
});

test("only-autocontinue mode keeps error sounds off with bundled defaults", async () => {
  const app = createWorker();
  app.configure(7, { mode: "continue", audioName: "", completionAudioName: "" });
  assert.equal((await app.completion("first")).ok, true);
  assert.equal(app.playback.filter(x => x.type === "OFFSCREEN_PLAY" &&
    x.kind === "completion").length, 1);
});

test("error playback reports offscreen result to the originating content script", async () => {
  const app = createWorker();
  app.configure();
  const result = await app.error();
  assert.equal(result.ok, true);
  assert.equal(app.playback.filter(x => x.type === "OFFSCREEN_PLAY" && x.kind === "error").length, 1);
  app.configure(7, {mode: "continue"});
  const disabled = await app.error();
  assert.equal(disabled.ok, false);
  assert.equal(disabled.reason, "inactive-or-error-sounds-disabled");
});

test('one of ten simultaneous modal claimants wins, with no close action', async () => {
  const app = createWorker();
  app.configure();
  const attempts = await Promise.all(Array.from({length:10}, (_,i) =>
    app.claimErrorDialog('incident:' + i)));
  assert.equal(attempts.filter(result => result.ok).length, 1);
  assert.equal(attempts.filter(result => result.reason === 'dialog-already-open').length, 9);
  const existing = app.saved.get('watchdog:error-modal:7');
  assert.equal(typeof existing.leaseId, 'string');
  assert.equal((await app.releaseErrorDialog('wrong')).reason, 'dialog-lease-mismatch');
  assert.equal((await app.claimErrorDialog('new-incident')).reason, 'dialog-already-open');
  assert.equal((await app.releaseErrorDialog(existing.leaseId)).ok, true);
  assert.equal((await app.claimErrorDialog('new-incident')).ok, true);
});

test('modal claim is tab-scoped and reset on page reload', async () => {
  const app = createWorker();
  app.configure(7); app.configure(8);
  assert.equal((await app.claimErrorDialog('one', 7)).ok, true);
  assert.equal((await app.claimErrorDialog('two', 8)).ok, true);
  assert.equal((await app.claimErrorDialog('another', 7)).ok, false);
  await app.onUpdated(7, {status:'loading'}, {id:7,url:'https://chatgpt.com/c/a'});
  for (let i=0;i<10;i++) await Promise.resolve();
  assert.equal((await app.claimErrorDialog('another', 7)).ok, true);
});


test('modal ownership never expires while the first dialog is still open', async () => {
  const app = createWorker(); app.configure();
  assert.equal((await app.claimErrorDialog('first')).ok, true);
  app.clock.now += 20 * 60 * 1000;
  assert.equal((await app.claimErrorDialog('second')).reason, 'dialog-already-open');
});
