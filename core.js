(function (root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    enabled: false,
    marker: "!!!ГОТОВО!!!",
    markerRegex: false,
    reply: "Ок, продолжаем",
    delaySeconds: 5,
    cooldownSeconds: 45,
    toastEnabled: true,
    errorWordsVersion: 1,
    errorWords: "Соединение прервано\nОшибка соединения\nНет ответа от ChatGPT. Проверьте подключение к интернету\nВы достигли лимита\nВы достигни лимита\nConnection interrupted\nNetwork error\nRate limit reached\n!!!ЕСТЬ ЗАДАНИЕ ДЛЯ АГЕНТА!!!\n!!!ЖДУ РЕШЕНИЕ!!!\n!!!У НАС ПРОБЛЕМА!!!\n!!НУЖНА ЛОКАЛЬНАЯ ПРОВЕРКА!!!",
    assistantSelector: "",
    editorSelector: "",
    sendSelector: "",
    stopSelector: "",
    completionSelector: "",
    errorSelector: "",
    audioName: "",
    origin: ""
  });

  const NEW_ERROR_PHRASES = Object.freeze([
    "Нет ответа от ChatGPT. Проверьте подключение к интернету",
    "!!!ЕСТЬ ЗАДАНИЕ ДЛЯ АГЕНТА!!!",
    "!!!ЖДУ РЕШЕНИЕ!!!",
    "!!!У НАС ПРОБЛЕМА!!!",
    "!!НУЖНА ЛОКАЛЬНАЯ ПРОВЕРКА!!!"
  ]);

  function normalize(value) {
    const input = value && typeof value === "object" ? value : {};
    const config = Object.assign({}, DEFAULTS);
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        config[key] = input[key];
      }
    }
    config.enabled = config.enabled === true;
    config.markerRegex = config.markerRegex === true;
    config.toastEnabled = config.toastEnabled !== false;
    config.delaySeconds = Math.max(1, Math.min(600, Number(config.delaySeconds) || 5));
    config.cooldownSeconds = Math.max(10, Math.min(3600, Number(config.cooldownSeconds) || 45));
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[key] === "string") {
        config[key] = String(config[key] == null ? "" : config[key]);
      }
    }
    // Upgrade existing tab settings once, without preventing later edits.
    // The new defaults would otherwise be hidden by saved errorWords strings.
    if (typeof input.errorWords === "string" && !input.errorWordsVersion) {
      const present = config.errorWords.split(/\r?\n/).map(s => s.trim());
      for (const phrase of NEW_ERROR_PHRASES) {
        if (!present.includes(phrase)) config.errorWords += "\n" + phrase;
      }
    }
    config.errorWordsVersion = 1;
    config.marker = config.marker.trim();
    config.reply = config.reply.trim() || DEFAULTS.reply;
    return config;
  }

  // Regex markers must match the very end of the assistant's answer.
  function compileMarker(marker) {
    let pattern = String(marker || "").trim();
    let flags = "";
    if (!pattern) throw new Error("Regex не может быть пустым");
    if (pattern.startsWith("/")) {
      const last = pattern.lastIndexOf("/");
      if (last > 0 && /^[a-z]*$/i.test(pattern.slice(last + 1))) {
        flags = pattern.slice(last + 1).replace(/[gy]/g, "");
        pattern = pattern.slice(1, last);
      }
    }
    if (!pattern || pattern.length > 1000) {
      throw new Error("Regex должен содержать от 1 до 1000 символов");
    }
    // Lookahead checks real end of string even with the multiline flag.
    return new RegExp("(?:" + pattern + ")\\s*(?![\\s\\S])", flags);
  }

  function hasMarker(text, marker, markerRegex = false) {
    if (!text || !marker) return false;
    const value = String(text).trimEnd();
    if (!markerRegex) return value.endsWith(String(marker).trim());
    try {
      return compileMarker(marker).test(value.slice(-4000));
    } catch {
      return false;
    }
  }

  // When the marker is intentionally empty, completion is determined by
  // the finished assistant turn (stable text + no stop button).
  function completionMatches(text, marker, markerRegex = false) {
    if (!String(text || "").trim()) return false;
    return !String(marker || "").trim() || hasMarker(text, marker, markerRegex);
  }

  // Standalone error markers in assistant replies are alerts; mention of a
  // phrase inside a paragraph should not trigger an alarm.
  function findErrorLine(text, phrases) {
    const lines = String(text || "").split(/\r?\n/).map(line => line.trim());
    return String(phrases || "").split(/\r?\n/)
      .map(phrase => phrase.trim())
      .filter(Boolean)
      .find(phrase => lines.some(line => line.toLocaleLowerCase() === phrase.toLocaleLowerCase())) || null;
  }

  function findError(text, phrases) {
    const lower = String(text || "").toLocaleLowerCase();
    return String(phrases || "")
      .split(/\r?\n/)
      .map((word) => word.trim())
      .filter(Boolean)
      .find((word) => lower.includes(word.toLocaleLowerCase())) || null;
  }

  function selectorsFor(host) {
    host = String(host || "").toLowerCase();
    const common = {
      assistant: '[data-testid="assistant-message"], [data-message-role="assistant"]',
      editor: '[contenteditable="true"][role="textbox"], [contenteditable="true"].ProseMirror, textarea',
      send: 'button[data-testid="send-button"], button[aria-label="Send message"], button[aria-label="Отправить"], button[type="submit"]',
      stop: 'button[data-testid="stop-button"], button[aria-label="Stop response"], button[aria-label="Stop generating"], button[aria-label="Остановить генерацию"]'
    };
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") {
      return {
        // Old ChatGPT roles and 2026 Chat/Work search-unit / turn layouts.
        assistant: '[data-message-author-role="assistant"], [data-message-role="assistant"], [data-role="assistant"], [data-message-author="assistant"], [data-content-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant:final"], [data-turn-key]:not(:has([data-user-message-bubble="true"]))',
        editor: '#prompt-textarea, #pending-conversation-input, [data-composer-input] textarea, [data-testid="composer-input"], [contenteditable="true"][role="textbox"]',
        send: 'button[data-testid="send-button"], button[aria-label="Отправить"], button[aria-label="Send message"]',
        stop: 'button[data-testid="stop-button"], button[data-testid="stop-generating-button"], button[aria-label="Stop generating"], button[aria-label="Stop response"], button[aria-label="Stop"], button[aria-label="Остановить генерацию"], button[aria-label="Остановить"], button[aria-label="Прервать"]'
      };
    }
    if (host === "claude.ai" || host.endsWith(".claude.ai")) {
      return {
        assistant: '[data-testid="assistant-message"], .font-claude-message',
        editor: '[contenteditable="true"].ProseMirror, [contenteditable="true"][role="textbox"]',
        send: 'button[aria-label="Send message"], button[aria-label="Send"], button[data-testid="send-button"]',
        stop: common.stop
      };
    }
    if (host === "gemini.google.com") {
      return {
        assistant: 'model-response, .model-response',
        editor: 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"]',
        send: 'button[aria-label="Send message"], button[aria-label="Отправить сообщение"], button[data-testid="send-button"]',
        stop: common.stop
      };
    }
    if (host === "chat.deepseek.com") {
      return Object.assign({}, common, { assistant: ".ds-markdown" });
    }
    return common;
  }

  function isStopAction(button) {
    if (!button) return false;
    const label = [button.getAttribute && button.getAttribute("aria-label"),
      button.getAttribute && button.getAttribute("title"),
      button.getAttribute && button.getAttribute("data-testid")].filter(Boolean).join(" ").toLowerCase();
    return /stop|interrupt|cancel generation|останов|прерва|прекрат|отменить генерац/.test(label);
  }

  // Remember active *occurrences*, not error wording. Closing the dialog
  // acknowledges an occurrence; a new DOM message (even identical) re-arms.
  // Some sites recycle the same wrapper, so content mutations re-arm it too.
  function createErrorTracker() {
    let visibleErrors = new Map();
    let revisions = new Map();

    function contains(container, child) {
      return container === child ||
        (container && typeof container.contains === "function" && container.contains(child));
    }

    return {
      observe(entries) {
        const current = new Map();
        let newest = null;
        for (const entry of entries || []) {
          if (!entry || !entry.node || !entry.signature) continue;
          const revision = revisions.get(entry.node) || 0;
          const value = { signature: entry.signature, revision };
          current.set(entry.node, value);
          const previous = visibleErrors.get(entry.node);
          if (!previous || previous.signature !== value.signature ||
              previous.revision !== value.revision) newest = entry;
        }
        visibleErrors = current;
        return newest;
      },
      // A removed/hidden error is no longer active, even if the site later
      // inserts the exact same node with the exact same text.
      forgetSubtree(container) {
        for (const node of visibleErrors.keys()) {
          if (contains(container, node)) visibleErrors.delete(node);
        }
      },
      // Replacing the error text inside a reused alert element is a fresh
      // event even if the resulting text is identical.
      markUpdated(container) {
        for (const node of visibleErrors.keys()) {
          if (contains(container, node) || contains(node, container)) {
            revisions.set(node, (revisions.get(node) || 0) + 1);
          }
        }
      },
      reset() {
        visibleErrors.clear();
        revisions.clear();
      }
    };
  }

  // Key sends to the logical user turn, not DOM node identity. React may
  // replace BOTH user and assistant nodes without adding a new chat turn.
  function userTurnFingerprint(count, text) {
    const normalized = String(text || "").trim().replace(/\s+/g, " ");
    let hash = 2166136261;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return String(count) + ":" + normalized.length + ":" + (hash >>> 0).toString(16);
  }

  function createSendGuard() {
    let sent = null;
    return {
      alreadySent(text, logicalTurn) {
        if (!sent) return false;
        // When the user turn is identifiable, block all repeated submissions
        // for that turn even if assistant text changes slightly.
        if (logicalTurn && sent.logicalTurn) {
          return sent.logicalTurn === logicalTurn;
        }
        // Other supported chat UIs may not expose reliable user turns.
        // Fail closed for identical response text in those cases.
        return sent.text === text;
      },
      record(text, logicalTurn) {
        sent = { text, logicalTurn: logicalTurn || null };
      }
    };
  }

  const api = { DEFAULTS, normalize, compileMarker, hasMarker, completionMatches, findError, findErrorLine, selectorsFor, isStopAction, createErrorTracker, createSendGuard, userTurnFingerprint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ChatWatchdogCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
