const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSource = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function createChat({ duplicateInstances = false } = {}) {
  const phrase = "!!!У НАС ПРОБЛЕМА!!!";
  let now = 10000, nextTimer = 0;
  let poll, inspectMutations, keydown;
  const pollers = [];
  let statusVisible = false;
  let assistant = null;
  let users = [];
  const jobs = new Map();
  const mutations = [];
  const sent = [];
  const ui = [];

  function node(text = "") {
    const attrs = {};
    const element = {
      nodeType: 1, textContent: text, innerText: text, id: "",
      children: [], style: {},
      getClientRects: () => [1],
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
      setAttribute(name, value) { attrs[name] = value; },
      closest() { return null; },
      contains(child) { return child === element; },
      remove() {
        const index = ui.indexOf(element);
        if (index >= 0) ui.splice(index, 1);
        mutations.push({ type: "childList", target: body, addedNodes: [], removedNodes: [element] });
      },
      attachShadow() {
        const label = { textContent: "" };
        const close = { addEventListener() {}, focus() {} };
        return {
          innerHTML: "",
          getElementById() { return label; },
          querySelector() { return close; }
        };
      }
    };
    return element;
  }

  const status = node(phrase);
  const body = {
    contains(other) { return other === status || other === assistant || ui.includes(other); },
    appendChild(element) {
      ui.push(element);
      mutations.push({ type: "childList", target: body, addedNodes: [element], removedNodes: [] });
    },
    querySelectorAll() { return []; }
  };

  const rootAttributes = {};
  const document = {
    documentElement: {
      getAttribute(name) { return rootAttributes[name] || null; },
      setAttribute(name, value) { rootAttributes[name] = value; }
    },
    body,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "#chat-watchdog-alert-host") {
        return ui.filter(n => n.id === "chat-watchdog-alert-host");
      }
      if (selector === "[data-chat-watchdog-toast]") {
        return ui.filter(n => n.getAttribute("data-chat-watchdog-toast") !== null);
      }
      if (selector.startsWith('[data-user-message-bubble="true"]')) return users;
      if (selector.startsWith('[role="alert"], [role="status"]')) return statusVisible ? [status] : [];
      if (selector.includes('[data-message-author-role="assistant"]')) return assistant ? [assistant] : [];
      return [];
    },
    createElement: () => node(),
    addEventListener(type, fn) { if (type === "keydown") keydown = fn; },
    removeEventListener(type) { if (type === "keydown") keydown = null; }
  };
  const context = {
    document, Set, Map, WeakMap, Promise, console,
    location: { hostname: "chatgpt.com", href: "https://chatgpt.com/c/test" },
    Date: class extends Date { static now() { return now; } },
    getComputedStyle: () => ({ visibility: "visible" }),
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      jobs.set(id, { due: now + delay, fn });
      return id;
    },
    clearTimeout(id) { jobs.delete(id); },
    setInterval(fn) { if (!poll) poll = fn; pollers.push(fn); },
    MutationObserver: class {
      constructor(fn) { inspectMutations = fn; }
      observe() {}
    },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        sent.push(msg.type);
        if (msg.type === "GET_SEND_STATE") return { ok: true, lockedUntil: 0 };
        return msg.type === "GET_CONFIG" ? {
          enabled: true, mode: "errors", toastEnabled: true,
          errorWords: [
            "!!!У НАС ПРОБЛЕМА!!!",
            "!!!ЖДУ РЕШЕНИЕ!!!"
          ].join("\n")
        } : null;
      }
    } }
  };
  vm.createContext(context);
  vm.runInContext(coreSource, context);
  vm.runInContext(contentSource, context);
  if (duplicateInstances) {
    // Inject the same code in an independent V8 world (as can happen when
    // extension updates overlap) while using the SAME page DOM.
    const second = Object.assign({}, context);
    delete second.globalThis;
    vm.createContext(second);
    vm.runInContext(coreSource, second);
    vm.runInContext(contentSource, second);
  }

  async function start() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    for (const p of pollers) p();
  }
  function flushMutations() {
    for (let i = 0; i < 10 && mutations.length; i++) {
      inspectMutations(mutations.splice(0));
    }
  }
  async function advance(ms) {
    now += ms;
    for (let i = 0; i < 15; i++) {
      const due = [...jobs].filter(([, task]) => task.due <= now);
      if (!due.length) break;
      for (const [id, task] of due) {
        jobs.delete(id);
        task.fn();
      }
      await Promise.resolve();
    }
  }
  function close() {
    assert.equal(typeof keydown, "function", "dialog should be open");
    keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  }
  return {
    start, poll, pollAll() { for (const p of pollers) p(); },
    overlayCount() { return ui.filter(n => n.id === "chat-watchdog-alert-host").length; },
    close, advance, flushMutations,
    showStatus(value) { statusVisible = value; },
    changeStatus(value) { status.innerText = value; status.textContent = value; },
    setAssistant(value) { assistant = node(value); assistant.closest = () => null; },
    newUser(value) {
      const user = node(value);
      user.compareDocumentPosition = () => 4;
      users.push(user);
    },
    count(type) { return sent.filter(x => x === type).length; }
  };
}

test("own error toast and dialog must not re-trigger an acknowledged error", async () => {
  const app = createChat();
  await app.start();
  app.showStatus(true);
  app.poll(); // Real error => dialog, toast, PLAY_ERROR.
  assert.equal(app.count("PLAY_ERROR"), 1);
  app.flushMutations(); // Observer sees our own error text in the toast.
  app.close();
  app.flushMutations(); // Observer sees removal of our own alert dialog.
  for (let i = 0; i < 10; i++) {
    app.poll();
    await app.advance(1600);
    app.flushMutations(); // The toast expires and a debounced poll occurs.
  }
  assert.equal(app.count("PLAY_ERROR"), 1, "old error must stay acknowledged");
  assert.equal(app.count("STOP_ERROR"), 1, "closing dialog must stop the alarm");
});

test("same persistent error is dismissed, but a later changed error alerts", async () => {
  const app = createChat();
  await app.start();
  app.showStatus(true);
  app.poll();
  assert.equal(app.count("PLAY_ERROR"), 1);
  app.close();
  app.flushMutations();
  app.changeStatus("!!!ЖДУ РЕШЕНИЕ!!!");
  app.poll();
  assert.equal(app.count("PLAY_ERROR"), 2, "a new error message should still alert");
});

test("repainting an identical assistant error does not re-open its dialog", async () => {
  const app = createChat();
  await app.start();
  app.newUser("Проверка");
  app.setAssistant("!!!У НАС ПРОБЛЕМА!!!");
  app.poll();
  assert.equal(app.count("PLAY_ERROR"), 1);
  app.close();
  app.flushMutations();
  for (let i = 0; i < 5; i++) {
    app.setAssistant("!!!У НАС ПРОБЛЕМА!!!"); // New DOM node; same logical answer.
    app.poll();
    app.flushMutations();
  }
  assert.equal(app.count("PLAY_ERROR"), 1);
  app.newUser("Продолжи");
  app.setAssistant("!!!У НАС ПРОБЛЕМА!!!");
  app.poll();
  assert.equal(app.count("PLAY_ERROR"), 2, "another user turn is a new error");
});


test("two independent content-script worlds share a SINGLE blocking alert overlay", async () => {
  const app = createChat({ duplicateInstances: true });
  await app.start();
  app.newUser("Проверка");
  app.setAssistant("!!!У НАС ПРОБЛЕМА!!!");
  app.pollAll();
  assert.equal(app.overlayCount(), 1, "only one modal may exist in the DOM");
  assert.equal(app.count("PLAY_ERROR"), 1, "one sound per alert, not one per world");
  app.close();
  assert.equal(app.overlayCount(), 0, "one close clears the entire screen");
  app.pollAll();
  await app.advance(5000);
  app.pollAll();
  assert.equal(app.overlayCount(), 0, "dismissed error must not re-open");
  assert.equal(app.count("PLAY_ERROR"), 1);
});
