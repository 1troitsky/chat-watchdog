(function (root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    enabled: false,
    marker: "!!!ГОТОВО!!!",
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

  function hasMarker(text, marker) {
    if (!text || !marker) return false;
    return String(text).trimEnd().endsWith(String(marker).trim());
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

  const api = { DEFAULTS, normalize, hasMarker, findError, selectorsFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ChatWatchdogCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
