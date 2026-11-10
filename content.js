(function () {
  "use strict";
  if (globalThis.__CHAT_WATCHDOG_RUNNING__) return;
  globalThis.__CHAT_WATCHDOG_RUNNING__ = true;

  const Core = globalThis.ChatWatchdogCore;
  let config = Core.normalize();
  let route = location.href;
  let seenInitial = false;
  let lastKey = "";
  let stableSince = Date.now();
  let pending = null;
  let debounce = null;
  let handled = new Set();
  let lastError = "";
  let lastErrorAt = 0;

  function query(selector) {
    if (!selector) return [];
    try { return Array.from(document.querySelectorAll(selector)); }
    catch { return []; }
  }

  function visible(element) {
    return !!(element && element.getClientRects().length &&
      getComputedStyle(element).visibility !== "hidden");
  }

  function currentSelectors() {
    const defaults = Core.selectorsFor(location.hostname);
    return {
      assistant: config.assistantSelector || defaults.assistant,
      editor: config.editorSelector || defaults.editor,
      send: config.sendSelector || defaults.send,
      stop: config.stopSelector || defaults.stop
    };
  }

  function latestAssistant(selector) {
    const nodes = query(selector).filter(visible);
    return { node: nodes[nodes.length - 1], count: nodes.length };
  }

  function textOf(element) {
    return (element && (element.innerText || element.textContent) || "").trim();
  }

  function findEditor(selector) {
    return query(selector).find((element) => visible(element) &&
      (element.isContentEditable || /^(TEXTAREA|INPUT)$/.test(element.tagName)));
  }

  function findSendButton(selector) {
    return query(selector).find((button) =>
      visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true");
  }

  function hasStopButton(selector) {
    return query(selector).some(visible);
  }

  function checkError() {
    const selector = config.errorSelector ||
      '[role="alert"], [role="status"], [data-sonner-toast], [data-testid*="error"], .toast, .error-banner';
    for (const node of query(selector)) {
      if (!visible(node)) continue;
      const text = textOf(node).slice(0, 500);
      const matched = Core.findError(text, config.errorWords);
      if (!matched) continue;
      const signature = matched + ":" + text;
      if (signature === lastError && Date.now() - lastErrorAt < 60000) continue;
      lastError = signature;
      lastErrorAt = Date.now();
      chrome.runtime.sendMessage({ type: "PLAY_ERROR" }).catch(() => {});
      break;
    }
  }

  function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  function editorText(editor) {
    return editor.isContentEditable ? (editor.innerText || editor.textContent || "").trim()
      : String(editor.value || "").trim();
  }

  function fillEditor(editor, value) {
    editor.focus();
    if (editor.isContentEditable) {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      const inserted = document.execCommand("insertText", false, value);
      if (!inserted) {
        editor.textContent = value;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      }
    } else {
      const descriptor = Object.getOwnPropertyDescriptor(
        editor.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        "value"
      );
      descriptor.set.call(editor, value);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  async function sendIfReady(expectedKey) {
    pending = null;
    if (!config.enabled || location.href !== route) return;
    const selectors = currentSelectors();
    const result = latestAssistant(selectors.assistant);
    if (!result.node) return;
    const text = textOf(result.node);
    const messageId = result.node.closest("[data-message-id]")?.getAttribute("data-message-id") || "";
    const key = route + "|" + result.count + "|" + messageId + "|" + text;
    if (key !== expectedKey || !Core.hasMarker(text, config.marker) ||
      hasStopButton(selectors.stop)) return;
    if (config.completionSelector && !query(config.completionSelector).some(visible)) return;
    const editor = findEditor(selectors.editor);
    if (!editor || editorText(editor)) return; // Never overwrite a human's draft.
    fillEditor(editor, config.reply);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!config.enabled || location.href !== route) return;
    if (editorText(editor) !== config.reply) return;
    const button = findSendButton(selectors.send);
    if (button) {
      handled.add(expectedKey);
      button.click();
    }
  }

  function check() {
    if (!config.enabled) return;
    if (route !== location.href) {
      route = location.href;
      seenInitial = false;
      lastKey = "";
      handled = new Set();
      cancelPending();
    }
    checkError();
    const selectors = currentSelectors();
    const result = latestAssistant(selectors.assistant);
    if (!result.node) return;
    const text = textOf(result.node);
    const messageId = result.node.closest("[data-message-id]")?.getAttribute("data-message-id") || "";
    const key = route + "|" + result.count + "|" + messageId + "|" + text;
    if (key !== lastKey) {
      lastKey = key;
      stableSince = Date.now();
      cancelPending();
    }
    if (!seenInitial) {
      seenInitial = true;
      if (Core.hasMarker(text, config.marker)) handled.add(key);
      return;
    }
    if (handled.has(key) || !Core.hasMarker(text, config.marker)) return;
    if (Date.now() - stableSince < 1500 || hasStopButton(selectors.stop)) return;
    if (config.completionSelector && !query(config.completionSelector).some(visible)) return;
    if (pending && pending.key === key) return;
    cancelPending();
    pending = {
      key,
      timer: setTimeout(() => { sendIfReady(key).catch(console.warn); },
        config.delaySeconds * 1000)
    };
  }

  function scheduleCheck() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(check, 300);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "WATCHDOG_CONFIG") return;
    const wasEnabled = config.enabled;
    config = Core.normalize(message.config);
    if (!config.enabled) cancelPending();
    if (!wasEnabled && config.enabled) {
      route = location.href;
      seenInitial = false;
      handled = new Set();
    }
    scheduleCheck();
  });

  chrome.runtime.sendMessage({ type: "GET_CONFIG" }).then((saved) => {
    config = Core.normalize(saved);
    check();
  }).catch(() => {});

  const observer = new MutationObserver(scheduleCheck);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setInterval(check, 1500);
})();
