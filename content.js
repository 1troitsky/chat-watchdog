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
        p { margin: 0; overflow-wrap: anywhere; color: #555; }
        button { cursor: pointer; font: inherit; }
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
        </section>
      </div>
    `;
    dialogError = shadow.getElementById("watchdog-error");
    dialogError.textContent = "Обнаружена ошибка: " + message;
    shadow.querySelector(".close").addEventListener("click", closeDialog);
    dialogRoot = host;
    (document.body || document.documentElement).appendChild(host);
    document.addEventListener("keydown", handleDialogKeydown, true);
    shadow.querySelector(".close").focus();
  }

  // Prefer the most specific descendant containing the error. Some sites
  // reuse a single [role="status"] wrapper for successive toast messages.
  function specificErrorNode(node, phrase) {
    const needle = phrase.toLocaleLowerCase();
    let current = node;
    while (current.children && current.children.length) {
      const matching = Array.from(current.children).filter((child) =>
        textOf(child).toLocaleLowerCase().includes(needle));
      if (matching.length !== 1) break;
      current = matching[0];
    }
    return current;
  }

  function checkError() {
    const selector = config.errorSelector ||
      '[role="alert"], [role="status"], [data-sonner-toast], [data-testid*="error"], .toast, .error-banner';
    const matches = [];
    for (const node of query(selector)) {
      if (!visible(node)) continue;
      const rawText = textOf(node).slice(0, 1000);
      const matched = Core.findError(rawText, config.errorWords);
      if (!matched) continue;
      const target = specificErrorNode(node, matched);
      const signature = matched + ":" + textOf(target).slice(0, 500);
      matches.push({ node: target, signature, phrase: matched });
    }
    const fresh = errorTracker.observe(matches);
    if (fresh) {
      if (dialogRoot) {
        dialogError.textContent = "Обнаружена ошибка: " + fresh.phrase;
      } else {
        showDialog(fresh.phrase);
        chrome.runtime.sendMessage({ type: "PLAY_ERROR" }).catch(() => {});
      }
    }
    return matches.length > 0;
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
    if (key !== expectedKey || !Core.hasMarker(text, config.marker, config.markerRegex) ||
      hasStopButton(selectors.stop)) return;
    if (config.completionSelector && !query(config.completionSelector).some(visible)) return;
    const editor = findEditor(selectors.editor);
    if (!editor || editorText(editor)) return; // Never overwrite a human's draft.
    fillEditor(editor, config.reply);
    // Controlled editors can enable their submit button asynchronously.
    // Wait briefly instead of abandoning a correctly filled message.
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (!config.enabled || location.href !== route) return;
      if (editorText(editor) !== config.reply) return;
      const button = findSendButton(selectors.send);
      if (button) {
        handled.add(expectedKey);
        button.click();
        return;
      }
    }
    console.warn("Chat Watchdog: send button not available; follow-up left in editor.");

  }

  function check() {
    if (!config.enabled) return;
    if (route !== location.href) {
      closeDialog();
      errorTracker.reset();
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
    // Establish the baseline even for an empty/new conversation. Otherwise
    // the very first short assistant reply is silently ignored.
    if (!result.node) {
      seenInitial = true;
      return;
    }
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
      if (Core.hasMarker(text, config.marker, config.markerRegex)) handled.add(key);
      return;
    }
    if (handled.has(key) || !Core.hasMarker(text, config.marker, config.markerRegex)) return;
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
      errorTracker.reset();
      closeDialog();
    }
    if (!wasEnabled && config.enabled) {
      route = location.href;
      seenInitial = false;
      handled = new Set();
      errorTracker.reset();
    }
    scheduleCheck();
  });

  chrome.runtime.sendMessage({ type: "GET_CONFIG" }).then((saved) => {
    config = Core.normalize(saved);
    check();
  }).catch(() => {});

  // Detect reappearing errors even when a site removes and reinserts them
  // between two polling cycles. Text replacement can also happen in the
  // same persistent [role="alert"] element.
  function errorTextIn(node) {
    if (!node) return false;
    const content = node.nodeType === 3 ? node.nodeValue : node.textContent;
    return !!Core.findError(String(content || "").slice(0, 1000), config.errorWords);
  }

  function inspectMutations(records) {
    if (config.enabled) {
      for (const record of records) {
        if (record.type === "childList") {
          const textRemoved = Array.from(record.removedNodes).some(errorTextIn);
          const textAdded = Array.from(record.addedNodes).some(errorTextIn);
          // A disappearing alert must stop being considered the old event.
          for (const removed of record.removedNodes) {
            errorTracker.forgetSubtree(removed);
          }
          if (textRemoved || textAdded) {
            errorTracker.markUpdated(record.target);
          }
        } else if (record.type === "characterData") {
          if (errorTextIn(record.target)) {
            errorTracker.markUpdated(record.target.parentNode);
          }
        } else if (record.type === "attributes") {
          // A visibility change can represent a new alert in a reused node.
          // Avoid treating ordinary class/animation changes as new errors.
          if (record.attributeName === "hidden" ||
              record.attributeName === "aria-hidden" ||
              (record.attributeName === "style" &&
                /display:\s*none|visibility:\s*hidden/i.test(record.oldValue || ""))) {
            const element = record.target;
            if (visible(element)) errorTracker.markUpdated(element);
            else errorTracker.forgetSubtree(element);
          }
        }
      }
    }
    scheduleCheck();
  }

  const observer = new MutationObserver(inspectMutations);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, characterDataOldValue: false,
    attributes: true, attributeFilter: ["style", "hidden", "aria-hidden"],
    attributeOldValue: true
  });
  setInterval(check, 1500);
})();
