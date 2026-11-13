const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSource = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function createChat(options = {}) {
  const phrase = "!!!У НАС ПРОБЛЕМА!!!";
  let now = 10000, nextTimer = 0;
  let poll, inspectMutations, keydown;
  let statusVisible = false;
  let assistant = null;
  let users = [];
  const jobs = new Map();
  const mutations = [];
  const sent = [];
  const ui = [];
  const pageAttributes = options.pageAttributes || {};
  const activeDialogLeases = options.activeDialogLeases || new Set();
  const playedAudioIncidents = options.playedAudioIncidents || new Set();
  let soundPlayed = 0;
  let leasesIssued = 0;

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

  const maxLengthError = "Вы достигли максимальной длины этого обсуждения, но можете продолжить обсуждение, начав новый чат.";
  let status = node(options.alertWithAction ? maxLengthError + "\nНачать новый чат" : phrase);
  if (options.alertWithAction) {
    status.getAttribute = name => name === "role" ? "alert" : null;
    status.cloneNode = () => ({
      textContent: maxLengthError, // Removing the action button in the cloned alert.
      querySelectorAll: () => []
    });
    status.closest = selector => {
      if (options.alertInsideUser && selector.includes('[data-user-message-bubble]'))
        return {};
      if (options.alertInsideAssistant && selector.includes('[data-message-author-role="assistant"]'))
        return assistant || {};
      if (selector.includes('main, [role="main"]')) return {};
      return null;
    };
  }
  // A ChatGPT limit warning can be a plain sibling <div>, not a toast or p.
  // Keep it outside the user/assistant message elements in this harness.
  const systemDiv = options.systemDomText ? node(options.systemDomText) : null;
  if (systemDiv) {
    systemDiv.closest = selector => options.systemDomInsideUser &&
      selector.includes('[data-user-message-bubble]') ? {} : null;
    if (options.systemDomWrapsHistory)
      systemDiv.querySelector = () => node('old message');
  }
  if (options.statusWrapsHistory) status.querySelector = () => node('old chat turn');
  const body = {
    contains(other) { return other === status || other === assistant || ui.includes(other); },
    appendChild(element) {
      ui.push(element);
      mutations.push({ type: "childList", target: body, addedNodes: [element], removedNodes: [] });
    },
    querySelectorAll() { return []; }
  };

  const document = {
    documentElement: {
      getAttribute(name) { return pageAttributes[name] || null; },
      setAttribute(name, value) { pageAttributes[name] = value; }
    },
    body,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === 'div, span, p, [role="paragraph"]')
        return systemDiv ? [systemDiv] : [];
      if (selector === "#chat-watchdog-alert-host")
        return ui.filter(n => n.id === "chat-watchdog-alert-host");
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
    setInterval(fn) { poll = fn; },
    MutationObserver: class {
      constructor(fn) { inspectMutations = fn; }
      observe() {}
    },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        sent.push(msg.type);
        if (msg.type === "PLAY_ERROR" && msg.incidentKey) {
          if (playedAudioIncidents.has(msg.incidentKey))
            return { ok: false, reason: "audio-incident-duplicate" };
          playedAudioIncidents.add(msg.incidentKey);
          soundPlayed++;
          return { ok: true };
        }
        if (msg.type === "CLAIM_ERROR_DIALOG") {
          if (activeDialogLeases.size) return { ok: false, reason: "dialog-already-open" };
          const leaseId = "error:" + (++leasesIssued);
          activeDialogLeases.add(leaseId);
          return { ok: true, leaseId };
        }
        if (msg.type === "RELEASE_ERROR_DIALOG") {
          if (!activeDialogLeases.has(msg.leaseId)) return { ok: false };
          activeDialogLeases.delete(msg.leaseId);
          return { ok: true };
        }
        if (msg.type === "GET_SEND_STATE") return { ok: true, lockedUntil: 0 };
        return msg.type === "GET_CONFIG" ? {
          enabled: true, mode: "errors", toastEnabled: true,
          errorWords: [
            "!!!У НАС ПРОБЛЕМА!!!",
            "!!!ЖДУ РЕШЕНИЕ!!!",
            ...(options.alertWithAction ? ["Вы достигли максимальной длины этого обсуждения"] : [])
          ].join("\n")
        } : null;
      }
    } }
  };
  vm.createContext(context);
  vm.runInContext(coreSource, context);
  vm.runInContext(contentSource, context);

  async function start() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    poll();
  }
  async function flush() {
    for (let i = 0; i < 15; i++) await Promise.resolve();
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
      await flush();
    }
    await flush();
  }
  function close() {
    assert.equal(typeof keydown, "function", "dialog should be open");
    keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  }
  return {
    start, poll, close, advance, flush, flushMutations,
    dialogCount() { return ui.filter(n => n.id === "chat-watchdog-alert-host").length; },
    addExternalDialog() {
      const host = node();
      host.id = "chat-watchdog-alert-host";
      body.appendChild(host);
    },
    showStatus(value) { statusVisible = value; },
    changeStatus(value) { status.innerText = value; status.textContent = value; },
    recreateStatus() { status = node(phrase); },
    setAssistant(value) { assistant = node(value); assistant.closest = () => null; },
    newUser(value) {
      const user = node(value);
      user.compareDocumentPosition = target =>
        (options.systemDomBeforeUser && target === systemDiv) ||
        (options.oldAlertBeforeUser && target === status) ? 2 : 4;
      users.push(user);
    },
    count(type) { return type === "PLAY_ERROR" ? soundPlayed : sent.filter(x => x === type).length; }
  };
}

test("own error toast and dialog must not re-trigger an acknowledged error", async () => {
  const app = createChat();
  await app.start();
  app.showStatus(true);
  app.poll(); // Real error => dialog, toast, PLAY_ERROR.
  await app.flush();
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
  await app.flush();
  assert.equal(app.count("PLAY_ERROR"), 1);
  app.close();
  app.flushMutations();
  app.changeStatus("!!!ЖДУ РЕШЕНИЕ!!!");
  app.poll();
  await app.flush();
  assert.equal(app.count("PLAY_ERROR"), 2, "a new error message should still alert");
});

test("repainting an identical assistant error does not re-open its dialog", async () => {
  const app = createChat();
  await app.start();
  app.newUser("Проверка");
  app.setAssistant("!!!У НАС ПРОБЛЕМА!!!");
  app.poll();
  await app.flush();
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
  await app.flush();
  assert.equal(app.count("PLAY_ERROR"), 2, "another user turn is a new error");
});


test("another active Watchdog instance cannot stack a second error dialog", async () => {
  const app = createChat();
  await app.start();
  app.addExternalDialog(); // Simulate an overlay opened by a second copy.
  app.showStatus(true);
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 1, "the existing page-level dialog must be reused");
  assert.equal(app.count("PLAY_ERROR"), 1, "a new incident still sounds when another modal is already open");
});

test("one dismissal removes older duplicate overlays left by another instance", async () => {
  const app = createChat();
  await app.start();
  app.showStatus(true);
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 1);
  app.addExternalDialog();
  app.addExternalDialog();
  assert.equal(app.dialogCount(), 3, "simulate three stacked dialogs");
  app.close();
  assert.equal(app.dialogCount(), 0, "one close must remove all three dialogs");
  app.flushMutations();
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 0, "already acknowledged error stays closed");
});

test("same error from status and assistant is a single dismissed incident", async () => {
  const app = createChat();
  await app.start();
  app.showStatus(true);
  app.poll();
  await app.flush();
  app.close();
  app.setAssistant("!!!У НАС ПРОБЛЕМА!!!"); // A second presentation of the same failure
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 0, "don't reopen the same incident in another UI location");
  assert.equal(app.count("PLAY_ERROR"), 1);
});

test("dismissed error cannot reopen after DOM flickers, even with long gaps", async () => {
  const app = createChat();
  await app.start();
  app.showStatus(true);
  app.poll();
  await app.flush();
  app.close();
  for (let i = 0; i < 6; i++) {
    app.showStatus(false);
    app.poll();
    await app.advance(3500);
    app.showStatus(true);
    app.poll();
    await app.flush();
    assert.equal(app.dialogCount(), 0, "flickering same incident must stay dismissed");
  }
  assert.equal(app.count("PLAY_ERROR"), 1);
  app.newUser("Ещё один запрос");
  app.recreateStatus();
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 1, "a genuinely new error after a new user turn may alert");
  assert.equal(app.count("PLAY_ERROR"), 2);
});

test("dismissal is shared between separate observers on the same page", async () => {
  const pageAttributes = {};
  const first = createChat({ pageAttributes });
  await first.start();
  first.showStatus(true);
  first.poll();
  await first.flush();
  first.close();
  assert.ok(pageAttributes["data-chat-watchdog-error-acks"], "ack in shared DOM");
  const second = createChat({ pageAttributes });
  await second.start();
  second.showStatus(true);
  second.poll();
  await second.flush();
  assert.equal(second.dialogCount(), 0, "reinjected scripts honor prior dismissal");
  assert.equal(second.count("PLAY_ERROR"), 0);
});

test('two independent observers opening errors simultaneously show only one dialog BEFORE dismissal', async () => {
  // Separate simulated page documents (as in isolated frame contexts) share a
  // single background tab-level dialog claim. One must be rejected.
  const activeDialogLeases = new Set();
  const playedAudioIncidents = new Set();
  const first = createChat({activeDialogLeases, playedAudioIncidents});
  const second = createChat({activeDialogLeases, playedAudioIncidents});
  await Promise.all([first.start(), second.start()]);
  first.showStatus(true); second.showStatus(true);
  first.poll(); second.poll(); // Both try to open on the same microtask turn.
  await Promise.all([first.flush(), second.flush()]);
  assert.equal(first.dialogCount() + second.dialogCount(), 1,
    'only one visible modal, before ANY close click');
  assert.equal(first.count('PLAY_ERROR') + second.count('PLAY_ERROR'), 1,
    'the shared alert must not start two error sounds');
  assert.equal(activeDialogLeases.size, 1);
});

test('a marker embedded in the middle of the current answer is not an error', async () => {
  const app = createChat();
  await app.start();
  app.newUser('Проверь ответ');
  app.setAssistant('!!!У НАС ПРОБЛЕМА!!!\n!!!ГОТОВО!!!');
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 0);
  assert.equal(app.count('PLAY_ERROR'), 0);
  app.setAssistant('!!!ГОТОВО!!!\n!!!У НАС ПРОБЛЕМА!!!');
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 1, 'error on last line is eligible');
  assert.equal(app.count('PLAY_ERROR'), 1);
});


test('role=status wrapping chat history is never classified as a new system error', async () => {
  const app = createChat({statusWrapsHistory: true});
  await app.start();
  app.showStatus(true);
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 0);
  assert.equal(app.count('PLAY_ERROR'), 0);
});


test('max-length system error in a standalone ordinary div is detected once', async () => {
  const app = createChat({ systemDomText:
    'Вы достигли максимальной длины этого обсуждения, но можете продолжить обсуждение, начав новый чат.' });
  await app.start();
  app.newUser('Последний запрос');
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 1, 'standalone div must trigger one alert');
  assert.equal(app.count('PLAY_ERROR'), 1);
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 1, 'rerender must not stack alerts');
  app.close();
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 0, 'acknowledged error stays dismissed');
  assert.equal(app.count('PLAY_ERROR'), 1);
});

test('old system error before newest user message is ignored', async () => {
  const app = createChat({ systemDomText:
    'Вы достигли максимальной длины этого обсуждения, но можете продолжить обсуждение, начав новый чат.',
    systemDomBeforeUser: true });
  await app.start();
  app.newUser('Новый запрос уже после старого сообщения');
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 0);
  assert.equal(app.count('PLAY_ERROR'), 0);
});

test('an identical system-error phrase quoted inside a user bubble is ignored', async () => {
  const app = createChat({ systemDomText:
    'Вы достигли максимальной длины этого обсуждения, но можете продолжить обсуждение, начав новый чат.',
    systemDomInsideUser: true });
  await app.start();
  app.newUser('Проверка');
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 0);
  assert.equal(app.count('PLAY_ERROR'), 0);
});

test('a generic div containing old chat turns cannot masquerade as system error', async () => {
  const app = createChat({ systemDomText:
    'Вы достигли максимальной длины этого обсуждения, но можете продолжить обсуждение, начав новый чат.',
    systemDomWrapsHistory: true });
  await app.start();
  app.newUser('Проверка');
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 0);
  assert.equal(app.count('PLAY_ERROR'), 0);
});


test('exact ChatGPT <aside role=alert> containing a recovery button is recognized after !!!ГОТОВО!!!', async () => {
  const app = createChat({ alertWithAction: true });
  await app.start();
  app.newUser('Продолжай');
  app.setAssistant('Ответ ИИ\n!!!ГОТОВО!!!');
  app.showStatus(true);
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 1, 'system error must override completion marker');
  assert.equal(app.count('PLAY_ERROR'), 1);
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 1, 'one error must not create duplicate dialogs');
  assert.equal(app.count('PLAY_ERROR'), 1);
});

test('recovery-button error nested inside current assistant turn is a system alert', async () => {
  const app = createChat({ alertWithAction: true, alertInsideAssistant: true });
  await app.start();
  app.newUser('Продолжай');
  app.setAssistant('Ответ ИИ\n!!!ГОТОВО!!!');
  app.showStatus(true);
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 1);
  assert.equal(app.count('PLAY_ERROR'), 1);
});

test('old max-length alert before current user is not treated as a new error', async () => {
  const app = createChat({ alertWithAction: true, oldAlertBeforeUser: true });
  await app.start();
  app.newUser('Новый запрос');
  app.showStatus(true);
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 0);
  assert.equal(app.count('PLAY_ERROR'), 0);
});

test('max-length alert inside a user message is ignored', async () => {
  const app = createChat({ alertWithAction: true, alertInsideUser: true });
  await app.start();
  app.newUser('Новый запрос');
  app.showStatus(true);
  app.poll();
  await app.flush();
  assert.equal(app.dialogCount(), 0);
  assert.equal(app.count('PLAY_ERROR'), 0);
});
