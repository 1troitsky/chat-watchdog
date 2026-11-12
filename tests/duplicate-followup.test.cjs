const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const coreSource = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

// Exercise the actual content script. ChatGPT can replace an assistant DOM
// element without creating a new assistant reply.
function createHarness(options = {}) {
  let time = 0;
  let timerId = 0;
  let clicks = 0;
  let response = null;
  let replyId = 1;
  let assistantHistory = [];
  let poll;
  let messageListener;
  const sentRuntimeMessages = [];
  const claims = options.claims || new Set();
  let errorVisible = false;
  let userMessages = [userNode("Ну давай пиши готово")];
  let sendAvailable = true;
  let stopVisible = false;
  let stopClicks = 0;
  let claimsMade = 0;
  const claimMessages = [];
  const jobs = new Map();

  function userNode(text, afterReplyId = 0) {
    return {
      innerText: text,
      afterReplyId,
      getClientRects: () => [1],
      compareDocumentPosition(other) {
        // The latest user bubble follows the preceding answer but precedes
        // the next generated assistant reply. Simulate the real DOM ordering.
        return other === response && replyId > afterReplyId ? 4 : 2;
      },
      contains: () => false
    };
  }

  const assistantNode = () => {
    const id = "stable-assistant-reply-" + replyId;
    const node = {
      innerText: options.replyText || "!!!ГОТОВО!!!",
      getClientRects: () => [1],
      closest(selector) {
        if (options.noReplyIds) return null;
        return selector === "[data-turn-key]" ? node : null;
      },
      getAttribute(name) { return name === "data-turn-key" ? id : null; },
      contains: () => false
    };
    return node;
  };
  const editor = {
    id: "prompt-textarea",
    tagName: "DIV",
    isContentEditable: true,
    innerText: "",
    textContent: "",
    getClientRects: () => [1],
    focus() {},
    dispatchEvent() {},
    closest(selector) { return selector === "form" ? composerForm : null; }
  };
  const ghostEditor = {
    id: "pending-conversation-input",
    tagName: "DIV", isContentEditable: true,
    innerText: "Старый текст в другом поле", textContent: "Старый текст в другом поле",
    getClientRects: () => [1],
    closest() { return null; }
  };
  const composerForm = {
    querySelector(selector) {
      return selector.includes('send-button') ? send : null;
    }
  };
  const send = {
    get disabled() { return !sendAvailable; },
    getClientRects: () => [1],
    getAttribute: () => null,
    click() {
      clicks++;
      editor.innerText = ""; // ChatGPT clears the composer on submit.
      if (options.hiddenDomTextAfterSend) editor.textContent = "Ок, продолжаем";
      response = assistantNode(); // React repaints the old reply, not a new turn.
      assistantHistory[assistantHistory.length - 1] = response;
    }
  };
  const stop = {
    getClientRects: () => [1],
    getAttribute(name) { return name === "aria-label" ? "Остановить генерацию" : null; },
    click() { stopClicks++; }
  };
  const alert = {
    innerText: "Нет ответа от ChatGPT. Проверьте подключение к интернету",
    children: [],
    getClientRects: () => [1]
  };
  const document = {
    documentElement: {},
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      const close = { addEventListener() {}, focus() {} };
      return {
        style: {}, remove() {}, setAttribute() {}, attachShadow() {
          return {
            innerHTML: "",
            getElementById() { return { textContent: "" }; },
            querySelector() { return close; }
          };
        }
      };
    },
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand(command, unused, value) {
      if (command !== "insertText") return false;
      editor.innerText = value;
      return true;
    },
    querySelectorAll(selector) {
      if (selector === '[data-user-message-bubble="true"]') return userMessages;
      if (selector.startsWith('[role="alert"], [role="status"]')) return errorVisible ? [alert] : [];
      if (selector.includes('button[data-testid="stop-button"]')) return stopVisible ? [stop] : [];
      if (selector.includes('[contenteditable="true"][role="textbox"]'))
        return options.ghostComposerFirst ? [ghostEditor, editor] : [editor];
      if (selector.includes('aria-label="Отправить"')) return [send];
      if (selector.includes('[data-message-author-role="assistant"]')) {
        return assistantHistory.slice();
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
      onMessage: { addListener(fn) { messageListener = fn; } },
      sendMessage: async (msg) => {
        sentRuntimeMessages.push(msg.type);
        if (msg.type === "GET_SEND_STATE") return { ok: true, lockedUntil: options.lockedUntil || 0 };
        if (msg.type === "CLAIM_SEND") {
          claimMessages.push(msg);
          if (options.rejectClaimReason)
            return { ok: false, reason: options.rejectClaimReason };
          if (claims.has(msg.token)) return { ok: false, reason: "duplicate" };
          claims.add(msg.token);
          claimsMade++;
          if (options.disableSendAfterFirstClaim && claimsMade === 1)
            sendAvailable = false; // ChatGPT swapped buttons during async worker claim
          return { ok: true, leaseId: "lease:" + claimsMade, lockedUntil: time + 30000 };
        }
        if (msg.type === "RELEASE_UNCLICKED_SEND") {
          claims.delete(msg.token);
          return { ok: true, lockedUntil: 0 };
        }
        return msg.type === "GET_CONFIG" ? {
        enabled: true,
        mode: options.mode || "auto",
        markerRegex: options.markerRegex === true,
        marker: options.marker !== undefined ? options.marker : "!!!ГОТОВО!!!",
        reply: "Ок, продолжаем",
        completionAudioName: options.completionAudioName || "",
        missingMarkerError: options.missingMarkerError === true,
        delaySeconds: options.delaySeconds !== undefined ? options.delaySeconds : 5,
        delaySecondsVersion: 3
      } : null;
      }
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
    assistantHistory.push(response);
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

  function diagnose() {
    let snapshot;
    messageListener({ type: "WATCHDOG_DIAGNOSE" }, null, result => { snapshot = result; });
    return snapshot;
  }

  return {
    advance, baseline, poll, sendFirst, diagnose,
    clicks: () => clicks,
    claimsMade: () => claimsMade, claimMessages,
    nextUser() { userMessages.push(userNode("Ок, продолжаем", replyId)); },
    nextAssistant() { replyId++; response = assistantNode(); assistantHistory.push(response); },
    virtualizeNextAssistant() { replyId++; response = assistantNode(); assistantHistory[assistantHistory.length - 1] = response; },
    rerenderOldTurn() {
      userMessages = userMessages.map(item => userNode(item.innerText, item.afterReplyId));
      response = assistantNode();
      assistantHistory[assistantHistory.length - 1] = response;
    },
    enableSend(enabled) { sendAvailable = enabled; },
    setError(visible) { errorVisible = visible; },
    sentRuntimeMessages,
    changeMode(mode) {
      messageListener({ type: "WATCHDOG_CONFIG", config: {
        enabled: true, mode,
        marker: options.marker !== undefined ? options.marker : "!!!ГОТОВО!!!",
        delaySeconds: options.delaySeconds !== undefined ? options.delaySeconds : 5,
        delaySecondsVersion: 3, cooldownSeconds: 45,
        reply: "Ок, продолжаем", completionAudioName: options.completionAudioName || ""
      } });
    },
    showStop(value) { stopVisible = value; },
    setEditorText(value) { editor.innerText = value; },
    editorText: () => editor.innerText,
    setAssistantText(value) { if (response) response.innerText = value; },
    journal() {
      let events = [];
      messageListener({ type: "WATCHDOG_LOG" }, null, reply => { events = reply.events; });
      return events;
    },
    stopClicks: () => stopClicks
  };
}

test("two content-script instances must not click Send for the same answer", async () => {
  const claims = new Set();
  const first = createHarness({ claims });
  const second = createHarness({ claims });
  await first.baseline();
  await second.baseline();
  await first.advance(1600);
  await second.advance(1600);
  first.poll();
  second.poll();
  await first.advance(5000);
  await second.advance(5000);
  await first.advance(250);
  await second.advance(250);
  assert.equal(first.clicks() + second.clicks(), 1);
  assert.equal(claims.size, 1);
});

test("a marker at the very beginning of the answer triggers exactly one Send", async () => {
  const chat = createHarness({ replyText: "!!!ГОТОВО!!!\nОтчёт о проверке." });
  await chat.sendFirst();
  await chat.advance(90000);
  chat.poll();
  assert.equal(chat.clicks(), 1);
});

test("a Regex match at the start also triggers a single Send", async () => {
  const chat = createHarness({
    marker: "/!!!ГОТОВО!!!/i", markerRegex: true,
    replyText: "!!!ГОТОВО!!!\nОтчёт о проверке."
  });
  await chat.sendFirst();
  await chat.advance(90000);
  chat.poll();
  assert.equal(chat.clicks(), 1);
});

test("a marker in the middle of an answer must never send", async () => {
  const chat = createHarness({ replyText: "Отчёт\n!!!ГОТОВО!!!\nЕщё текст." });
  await chat.baseline();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(60000);
  chat.poll();
  assert.equal(chat.clicks(), 0);
});

test("error-only mode never schedules or sends even when marker is present", async () => {
  const chat = createHarness({ mode: "errors" });
  await chat.baseline();
  chat.poll();
  await chat.advance(70000);
  chat.poll();
  await chat.advance(70000);
  assert.equal(chat.clicks(), 0);
});

test("error-only mode still displays the error and triggers the audio event", async () => {
  const chat = createHarness({ mode: "errors" });
  await chat.baseline();
  chat.setError(true);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_ERROR").length, 1);
  await chat.advance(120000);
  chat.poll();
  assert.equal(chat.clicks(), 0);
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_ERROR").length, 1);
});

test("switching to error-only mode cancels the delayed send", async () => {
  const chat = createHarness();
  await chat.baseline();
  await chat.advance(1600);
  chat.poll(); // 5-second send timer is armed
  chat.changeMode("errors");
  await chat.advance(10000);
  assert.equal(chat.clicks(), 0);
});

test("switching to error-only mode during async send-button wait prevents clicking", async () => {
  const chat = createHarness();
  await chat.baseline();
  chat.enableSend(false);
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000); // Editor has been filled, button is still disabled
  chat.changeMode("errors");
  chat.enableSend(true);
  await chat.advance(10000);
  assert.equal(chat.clicks(), 0);
});

test("switching back to auto mode does not replay a previously visible reply", async () => {
  const chat = createHarness({ mode: "errors" });
  await chat.baseline();
  chat.changeMode("auto");
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  assert.equal(chat.clicks(), 0);
  chat.nextUser();
  chat.nextAssistant();
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
});

test("markerless mode requires longer stable text and still sends only once", async () => {
  const chat = createHarness({ marker: "", replyText: "Работа завершена." });
  await chat.baseline();
  await chat.advance(2000);
  chat.poll();
  assert.equal(chat.clicks(), 0);
  await chat.advance(3000);
  chat.poll(); // Stable 5 seconds, now we may start 5-second delay.
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
  await chat.advance(46000);
  chat.poll();
  await chat.advance(5000);
  assert.equal(chat.clicks(), 1);
});

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

test("a new user bubble and React repaint cannot resend the same assistant reply", async () => {
  const chat = createHarness();
  await chat.sendFirst();
  chat.nextUser();
  chat.rerenderOldTurn();
  await chat.advance(90000);
  chat.poll();
  await chat.advance(7000);
  chat.poll();
  assert.equal(chat.clicks(), 1);
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "CLAIM_SEND").length, 1);
});

test("identical marker on a different assistant reply with its own turn ID can send", async () => {
  const chat = createHarness();
  await chat.sendFirst();
  chat.nextUser();
  chat.nextAssistant();
  await chat.advance(46000);
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 2);
});

test("ID-less fallback fails closed on a replayed identical assistant reply", async () => {
  const chat = createHarness({ noReplyIds: true });
  await chat.sendFirst();
  chat.nextUser();
  chat.rerenderOldTurn();
  await chat.advance(90000);
  chat.poll();
  await chat.advance(7000);
  chat.poll();
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
  chat.poll(); // Cooldown expired; this pass establishes stability baseline.
  await chat.advance(1600);
  chat.poll(); // Now the follow-up timer may be armed.
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


test("repainted answer gets a different DOM ID but same ordinal", async () => {
  const chat = createHarness();
  await chat.sendFirst();
  chat.nextUser();
  chat.rerenderOldTurn();
  await chat.advance(90000);
  chat.poll();
  await chat.advance(10000);
  assert.equal(chat.clicks(), 1);
});

test("different answer after previous claim increments assistant ordinal", async () => {
  const chat = createHarness();
  await chat.sendFirst();
  chat.nextUser();
  chat.nextAssistant();
  await chat.advance(46000);
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 2);
});


test("persisted cooldown suppresses all completion checks, scheduling and edits", async () => {
  const chat = createHarness({ lockedUntil: 60000 });
  await chat.baseline();
  chat.poll();
  await chat.advance(15000);
  chat.poll();
  await chat.advance(44000);
  chat.poll();
  assert.equal(chat.clicks(), 0);
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "CLAIM_SEND").length, 0);
  await chat.advance(1000); // Global cooldown expires.
  chat.poll(); // This reply existed DURING lockout: it is acknowledged only.
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 0, "old replies from cooldown must never catch up");
  chat.nextUser();
  chat.nextAssistant();
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1, "a NEW reply after cooldown can send");
});

test("persistent cooldown prevents completion timers even after local content reinit", async () => {
  const first = createHarness({ lockedUntil: 90000 });
  const reloaded = createHarness({ lockedUntil: 90000 });
  await first.baseline();
  await reloaded.baseline();
  for (const instance of [first, reloaded]) {
    instance.poll();
    await instance.advance(80000);
    instance.poll();
    assert.equal(instance.clicks(), 0);
    assert.equal(instance.sentRuntimeMessages.filter(x => x === "CLAIM_SEND").length, 0);
  }
});


test("30-second post-marker delay never sends at 5 or 29 seconds", async () => {
  const chat = createHarness({ delaySeconds: 30 });
  await chat.baseline();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  chat.poll();
  assert.equal(chat.clicks(), 0);
  await chat.advance(24000); // 29 seconds since scheduling.
  assert.equal(chat.clicks(), 0);
  await chat.advance(1000); // 30-second delay expires.
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
});


test("a pending 30s attempt reports its absolute deadline, then why it was cancelled", async () => {
  const chat = createHarness({ delaySeconds: 30 });
  await chat.baseline();
  await chat.advance(1600);
  chat.poll();
  const before = chat.diagnose();
  assert.equal(before.pending, true);
  assert.equal(before.scheduledSendAt, 31600);
  chat.nextUser(); // The human has typed another message during the delay.
  chat.poll();
  const after = chat.diagnose();
  assert.equal(after.pending, false);
  assert.match(after.lastAutoDecision, /Таймер отменён/);
  await chat.advance(90000);
  assert.equal(chat.clicks(), 0);
});

test("the expired timer reports Stop as the cancellation reason, not a fake send", async () => {
  const chat = createHarness({ delaySeconds: 30 });
  await chat.baseline();
  await chat.advance(1600);
  chat.poll();
  chat.showStop(true);
  await chat.advance(30000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 0);
  assert.match(chat.diagnose().lastAutoDecision, /Stop/);
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "CLAIM_SEND").length, 0);
});


test("busy input retries five times, then stays quiet while a new reply remains eligible", async () => {
  const chat = createHarness();
  await chat.baseline();
  chat.setEditorText("Мой черновик — не перезаписывать");
  await chat.advance(1600);
  chat.poll();
  for (let i = 0; i < 5; i++) {
    await chat.advance(5000);
    chat.poll();
  }
  const busy = () => chat.journal().filter(e => e.message.startsWith("Поле ввода занято:"));
  assert.equal(busy().length, 5, "five genuine timer-triggered failed attempts");
  assert.equal(chat.journal().filter(e => /Лимит 5\/5/.test(e.message)).length, 1);
  assert.equal(chat.diagnose().enabled, true);
  assert.equal(chat.diagnose().pending, false);
  await chat.advance(120000);
  for (let i = 0; i < 10; i++) chat.poll();
  assert.equal(busy().length, 5, "old reply must not be retried");
  assert.equal(chat.clicks(), 0);
  chat.setEditorText("");
  chat.nextUser();
  chat.nextAssistant();
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1, "new assistant reply still sends");
});

test("streaming marked text does not spend send attempts before the timer fires", async () => {
  const chat = createHarness({ replyText: "!!!ГОТОВО!!!\nНачало" });
  await chat.baseline();
  for (let i = 0; i < 7; i++) {
    chat.setAssistantText("!!!ГОТОВО!!!\nНовая строка " + i);
    chat.poll();
    await chat.advance(1600);
    chat.poll();
  }
  assert.equal(chat.journal().filter(e => /Лимит 5\/5/.test(e.message)).length, 0);
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1, "finally completed reply should send");
});


test("visually empty composer is not blocked by residual hidden textContent", async () => {
  const chat = createHarness({ hiddenDomTextAfterSend: true });
  await chat.sendFirst();
  chat.nextUser();
  chat.nextAssistant();
  await chat.advance(46000);
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 2, "second reply must work even when hidden DOM text persists");
  const snapshot = chat.diagnose();
  assert.equal(snapshot.editorFound, true);
  assert.equal(snapshot.editorEmpty, true, "empty innerText must override stale textContent");
  assert.equal(snapshot.editorHiddenDomText, true);
  assert.equal(snapshot.editorRenderedLength, 0);
});

test("a stale secondary editor must not block the live ChatGPT composer", async () => {
  const chat = createHarness({ ghostComposerFirst: true });
  await chat.baseline();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1, "send uses live composer, not stale DOM-first candidate");
  const snapshot = chat.diagnose();
  assert.equal(snapshot.editorCandidates, 2);
  assert.equal(snapshot.editorElement, "prompt-textarea");
  assert.equal(snapshot.editorEmpty, true);
});

test("an actual user draft in the live composer remains untouched", async () => {
  const chat = createHarness({ ghostComposerFirst: true });
  await chat.baseline();
  chat.setEditorText("Набираю сообщение вручную");
  await chat.advance(1600);
  chat.poll();
  for (let i = 0; i < 5; i++) {
    await chat.advance(5000);
    chat.poll();
  }
  assert.equal(chat.clicks(), 0);
  assert.equal(chat.editorText(), "Набираю сообщение вручную");
  assert.equal(chat.diagnose().editorEmpty, false);
});


test("a zero-width-only composer is considered empty", async () => {
  const chat = createHarness();
  await chat.baseline();
  chat.setEditorText("\u200B\uFEFF");
  assert.equal(chat.diagnose().editorEmpty, true);
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
});


test("bundled completion sound plays without custom audio selection and only once per answer", async () => {
  const chat = createHarness({ mode: "errors", completionAudioName: "",
    marker: "!!!ГОТОВО!!!", replyText: "Ответ без маркера" });
  await chat.baseline();
  await chat.advance(3100);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_COMPLETION").length, 1,
    "default sound must be requested even when completionAudioName is empty");
  chat.rerenderOldTurn();
  await chat.advance(8000);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_COMPLETION").length, 1,
    "same assistant answer must not replay its completion sound");
  chat.nextUser();
  chat.nextAssistant();
  chat.poll();
  await chat.advance(3100);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_COMPLETION").length, 2,
    "a new assistant answer gets one new bundled completion sound");
});

test("completion sound plays exactly once for a markerless reply, even in errors-only mode", async () => {
  const chat = createHarness({ mode: "errors", completionAudioName: "done.mp3",
    marker: "!!!ГОТОВО!!!", replyText: "Обычный ответ без маркера" });
  await chat.baseline();
  await chat.advance(3100);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_COMPLETION").length, 1);
  chat.rerenderOldTurn();
  chat.poll();
  await chat.advance(20000);
  for (let i = 0; i < 5; i++) chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_COMPLETION").length, 1,
    "rerenders and repeated polling must not replay the completion audio");
  assert.equal(chat.clicks(), 0, "errors-only never auto-sends");
  chat.nextUser();
  chat.nextAssistant();
  chat.poll();
  await chat.advance(3100);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_COMPLETION").length, 2,
    "next genuinely new reply gets its own completion alert");
});

test("completion audio waits for Stop to vanish and stays silent during streaming", async () => {
  const chat = createHarness({ mode: "errors", completionAudioName: "done.mp3",
    replyText: "Обычный ответ" });
  await chat.baseline();
  chat.showStop(true);
  chat.poll();
  await chat.advance(25000);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_COMPLETION").length, 0);
  chat.showStop(false);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_COMPLETION").length, 0);
  await chat.advance(3100);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_COMPLETION").length, 1);
});

test("continue-only ignores error alerts yet sends the next marked reply", async () => {
  const chat = createHarness({ mode: "continue", completionAudioName: "done.mp3" });
  await chat.baseline();
  chat.setError(true);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_ERROR").length, 0);
  await chat.advance(3100);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === "PLAY_COMPLETION").length, 1);
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
});

test("persistent Stop costs five scheduled attempts, then leaves monitor ready for next turn", async () => {
  const chat = createHarness();
  await chat.baseline();
  chat.showStop(true);
  chat.poll();
  await chat.advance(6000);
  chat.poll();
  for (let i = 0; i < 5; i++) {
    await chat.advance(5000);
    chat.poll();
  }
  const stopFailures = () => chat.journal().filter(x => x.message.startsWith("Кнопка Stop блокирует отправку:"));
  assert.equal(stopFailures().length, 5);
  assert.equal(chat.diagnose().enabled, true);
  assert.equal(chat.diagnose().pending, false);
  await chat.advance(120000);
  for (let i = 0; i < 8; i++) chat.poll();
  assert.equal(stopFailures().length, 5);
  chat.showStop(false);
  chat.nextUser();
  chat.nextAssistant();
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 1);
});

test('pre-click Send button disappearance releases claim and retries existing Watchdog draft', async () => {
  const chat = createHarness({disableSendAfterFirstClaim: true});
  await chat.baseline();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(300);
  assert.equal(chat.clicks(), 0, 'must not click a missing Send button');
  assert.equal(chat.editorText(), 'Ок, продолжаем', 'Watchdog draft should remain available');
  assert.ok(chat.sentRuntimeMessages.includes('RELEASE_UNCLICKED_SEND'),
    'reservation must be released before a retry');
  chat.enableSend(true);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(300);
  assert.equal(chat.clicks(), 1, 'next scheduled attempt should submit the existing draft');
  assert.equal(chat.claimsMade(), 2);
  await chat.advance(90000);
  chat.poll();
  assert.equal(chat.clicks(), 1, 'never send duplicates after one click');
});

test('an auto-reply already in the composer is reused and sent exactly once', async () => {
  const chat = createHarness();
  await chat.baseline();
  // Intentional policy: even manually typed identical text is eligible.
  chat.setEditorText('Ок, продолжаем');
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(300);
  assert.equal(chat.clicks(), 1, 'click Send for the exact configured reply');
  assert.equal(chat.editorText(), '', 'ChatGPT clears the composer on submit');
  assert.equal(chat.claimsMade(), 1);
  await chat.advance(100000);
  for (let i = 0; i < 8; i++) chat.poll();
  assert.equal(chat.clicks(), 1, 'must not submit the same assistant reply twice');
});

test('almost-matching user draft remains protected', async () => {
  const chat = createHarness();
  await chat.baseline();
  chat.setEditorText('Ок, продолжаем!');
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(300);
  assert.equal(chat.clicks(), 0, 'a different draft must not be sent');
  assert.equal(chat.editorText(), 'Ок, продолжаем!');
  assert.equal(chat.claimsMade(), 0);
});

test('replayed assistant turn cannot send existing matching text twice', async () => {
  const chat = createHarness();
  await chat.sendFirst();
  chat.setEditorText('Ок, продолжаем');
  chat.poll();
  await chat.advance(70000);
  for (let i = 0; i < 8; i++) chat.poll();
  assert.equal(chat.clicks(), 1, 'deduplication still forbids a replay');
  assert.equal(chat.editorText(), 'Ок, продолжаем', 'do not touch the draft of a handled turn');
});

test('explicit stream failure is recognized even when completion marker is present', async () => {
  const chat = createHarness({mode:'auto'});
  await chat.baseline();
  chat.nextUser(); chat.nextAssistant();
  chat.setAssistantText('!!!ГОТОВО!!!\nОшибка в потоке сообщений.');
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === 'PLAY_ERROR').length, 1);
  assert.equal(chat.clicks(), 0);
});

test('optional missing-marker alert triggers once only after response stabilizes', async () => {
  const chat = createHarness({ mode:'errors', missingMarkerError:true });
  await chat.baseline();
  chat.nextUser(); chat.nextAssistant();
  chat.setAssistantText('Текст оборвался без специального маркера.');
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === 'PLAY_ERROR').length, 0);
  await chat.advance(12000);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === 'PLAY_ERROR').length, 1);
  await chat.advance(60000);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === 'PLAY_ERROR').length, 1,
    'same incomplete reply must not retrigger');
});

test('missing marker is never an error by default', async () => {
  const chat = createHarness({mode:'errors'});
  await chat.baseline();
  chat.nextUser(); chat.nextAssistant();
  chat.setAssistantText('Обычный ответ без маркера');
  chat.poll();
  await chat.advance(30000);
  chat.poll();
  assert.equal(chat.sentRuntimeMessages.filter(x => x === 'PLAY_ERROR').length, 0);
});


test("a fresh reply at a recycled assistant ordinal sends after prior success", async () => {
  const chat = createHarness();
  await chat.sendFirst();
  chat.nextUser();
  chat.virtualizeNextAssistant(); // DOM replaced its old assistant slot: ordinal remains one.
  await chat.advance(46000);
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  await chat.advance(5000);
  await chat.advance(250);
  assert.equal(chat.clicks(), 2, "new stable reply identity must override recycled ordinal");
  assert.equal(chat.claimMessages[0].assistantOrdinal, chat.claimMessages[1].assistantOrdinal);
  assert.equal(chat.claimMessages[0].assistantStable, true);
  assert.equal(chat.claimMessages[1].assistantStable, true);
  assert.notEqual(chat.claimMessages[0].userTurnKey, chat.claimMessages[1].userTurnKey);
});

test("background rejection reason is logged, and stops after exactly five attempts", async () => {
  const chat = createHarness({ rejectClaimReason: "assistant-already-handled" });
  await chat.baseline();
  chat.poll();
  await chat.advance(1600);
  chat.poll();
  for (let n = 0; n < 60 && chat.claimMessages.length < 5; n++) {
    await chat.advance(1000);
    chat.poll();
  }
  await chat.advance(1000);
  chat.poll();
  assert.equal(chat.clicks(), 0);
  assert.equal(chat.claimMessages.length, 5);
  assert.equal(chat.diagnose().lastClaimRejectReason, "assistant-already-handled");
  assert.equal(chat.diagnose().pending, false);
  await chat.advance(100000);
  for (let n = 0; n < 4; n++) chat.poll();
  assert.equal(chat.claimMessages.length, 5);
  assert.equal(chat.diagnose().enabled, true);
});
