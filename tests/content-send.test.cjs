const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("a short first assistant reply after enabling an empty chat is submitted", async () => {
  let now = 0;
  let id = 0;
  let assistant = null;
  let clicks = 0;
  const jobs = new Map();
  let poll;
  const mockSetTimeout = (fn, delay) => {
    const key = ++id;
    jobs.set(key, { due: now + delay, fn });
    return key;
  };
  const context = {
    Map, Set, Promise, console,
    Date: class extends Date { static now() { return now; } },
    setTimeout: mockSetTimeout,
    clearTimeout: (key) => jobs.delete(key),
    setInterval: (fn) => { poll = fn; return 1; },
    getComputedStyle: () => ({ visibility: "visible" }),
    location: { hostname: "chatgpt.com", href: "https://chatgpt.com/c/test" },
    Event: class { constructor(type, options) { this.type = type; this.bubbles = options?.bubbles; } },
    MutationObserver: class { observe() {} },
    document: { documentElement: {}, querySelectorAll(selector) {
      if (selector.includes('data-message-author-role="assistant"')) return assistant ? [assistant] : [];
      if (selector.includes("pending-conversation-input")) return [editor];
      if (selector.includes("aria-label=\"Отправить\"")) return [sendButton];
      return [];
    } },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage: (msg) => Promise.resolve(msg.type === "GET_CONFIG" ?
        { enabled: true, marker: "!!!ГОТОВО!!!", delaySeconds: 5, reply: "Ок, продолжаем" } :
        msg.type === "CLAIM_SEND" ? { ok: true } :
        msg.type === "GET_SEND_STATE" ? { ok: true, lockedUntil: 0 } : null)
    } }
  };
  class TextArea {
    constructor() { this._value = ""; this.tagName = "TEXTAREA"; }
    get value() { return this._value; }
    set value(v) { this._value = v; }
    getClientRects() { return [{}]; }
    focus() {}
    dispatchEvent() {}
  }
  const editor = new TextArea();
  const sendButton = {
    disabled: false,
    getClientRects: () => [{}],
    getAttribute: () => null,
    click() { clicks++; }
  };
  context.HTMLTextAreaElement = TextArea;
  context.HTMLInputElement = TextArea;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), context);
  for (let i = 0; i < 24; i++) await Promise.resolve();
  // GET_CONFIG and persisted GET_SEND_STATE have both completed before
  // simulating the arrival of a new assistant response.

  poll(); // Initial empty conversation establishes baseline.
  assistant = {
    innerText: "!!!ГОТОВО!!!",
    getClientRects: () => [{}],
    closest: () => null
  };
  poll();
  now += 1700;
  poll();

  async function advance(ms) {
    now += ms;
    for (let round = 0; round < 10; round++) {
      const due = [...jobs].filter(([, task]) => task.due <= now);
      if (!due.length) break;
      for (const [key, task] of due) {
        jobs.delete(key);
        task.fn();
      }
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  await advance(5000); // configured delay
  await advance(250);  // React-controlled editor settle interval
  assert.equal(editor.value, "Ок, продолжаем");
  assert.equal(clicks, 1);
});
