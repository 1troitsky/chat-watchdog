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
        assistant: '[data-message-author-role="assistant"]',
        editor: '#prompt-textarea, [data-testid="composer-input"], [contenteditable="true"][role="textbox"]',
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

  // Distinguish individual DOM error instances, not just their text.
  // Track every visible match so an older error never re-alerts when a newer
  // one disappears. A dismissed error stays acknowledged while it remains
  // visible, but replacement/reappearance of the error is a new occurrence.
  function createErrorTracker() {
    let visibleErrors = new Map();
    return {
      observe(entries) {
        const current = new Map();
        let newest = null;
        for (const entry of entries || []) {
          if (!entry || !entry.node || !entry.signature) continue;
          current.set(entry.node, entry.signature);
          if (visibleErrors.get(entry.node) !== entry.signature) {
            newest = entry;
          }
        }
        visibleErrors = current;
        return newest;
      },
      reset() {
        visibleErrors.clear();
      }
    };
  }

  const api = { DEFAULTS, normalize, compileMarker, hasMarker, findError, selectorsFor, createErrorTracker };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ChatWatchdogCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
