const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSource = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function createChat(variant, userOwnsMarker = false) {
  let now = 0;
  let nextTimer = 0;
  let assistantVisible = false;
  let clicks = 0;
  let poll = null;
  let messageListener = null;
  const jobs = new Map();

  const editor = {
    tagName: "DIV", isContentEditable: true, innerText: "",
    getClientRects: () => [1], focus() {}, dispatchEvent() {}
  };
  const user = {
    getClientRects: () => [1],
    compareDocumentPosition: () => 4,
    contains: () => userOwnsMarker
  };
  const assistant = {
    innerText: "!!!ГОТОВО!!!",
    getClientRects: () => [1],
    closest: (sel) => {
      if (sel.includes("data-message-id")) return null;
      if (userOwnsMarker && sel.includes("data-user-message-bubble")) return user;
      return null;
    },
    contains: () => false
  };
  const send = {
    disabled: false,
    getClientRects: () => [1],
    getAttribute: () => null,
    click: () => { clicks++; }
  };
  const root = { querySelectorAll: () => assistantVisible ? [assistant] : [] };
  const document = {
    documentElement: {},
    body: root,
    querySelector: (s) => s === "main" ? root : null,
    querySelectorAll(selector) {
      // The generic fallback first asks for a user bubble.
      if (selector.startsWith('[data-user-message-bubble="true"]')) return [user];
      // Composer and submit are independent of answer-turn detection.
      if (selector.includes('[contenteditable="true"][role="textbox"]')) return [editor];
      if (selector.includes('button[aria-label="Отправить"]')) return [send];
      if (!assistantVisible) return [];
      if (variant === "legacy" && selector.includes('[data-message-author-role="assistant"]')) {
        return [assistant];
      }
      if (variant === "search-unit" && selector.includes('[data-content-search-unit-key$=":assistant"]')) {
        return [assistant];
      }
      if (variant === "turn-key" && selector.includes('[data-turn-key]')) {
        return [assistant];
      }
      return [];
    },
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand(command, unused, value) {
      if (command === "insertText") {
        editor.innerText = value;
        return true;
      }
      return false;
    }
  };
  const selection = { removeAllRanges() {}, addRange() {} };
  const context = {
    document, Map, Set, WeakMap, Promise, console,
    location: { href: "https://chatgpt.com/c/sample", hostname: "chatgpt.com" },
    getComputedStyle: () => ({ visibility: "visible" }),
    getSelection: () => selection,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = ++nextTimer; jobs.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    setInterval(fn) { poll = fn; return 1; },
    MutationObserver: class { observe() {} },
    chrome: { runtime: {
      onMessage: { addListener(fn) { messageListener = fn; } },
      sendMessage: async (message) => message.type === "GET_CONFIG" ?
        { enabled: true, marker: "!!!ГОТОВО!!!", reply: "Ок, продолжаем", delaySeconds: 5 } : null
    } }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(coreSource, context);
  vm.runInContext(contentSource, context);

  async function move(ms) {
    now += ms;
    for (let round = 0; round < 15; round++) {
      const due = [...jobs].filter(([, job]) => job.at <= now);
      if (!due.length) break;
      for (const [id, job] of due) {
        jobs.delete(id);
        job.fn();
      }
      await Promise.resolve();
      await Promise.resolve();
    }
  }
  async function start() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    poll(); // Baseline of an empty conversation.
  }
  async function diagnose() {
    let result;
    messageListener({ type: "WATCHDOG_DIAGNOSE" }, null, value => { result = value; });
    return result;
  }

  return {
    start, move, diagnose, poll,
    answer() { assistantVisible = true; poll(); },
    clicks: () => clicks, text: () => editor.innerText
  };
}

for (const variant of ["legacy", "search-unit", "turn-key", "marker-fallback"]) {
  test("ChatGPT " + variant + " detects the reply and submits after 5 seconds", async () => {
    const app = createChat(variant);
    await app.start();
    app.answer();
    const found = await app.diagnose();
    assert.equal(found.assistantCount, 1);
    assert.equal(found.markerDetected, true);
    await app.move(1600);
    app.poll();
    await app.move(5000);
    await app.move(250);
    assert.equal(app.text(), "Ок, продолжаем");
    assert.equal(app.clicks(), 1);
  });
}

test("a marker inside the user's own message never causes auto-send", async () => {
  const app = createChat("marker-fallback", true);
  await app.start();
  app.answer();
  const result = await app.diagnose();
  assert.equal(result.assistantCount, 0);
  await app.move(10000);
  app.poll();
  assert.equal(app.clicks(), 0);
});
