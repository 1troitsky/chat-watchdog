(function (root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    enabled: false,
    marker: "!!!ГОТОВО!!!",
    markerRegex: false,
    reply: "Ок, продолжаем",
    delaySeconds: 5,
    errorWords: "Соединение прервано\nОшибка соединения\nВы достигли лимита\nВы достигни лимита\nConnection interrupted\nNetwork error\nRate limit reached",
    assistantSelector: "",
    editorSelector: "",
    sendSelector: "",
    stopSelector: "",
    completionSelector: "",
    errorSelector: "",
    audioName: "",
    origin: ""
  });

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
    config.delaySeconds = Math.max(1, Math.min(600, Number(config.delaySeconds) || 5));
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[key] === "string") {
        config[key] = String(config[key] == null ? "" : config[key]);
      }
    }
    config.marker = config.marker.trim() || DEFAULTS.marker;
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
        stop: 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Остановить генерацию"]'
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

  // Prevent a completed marker from being submitted twice when React/SPA
  // recreates the same assistant message or changes its DOM wrapper.
  // Re-arm identical assistant text only after a NEW user turn followed by
  // a NEW assistant reply; never treat rerendering as a new answer.
  function createSendGuard() {
    let sent = null;
    return {
      alreadySent(text, latestUser, latestAssistant) {
        if (!sent || sent.text !== text) return false;
        if (!latestUser || latestUser === sent.user) return true;
        if (typeof latestUser.compareDocumentPosition !== "function") return true;
        // A new assistant reply must come after the new user message.
        return !(latestUser.compareDocumentPosition(latestAssistant) & 4);
      },
      record(text, latestUser) {
        sent = { text, user: latestUser || null };
      },
      status(text, latestUser, latestAssistant) {
        return this.alreadySent(text, latestUser, latestAssistant);
      }
    };
  }

  const api = { DEFAULTS, normalize, compileMarker, hasMarker, findError, selectorsFor, createErrorTracker, createSendGuard };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ChatWatchdogCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
