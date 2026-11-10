const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSource = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

// Exercise the actual content script. ChatGPT can replace an assistant DOM
// element without creating a new assistant reply.
function createHarness() {
  let time = 0;
  let timerId = 0;
  let clicks = 0;
  let response = null;
  let poll;
  let userMessages = [userNode("Ну давай пиши готово")];
  let sendAvailable = true;
  let stopVisible = false;
  let stopClicks = 0;
  const jobs = new Map();

  function userNode(text) {
    return {
      innerText: text,
      getClientRects: () => [1],
      compareDocumentPosition(other) {
        return other === response ? 4 : 2;
      },
      contains: () => false
    };
  }

  const assistantNode = () => ({
    innerText: "!!!ГОТОВО!!!",
    getClientRects: () => [1],
    closest: () => null,
    contains: () => false
  });
  const editor = {
    tagName: "DIV",
    isContentEditable: true,
    innerText: "",
    getClientRects: () => [1],
    focus() {},
    dispatchEvent() {}
  };
  const send = {
    get disabled() { return !sendAvailable; },
    getClientRects: () => [1],
    getAttribute: () => null,
    click() {
      clicks++;
      editor.innerText = ""; // ChatGPT clears the composer on submit.
      response = assistantNode(); // ChatGPT re-renders the SAME old answer.
    }
  };
  const stop = {
    getClientRects: () => [1],
    getAttribute(name) { return name === "aria-label" ? "Остановить генерацию" : null; },
    click() { stopClicks++; }
  };
  const document = {
    documentElement: {},
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand(command, unused, value) {
      if (command !== "insertText") return false;
      editor.innerText = value;
      return true;
    },
    querySelectorAll(selector) {
      if (selector === '[data-user-message-bubble="true"]') return userMessages;
      if (selector.includes('button[data-testid="stop-button"]')) return stopVisible ? [stop] : [];
      if (selector.includes('[contenteditable="true"][role="textbox"]')) return [editor];
      if (selector.includes('aria-label="Отправить"')) return [send];
      if (selector.includes('[data-message-author-role="assistant"]')) {
        return response ? [response] : [];
      }
      return [];
    }
  };
  const context = {
    document, Map, Set, WeakMap, Promise, console,
    location: { hostname: "chatgpt.com", href: "https://chatgpt.com/c/sample" },
    Date: class extends Date { static now() { return time; } },
    getComputedStyle: () => ({ visibility: "visible" }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    setTimeout(fn, ms) {
      const id = ++timerId;
      jobs.set(id, { due: time + ms, fn });
      return id;
    },
    clearTimeout(id) { jobs.delete(id); },
    setInterval(fn) { poll = fn; return 1; },
    MutationObserver: class { observe() {} },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (msg) => msg.type === "GET_CONFIG" ? {
        enabled: true,
        marker: "!!!ГОТОВО!!!",
        reply: "Ок, продолжаем",
        delaySeconds: 5
      } : null
    } }
  };
  vm.createContext(context);
  vm.runInContext(coreSource, context);
  vm.runInContext(contentSource, context);

  async function flush() {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  async function advance(ms) {
    time += ms;
    for (let pass = 0; pass < 15; pass++) {
      const due = [...jobs].filter(([, task]) => task.due <= time);
      if (!due.length) break;
      for (const [id, task] of due) {
        jobs.delete(id);
        task.fn();
      }
      await flush();
    }
  }
  async function baseline() {
    await flush(); // GET_CONFIG enables monitoring.
    poll(); // Empty conversation: establishes initial state.
    response = assistantNode();
    poll();
  }
  async function sendFirst() {
    await baseline();
    await advance(1600);
    poll(); // Schedules the initial 5-second delay.
    await advance(5000);
    await advance(250);
    assert.equal(clicks, 1);
  }

  return {
    advance, baseline, poll, sendFirst,
    clicks: () => clicks,
    nextUser() { userMessages.push(userNode("Ок, продолжаем")); },
    nextAssistant() { response = assistantNode(); },
    rerenderOldTurn() {
      userMessages = userMessages.map(item => userNode(item.innerText));
      response = assistantNode();
    },
    enableSend(enabled) { sendAvailable = enabled; },
    showStop(value) { stopVisible = value; },
    stopClicks: () => stopClicks
  };
}

test("a React rerender of a submitted marker cannot send a second follow-up", async () => {
  const chat = createHarness();
  await chat.sendFirst();
  // This is the actual v0.1.7 bug: same marker, new HTML element.
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
});

test("real duplicate: React rerenders BOTH user and assistant DOM nodes", async () => {
  const chat = createHarness();
  await chat.sendFirst();
  chat.rerenderOldTurn(); // No new user turn was sent.
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
});

test("a new user turn is not sent during cooldown; can send after 45 seconds", async () => {
  const chat = createHarness();
  await chat.sendFirst();
  chat.nextUser();
  chat.nextAssistant();
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1); // second turn must respect cooldown
  await chat.advance(45000);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 2);
});

test("a visible Stop control blocks scheduling, then permits Send after generation ends", async () => {
  const chat = createHarness();
  await chat.baseline();
  chat.showStop(true);
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  assert.equal(chat.clicks(), 0);
  assert.equal(chat.stopClicks(), 0);
  chat.showStop(false);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
  assert.equal(chat.stopClicks(), 0);
});

test("Stop appearing after editor fill prevents the imminent click", async () => {
  const chat = createHarness();
  await chat.baseline();
  chat.enableSend(false);
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  chat.showStop(true);
  await chat.advance(250);
  assert.equal(chat.clicks(), 0);
  assert.equal(chat.stopClicks(), 0);
});

test("polling while the send button becomes available cannot double-submit", async () => {
  const chat = createHarness();
  await chat.baseline();
  chat.enableSend(false);
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000); // fillEditor is called, waiting for button
  chat.poll(); // a second polling pass occurs while the first send is pending
  await chat.advance(250);
  chat.enableSend(true);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
  await chat.advance(5000); // a stale pending timer might otherwise fire
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
});
