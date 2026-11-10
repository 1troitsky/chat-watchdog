const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const popupSource = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

async function createPopup({ clipboardError = false, diagnosticsUnavailable = false } = {}) {
  const elements = new Map();
  const handlers = new Map();
  const sent = [];
  const clipboard = [];
  let diagnosticRequests = 0;
  let logRequests = 0;
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "", textContent: "", checked: false, disabled: false, hidden: false,
        addEventListener(type, handler) { handlers.set(id + ":" + type, handler); }
      });
    }
    return elements.get(id);
  }

  const tab = { id: 9, url: "https://chatgpt.com/c/example" };
  const saved = {
    "tab:9": { enabled: true, mode: "auto", marker: "!!!ГОТОВО!!!",
      delaySeconds: 30, cooldownSeconds: 45, origin: "https://chatgpt.com" },
    "watchdog:send-audit": [{ at: 1000000, tabId: 9, conversationHint: "xample",
      event: "claim", outcome: "allowed", mode: "auto", ordinal: 3 }],
    "watchdog:conversation:https://chatgpt.com/c/example": {
      origin: "https://chatgpt.com", tokens: ["a"], maxAssistantOrdinal: 3,
      lockedUntil: 0
    }
  };
  const chrome = {
    tabs: {
      async query(options) {
        return options?.active ? [tab] :
          [tab, { id: 10, url: "https://chatgpt.com/c/another" }];
      },
      async sendMessage(tabId, message) {
        assert.equal(tabId, 9);
        sent.push(message.type);
        if (message.type === "WATCHDOG_DIAGNOSE") {
          if (diagnosticsUnavailable) throw new Error("content script unavailable");
          return {
            enabled: true, mode: "auto", assistantCount: ++diagnosticRequests,
            assistantDetection: "builtin", legacyAssistantCount: 0,
            chatGptSearchUnitCount: 2, chatGptTurnCount: 2,
            chatGptUserBubbleCount: 3, markerDisabled: false,
            assistantFollowsLastUser: true, markerDetected: true,
            markerAlreadySent: false, logicalUserTurnDetected: true,
            sendClicks: 1, rememberedAssistantReplies: 1,
            assistantOrdinal: 3, lastClaimedAssistantOrdinal: 3,
            cooldownHydrated: true, cooldownRemainingSeconds: 0,
            sending: false, editorFound: true, editorEmpty: true,
            sendButtonFound: false, stopButtonVisible: false,
            pending: false, lastAutoDecision: "Отправлено",
            lastAutoDecisionAt: "12:00:00"
          };
        }
        if (message.type === "WATCHDOG_LOG") {
          logRequests++;
          return { events: [{ time: "12:00:00", message: "Событие #" + logRequests }] };
        }
        throw new Error("Unexpected message " + message.type);
      }
    },
    runtime: { getManifest: () => ({ version: "0.2.11" }), id: "test-extension-id" },
    storage: {
      session: {
        async get(key) {
          if (typeof key === "string") return { [key]: saved[key] };
          return Object.fromEntries(key.map(k => [k, saved[k]]));
        },
        async set(values) { Object.assign(saved, values); }
      }
    },
    permissions: { async request() { return true; } },
    scripting: { async executeScript() {} }
  };
  const context = {
    document: { getElementById: element },
    chrome,
    ChatWatchdogCore: {
      normalize: value => ({ enabled: false, mode: "auto", marker: "",
        markerRegex: false, toastEnabled: true,
        ...value
      }),
      compileMarker: () => /x/
    },
    ChatWatchdogAudio: { save: async () => {} },
    navigator: { clipboard: {
      async writeText(value) {
        if (clipboardError) throw new Error("clipboard denied");
        clipboard.push(value);
      }
    } },
    URL, Date, Promise, console
  };
  vm.runInNewContext(popupSource, context);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.ok(handlers.has("copyLog:click"), "copy button must be wired");
  return {
    element, sent, clipboard,
    async clickCopy() { await handlers.get("copyLog:click")(); },
    get diagnosticRequests() { return diagnosticRequests; },
    get logRequests() { return logRequests; }
  };
}

test("copy button fetches live chat-element diagnostics AND recent journal in one click", async () => {
  const popup = await createPopup();
  await popup.clickCopy();
  assert.equal(popup.clipboard.length, 1);
  const copied = popup.clipboard[0];
  assert.match(copied, /=== Элементы чата ===/);
  assert.match(copied, /=== Журнал событий ===/);
  assert.match(copied, /Сообщений ИИ: 1/);
  assert.match(copied, /Последний ответ по беседе: 3/);
  assert.match(copied, /Версия: 0\.2\.11/);
  assert.match(copied, /Режимы всех вкладок этого сайта/);
  assert.match(copied, /Вкладка #9 \[xample\]: Автопродолжение/);
  assert.match(copied, /Общий журнал попыток Watchdog/);
  assert.match(copied, /вкладка #9 \[xample\] claim \(allowed\)/);
  assert.match(copied, /12:00:00  Событие #1/);
  assert.equal(popup.element("diagnostic").textContent.includes("Сообщений ИИ: 1"), true);
  assert.equal(popup.element("eventLog").textContent, "12:00:00  Событие #1");
  assert.match(popup.element("status").textContent, /Скопировано/);
  assert.equal(popup.element("copyLog").disabled, false);
  assert.deepEqual(popup.sent, ["WATCHDOG_DIAGNOSE", "WATCHDOG_LOG"]);

  // Fresh data on the second click — not the cached popup text.
  await popup.clickCopy();
  assert.equal(popup.clipboard.length, 2);
  assert.match(popup.clipboard[1], /Сообщений ИИ: 2/);
  assert.match(popup.clipboard[1], /Событие #2/);
});

test("clipboard failures show an error and re-enable copying", async () => {
  const popup = await createPopup({ clipboardError: true });
  await popup.clickCopy();
  assert.equal(popup.clipboard.length, 0);
  assert.match(popup.element("status").textContent, /Не удалось скопировать: clipboard denied/);
  assert.equal(popup.element("copyLog").disabled, false);
});

test("does not copy a partial report if diagnostic data is unavailable", async () => {
  const popup = await createPopup({ diagnosticsUnavailable: true });
  await popup.clickCopy();
  assert.equal(popup.clipboard.length, 0);
  assert.match(popup.element("status").textContent, /content script unavailable/);
  assert.equal(popup.element("copyLog").disabled, false);
});
