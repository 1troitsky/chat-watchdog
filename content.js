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
  const errorTracker = Core.createErrorTracker();
  let dialogRoot = null;
  let dialogError = null;

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

  function closeDialog() {
    if (dialogRoot) {
      dialogRoot.remove();
      dialogRoot = null;
      dialogError = null;
    }
    document.removeEventListener("keydown", handleDialogKeydown, true);
    chrome.runtime.sendMessage({ type: "STOP_ERROR" }).catch(() => {});
  }

  function handleDialogKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
    }
  }

  function showDialog(message) {
    if (dialogRoot) {
      dialogError.textContent = message;
      return;
    }
    const host = document.createElement("div");
    host.id = "chat-watchdog-alert-host";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .veil {
          position: fixed; inset: 0; display: flex; align-items: center;
          justify-content: center; padding: 20px; background: #0008;
          font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #222;
        }
        .panel {
          position: relative; width: min(100%, 390px); padding: 25px;
          border-radius: 14px; background: #fff; box-shadow: 0 20px 80px #0004;
          text-align: left;
        }
        h2 { margin: 0 35px 12px 0; font-size: 19px; line-height: 1.3; font-weight: 650; }
        p { margin: 0 0 20px; overflow-wrap: anywhere; color: #555; }
        button { cursor: pointer; font: inherit; }
        .dismiss {
          display: block; width: 100%; border: 0; padding: 11px 14px;
          border-radius: 8px; color: #fff; background: #222; font-weight: 600;
        }
        .dismiss:hover { background: #444; }
        .close {
          position: absolute; right: 13px; top: 11px; border: 0;
          background: transparent; border-radius: 6px; padding: 5px 10px;
          color: #666; font-size: 21px;
        }
        button:focus-visible { outline: 3px solid #888; outline-offset: 3px; }
      </style>
      <div class="veil">
        <section class="panel" role="alertdialog" aria-modal="true"
          aria-labelledby="watchdog-title" aria-describedby="watchdog-error">
          <button class="close" type="button" aria-label="Закрыть">×</button>
          <h2 id="watchdog-title">Chatbot Mistake</h2>
          <p id="watchdog-error"></p>
          <button class="dismiss" type="button">Закрыть и остановить звук</button>
        </section>
      </div>
    `;
    dialogError = shadow.getElementById("watchdog-error");
    dialogError.textContent = "Обнаружена ошибка: " + message;
    shadow.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", closeDialog);
    });
    dialogRoot = host;
    (document.body || document.documentElement).appendChild(host);
    document.addEventListener("keydown", handleDialogKeydown, true);
    shadow.querySelector(".dismiss").focus();
  }

  function checkError() {
    const selector = config.errorSelector ||
      '[role="alert"], [role="status"], [data-sonner-toast], [data-testid*="error"], .toast, .error-banner';
    let signature = null;
    let matchedPhrase = null;
    for (const node of query(selector)) {
      if (!visible(node)) continue;
      const text = textOf(node).slice(0, 500);
      const matched = Core.findError(text, config.errorWords);
      if (!matched) continue;
      matchedPhrase = matched;
      signature = matched + ":" + text;
      break;
    }
    if (!signature) {
      errorTracker.observe(null);
      return false;
    }
    if (errorTracker.observe(signature)) {
      if (dialogRoot) {
        dialogError.textContent = "Обнаружена ошибка: " + matchedPhrase;
      } else {
        showDialog(matchedPhrase);
        chrome.runtime.sendMessage({ type: "PLAY_ERROR" }).catch(() => {});
      }
    }
    return true;
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
      closeDialog();
      errorTracker.observe(null);
      route = location.href;
      seenInitial = false;
      lastKey = "";
      handled = new Set();
      cancelPending();
    }
    if (checkError()) {
      cancelPending();
      return;
    }
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
    if (!config.enabled) {
      cancelPending();
      errorTracker.observe(null);
      closeDialog();
    }
    if (!wasEnabled && config.enabled) {
      route = location.href;
      seenInitial = false;
      handled = new Set();
      errorTracker.observe(null);
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
