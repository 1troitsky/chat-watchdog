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
  const acknowledgedAssistantAlerts = new Set();
  const sendGuard = Core.createSendGuard();
  const submittedAssistantTokens = new Set();
  let lastClaimedAssistantOrdinal = 0;
  let dialogRoot = null;
  let dialogError = null;
  let activeAlertId = "";
  let sendClicks = 0;
  let lastClickAt = 0;
  let globalLockedUntil = 0;
  let cooldownHydrated = false;
  let hydrationEpoch = 0;
  let sending = false;
  let modeEpoch = 0;
  let lastUserTurnAtSend = null;
  let lastAutoDecision = "Проверка ещё не проводилась";
  let lastAutoDecisionAt = null;
  const eventLog = [];
  const lastEventSignature = new Map();

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

  const messageIds = new WeakMap();
  let nextMessageId = 1;

  function isChatGPT() {
    return location.hostname === "chatgpt.com" ||
      location.hostname.endsWith(".chatgpt.com") ||
      location.hostname === "chat.openai.com";
  }

  // The current app-shell has multiple account-dependent DOM variants.
  // Choose a single user-bubble scheme instead of counting nested aliases.
  // A React rerender can change the node but not the visible turn text or its
  // ordinal, so this is a stable local identifier for duplicate prevention.
  function latestUserTurn() {
    const schemes = [
      '[data-user-message-bubble="true"]',
      '[data-message-author-role="user"]',
      '[data-content-search-unit-key$=":user"]'
    ];
    for (const selector of schemes) {
      const nodes = query(selector).filter(visible);
      if (!nodes.length) continue;
      const node = nodes[nodes.length - 1];
      return {
        node,
        logicalTurn: Core.userTurnFingerprint(nodes.length, textOf(node))
      };
    }
    return { node: null, logicalTurn: null };
  }

  function followsUser(assistant, user) {
    if (!user) return true;
    if (!assistant || typeof user.compareDocumentPosition !== "function") return false;
    // A following assistant must be a distinct node strictly after the
    // most recent user turn. A stale assistant before a new user cannot fire.
    return !!(user.compareDocumentPosition(assistant) & 4) &&
      !(typeof user.contains === "function" && user.contains(assistant)) &&
      !(typeof assistant.contains === "function" && assistant.contains(user));
  }

  // If neither traditional roles nor search-unit keys are present, locate
  // visible reply content AFTER the latest user bubble. In no-marker mode
  // this also allows ordinary non-empty replies (not just marker paragraphs).
  function markerAfterLastUser() {
    if (!isChatGPT() || typeof document.querySelector !== "function") return [];
    const lastUser = latestUserTurn().node;
    if (!lastUser || typeof lastUser.compareDocumentPosition !== "function") return [];
    const root = document.querySelector("main") ||
      document.querySelector('[role="main"]') || document.body;
    if (!root || typeof root.querySelectorAll !== "function") return [];

    const nodes = Array.from(root.querySelectorAll(
      'p, li, blockquote, [role="paragraph"], [data-thread-find-target], [data-chatgpt-conversation-selection-target]'
    )).slice(-800);
    return nodes.filter((node) => {
      if (!visible(node) || !Core.completionMatches(textOf(node), config.marker, config.markerRegex) &&
        !Core.findErrorLine(textOf(node), config.errorWords)) return false;
      if (typeof node.closest === "function" && node.closest(
        '[data-user-message-bubble], [data-message-author-role="user"], [data-content-search-unit-key$=":user"], [contenteditable], [data-composer-input], form, nav, aside, header, footer, [role="dialog"], pre, code, #chat-watchdog-alert-host'
      )) return false;
      if (typeof lastUser.contains === "function" && lastUser.contains(node)) return false;
      if (typeof node.contains === "function" && node.contains(lastUser)) return false;
      return followsUser(node, lastUser);
    });
  }

  function assistantElements(selector) {
    // User-supplied selectors take priority, but a stale manual selector
    // should not break the built-in compatible detection.
    const matched = query(selector).filter(visible);
    if (matched.length) return { nodes: matched, source: config.assistantSelector ? "custom" : "builtin" };
    const builtin = Core.selectorsFor(location.hostname).assistant;
    if (config.assistantSelector && builtin !== selector) {
      const fallback = query(builtin).filter(visible);
      if (fallback.length) return { nodes: fallback, source: "builtin-fallback" };
    }
    const markerNodes = markerAfterLastUser();
    return { nodes: markerNodes, source: markerNodes.length ? "marker-after-user" : "none" };
  }

  function latestAssistant(selector) {
    const result = assistantElements(selector);
    const all = result.nodes;
    const lastUser = latestUserTurn().node;
    const nodes = all.filter(node => followsUser(node, lastUser));
    const latest = nodes[nodes.length - 1];
    return { node: latest, count: nodes.length,
      ordinal: latest ? all.lastIndexOf(latest) + 1 : 0,
      total: all.length, source: result.source };
  }

  function sendToken(node, text, count) {
    // Use the identity of the ASSISTANT reply, never the latest USER turn:
    // after our click ChatGPT inserts our own user message, which changes
    // the old user-turn fingerprint and used to permit duplicate sends.
    // ChatGPT's turn keys survive React re-renders of the same reply.
    const identifiers = [
      ["[data-turn-key]", "data-turn-key"],
      ["[data-message-id]", "data-message-id"],
      ["[data-content-search-unit-key]", "data-content-search-unit-key"]
    ];
    for (const [selector, attribute] of identifiers) {
      const owner = node && typeof node.closest === "function" &&
        node.closest(selector);
      const value = owner && owner.getAttribute(attribute);
      if (value) return route + "|assistant:" + value;
    }
    // On older/unknown sites without stable reply IDs, fail closed for an
    // identical answer in the same assistant slot. A new user bubble alone
    // must NOT turn an old reply into a new send opportunity.
    return route + "|assistant-fallback:" +
      Core.userTurnFingerprint(count || 0, text);
  }

  function messageKey(node, count, text) {
    const container = typeof node.closest === "function" &&
      node.closest("[data-message-id], [data-content-search-unit-key], [data-turn-key]");
    const keyFromDom = container && (
      container.getAttribute("data-message-id") ||
      container.getAttribute("data-content-search-unit-key") ||
      container.getAttribute("data-turn-key")
    );
    if (!messageIds.has(node)) messageIds.set(node, nextMessageId++);
    return route + "|" + (keyFromDom || "dom:" + messageIds.get(node)) +
      "|" + count + "|" + text;
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
      visible(button) && !Core.isStopAction(button) &&
      !button.disabled && button.getAttribute("aria-disabled") !== "true");
  }

  function hasStopButton(selector) {
    if (query(selector).some(visible)) return true;
    if (!isChatGPT()) return false;
    // Check actual visible stop actions even when the current site uses a
    // new selector not yet covered by our defaults.
    return query("button[aria-label], button[title], button[data-testid]")
      .some(button => visible(button) && Core.isStopAction(button));
  }

  const alertHostSelector = "#chat-watchdog-alert-host";
  const alertAckAttribute = "data-chat-watchdog-ack";

  function alertHosts() {
    return query(alertHostSelector);
  }

  // An acknowledgement is shared via the DOM, not globalThis: extension
  // updates and isolated injected script worlds can run simultaneously.
  // Never store the error phrase or any chat content in a DOM attribute.
  function alertIdentity(signature) {
    const input = route + "\u0000" + signature;
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function isAcknowledged(id) {
    const root = document.documentElement;
    return !!(root && typeof root.getAttribute === "function" &&
      root.getAttribute(alertAckAttribute) === id);
  }

  function acknowledge(id) {
    const root = document.documentElement;
    if (id && root && typeof root.setAttribute === "function")
      root.setAttribute(alertAckAttribute, id);
  }

  function closeDialog() {
    acknowledge(activeAlertId);
    // Close ALL overlay hosts, including any orphaned hosts left by a
    // previous content-script world. One click must never mean 10 clicks.
    for (const host of alertHosts()) host.remove();
    if (dialogRoot && !alertHosts().includes(dialogRoot)) dialogRoot.remove();
    dialogRoot = null;
    dialogError = null;
    activeAlertId = "";
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

  function showDialog(message, identity) {
    if (isAcknowledged(identity)) return false;
    // Enforce one actual DOM overlay across all instances, not only the
    // one overlay referenced by this content-script's local variables.
    const existing = alertHosts();
    if (existing.length) {
      for (const extra of existing.slice(1)) extra.remove();
      return false;
    }
    if (dialogRoot) {
      dialogRoot = null;
      dialogError = null;
      activeAlertId = "";
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
    activeAlertId = identity;
    (document.body || document.documentElement).appendChild(host);
    document.addEventListener("keydown", handleDialogKeydown, true);
    shadow.querySelector(".close").focus();
    return true;
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

  // Display errors from real site alerts OR a standalone alert phrase in the
  // assistant's latest response. Do not inspect chat-history user messages.
  function isWatchdogUi(node) {
    const element = node && node.nodeType === 3 ? node.parentNode : node;
    if (!element) return false;
    if (element.id === "chat-watchdog-alert-host" ||
        (element.getAttribute &&
         element.getAttribute("data-chat-watchdog-toast") !== null)) return true;
    return typeof element.closest === "function" &&
      !!element.closest("#chat-watchdog-alert-host, [data-chat-watchdog-toast]");
  }

  function checkError() {
    const selector = config.errorSelector ||
      '[role="alert"], [role="status"], [data-sonner-toast], [data-testid*="error"], .toast, .error-banner';
    const matches = [];
    for (const node of query(selector)) {
      if (!visible(node) || isWatchdogUi(node)) continue;
      const rawText = textOf(node).slice(0, 1000);
      const matched = Core.findError(rawText, config.errorWords);
      if (!matched) continue;
      const target = specificErrorNode(node, matched);
      const signature = matched + ":" + textOf(target).slice(0, 500);
      matches.push({ node: target, signature, phrase: matched });
    }
    const lastReply = latestAssistant(currentSelectors().assistant).node;
    let assistantErrorActive = false;
    if (lastReply && visible(lastReply) && !isWatchdogUi(lastReply)) {
      const phrase = Core.findErrorLine(textOf(lastReply), config.errorWords);
      if (phrase) {
        assistantErrorActive = true;
        // This is a logical alert attached to a user turn, not a DOM node.
        // React can replace the assistant element repeatedly without a new
        // reply; that must never restart the alarm after dismissal.
        const turn = latestUserTurn().logicalTurn ||
          Core.userTurnFingerprint(0, textOf(lastReply));
        const key = route + "\u0000" + turn + "\u0000" + phrase;
        if (!acknowledgedAssistantAlerts.has(key)) {
          acknowledgedAssistantAlerts.add(key);
          if (acknowledgedAssistantAlerts.size > 200) {
            acknowledgedAssistantAlerts.delete(acknowledgedAssistantAlerts.values().next().value);
          }
          matches.push({
            node: lastReply,
            signature: "assistant:" + phrase + ":" + turn,
            phrase
          });
        }
      }
    }
    const fresh = errorTracker.observe(matches);
    if (fresh) {
      recordEvent("error", "Ошибка: " + fresh.phrase);
      const id = alertIdentity(fresh.signature);
      if (isAcknowledged(id)) return assistantErrorActive || matches.length > 0;
      if (dialogRoot && alertHosts().includes(dialogRoot) && dialogError) {
        activeAlertId = id;
        dialogError.textContent = "Обнаружена ошибка: " + fresh.phrase;
      } else if (showDialog(fresh.phrase, id)) {
        // A second script instance must neither overlay the first nor
        // start a duplicate alarm.
        chrome.runtime.sendMessage({ type: "PLAY_ERROR" }).catch(() => {});
      }
    }
    return assistantErrorActive || matches.length > 0;
  }

  // A bounded per-tab event journal. No transcript text is stored.
  function recordEvent(type, message) {
    const signature = type + ":" + message;
    const now = Date.now();
    if (now - (lastEventSignature.get(signature) || 0) < 4000) return;
    lastEventSignature.set(signature, now);
    eventLog.push({
      time: new Date(now).toLocaleTimeString("ru-RU"),
      type,
      message
    });
    if (eventLog.length > 40) eventLog.shift();
    if (config.toastEnabled) showToast(message, type);
  }

  function showToast(message, type) {
    if (!document.body || typeof document.createElement !== "function") return;
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.setAttribute("data-chat-watchdog-toast", type || "info");
    toast.style.cssText =
      "position:fixed;bottom:88px;right:20px;max-width:min(420px,90vw);" +
      "z-index:2147483646;background:#202124;color:#fff;border-radius:9px;" +
      "padding:11px 15px;font:13px/1.45 system-ui,sans-serif;" +
      "pointer-events:none;box-shadow:0 6px 28px #0005;white-space:pre-wrap;";
    const previous = document.querySelectorAll &&
      document.querySelectorAll("[data-chat-watchdog-toast]");
    if (previous) for (const item of previous) item.remove();
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function autoDecision(message, eventType = "blocked") {
    lastAutoDecision = message;
    lastAutoDecisionAt = new Date(Date.now()).toLocaleTimeString("ru-RU");
    recordEvent(eventType, message);
  }

  function cooldownRemainingMs() {
    const localUntil = lastClickAt ? lastClickAt + config.cooldownSeconds * 1000 : 0;
    return Math.max(0, Math.max(localUntil, globalLockedUntil) - Date.now());
  }

  function hydrateCooldown() {
    const epoch = ++hydrationEpoch;
    const requestedRoute = location.href;
    cooldownHydrated = false;
    cancelPending();
    chrome.runtime.sendMessage({ type: "GET_SEND_STATE" }).then(state => {
      if (epoch !== hydrationEpoch || location.href !== requestedRoute) return;
      // Fail closed if background is unavailable: do not bypass the lock.
      if (!state || !state.ok || !Number.isFinite(state.lockedUntil)) {
        recordEvent("blocked", "Автопродолжение недоступно: таймер не синхронизирован");
        return;
      }
      globalLockedUntil = state.lockedUntil;
      cooldownHydrated = true;
      scheduleCheck();
    }).catch(() => {
      if (epoch === hydrationEpoch)
        recordEvent("blocked", "Автопродолжение недоступно: таймер не синхронизирован");
    });
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
    const expectedModeEpoch = modeEpoch;
    autoDecision("Таймер ожидания истёк — проверяем отправку", "attempt");
    if (sending || !config.enabled || config.mode !== "auto" ||
        !cooldownHydrated || cooldownRemainingMs() ||
        location.href !== route) {
      autoDecision("Отправка отменена: режим, блокировка или смена чата");
      return;
    }
    const selectors = currentSelectors();
    const result = latestAssistant(selectors.assistant);
    if (!result.node) {
      autoDecision("Отправка отменена: нет нового ответа ИИ после пользователя");
      return;
    }
    const text = textOf(result.node);
    const key = messageKey(result.node, result.count, text);
    const assistantToken = sendToken(result.node, text, result.count);
    if (key !== expectedKey) {
      autoDecision("Отправка отменена: ответ ИИ изменился за время ожидания");
      return;
    }
    if (result.ordinal <= lastClaimedAssistantOrdinal ||
        submittedAssistantTokens.has(assistantToken) ||
        sendGuard.alreadySent(text, latestUserTurn().logicalTurn)) {
      autoDecision("Отправка отменена: ответ уже обработан");
      return;
    }
    if (!Core.completionMatches(text, config.marker, config.markerRegex)) {
      autoDecision("Отправка отменена: маркер исчез из ответа");
      return;
    }
    if (hasStopButton(selectors.stop)) {
      autoDecision("Отправка отменена: генерация ещё идёт (кнопка Stop)");
      return;
    }
    if (config.completionSelector && !query(config.completionSelector).some(visible)) {
      autoDecision("Отправка отменена: нет элемента завершения");
      return;
    }
    if (checkError()) {
      autoDecision("Отправка отменена: обнаружена ошибка");
      return;
    }

    const remaining = cooldownRemainingMs();
    if (remaining) {
      recordEvent("blocked", "Пауза между отправками: ещё " +
        Math.ceil(remaining / 1000) + " с");
      return;
    }
    const editor = findEditor(selectors.editor);
    if (!editor || editorText(editor)) {
      recordEvent("blocked", editor ? "Поле ввода занято" : "Поле ввода не найдено");
      return; // Never overwrite a human draft.
    }
    // A stable finished reply must be the newest visible turn.
    if (!followsUser(result.node, latestUserTurn().node)) {
      autoDecision("Отправка отменена: пользователь отправил новое сообщение");
      return;
    }
    sending = true;
    try {
      fillEditor(editor, config.reply);
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (!config.enabled || config.mode !== "auto" ||
            modeEpoch !== expectedModeEpoch || location.href !== route) {
          autoDecision("Отправка отменена: изменился режим или чат");
          return;
        }
        if (editorText(editor) !== config.reply) {
          autoDecision("Отправка отменена: поле ввода изменено");
          return;
        }
        // CRITICAL: recheck stop state on EVERY retry and immediately
        // before click. A Stop button must NEVER be mistaken for Send.
        if (hasStopButton(selectors.stop)) {
          recordEvent("blocked", "Отправка отменена: появилась кнопка Stop");
          return;
        }
        if (checkError() || cooldownRemainingMs()) return;
        const current = latestAssistant(selectors.assistant);
        if (!current.node || messageKey(current.node, current.count, textOf(current.node)) !== expectedKey ||
            !followsUser(current.node, latestUserTurn().node) ||
            !Core.completionMatches(textOf(current.node), config.marker, config.markerRegex)) {
          autoDecision("Отправка отменена: ответ изменился после заполнения поля");
          return;
        }
        const button = findSendButton(selectors.send);
        if (!button) continue;
        if (!config.enabled || config.mode !== "auto" || modeEpoch !== expectedModeEpoch ||
            Core.isStopAction(button) || hasStopButton(selectors.stop)) return;
        const userTurn = latestUserTurn().logicalTurn;
        if (sendGuard.alreadySent(text, userTurn)) return;
        // The background worker owns the deduplication ledger for this tab.
        // It serializes claims and persists them in chrome.storage.session,
        // preventing another content-script instance from sending as well.
        const token = sendToken(current.node, text, current.count);
        if (submittedAssistantTokens.has(token) ||
            current.ordinal <= lastClaimedAssistantOrdinal) return;
        let claim;
        try {
          claim = await chrome.runtime.sendMessage({
            type: "CLAIM_SEND", token, assistantOrdinal: current.ordinal
          });
        } catch (error) {
          recordEvent("blocked", "Отправка отменена: нет подтверждения защиты от дублей");
          return; // Fail closed, not open.
        }
        if (!claim || !claim.ok) {
          if (claim && Number.isFinite(claim.lockedUntil))
            globalLockedUntil = Math.max(globalLockedUntil, claim.lockedUntil);
          recordEvent("blocked", claim && claim.reason === "cooldown" ?
            "Глобальная пауза: ещё " + claim.retryAfterSeconds + " с" :
            "Повторная отправка заблокирована");
          return;
        }
        globalLockedUntil = Math.max(globalLockedUntil,
          Number.isFinite(claim.lockedUntil) ? claim.lockedUntil :
          Date.now() + config.cooldownSeconds * 1000);
        cancelPending();
        // Reserve even if the UI changes while we are waiting. The
        // background ledger already owns this reply and must never retry it.
        submittedAssistantTokens.add(token);
        lastClaimedAssistantOrdinal = Math.max(lastClaimedAssistantOrdinal, current.ordinal);
        // Claim may take time: conditions can change during the await.
        // A claim is intentionally never rolled back, even if UI changed;
        // preventing duplicate Sends is more important than retrying blindly.
        if (!config.enabled || config.mode !== "auto" || modeEpoch !== expectedModeEpoch ||
            location.href !== route || hasStopButton(selectors.stop) ||
            editorText(editor) !== config.reply) return;
        const verified = latestAssistant(selectors.assistant);
        if (!verified.node ||
            !followsUser(verified.node, latestUserTurn().node) ||
            sendToken(verified.node, textOf(verified.node), verified.count) !== token ||
            !Core.completionMatches(textOf(verified.node), config.marker, config.markerRegex)) return;
        const finalButton = findSendButton(selectors.send);
        if (!finalButton || Core.isStopAction(finalButton) ||
            hasStopButton(selectors.stop) || !config.enabled ||
            config.mode !== "auto" || modeEpoch !== expectedModeEpoch) return;
        sendGuard.record(text, userTurn);
        lastUserTurnAtSend = userTurn;
        handled.add(expectedKey);
        lastClickAt = Date.now();
        sendClicks++;
        finalButton.click();
        // Separately record the actual click call in the shared background
        // audit. This identifies the originating tab even when the popup
        // inspects a different chat later.
        chrome.runtime.sendMessage({
          type: "WATCHDOG_SEND_CLICKED", assistantOrdinal: current.ordinal
        }).catch(() => {});
        autoDecision("Отправлено одно сообщение автопродолжения", "sent");
        recordEvent("sent", "Отправлено: " + config.reply);
        return;
      }
      recordEvent("blocked", "Кнопка отправки недоступна; текст оставлен в поле");
      console.warn("Chat Watchdog: send button unavailable; follow-up left in editor.");
    } finally {
      sending = false;
    }
  }

  function check() {
    if (!config.enabled) return;
    if (route !== location.href) {
      closeDialog();
      errorTracker.reset();
      acknowledgedAssistantAlerts.clear();
      route = location.href;
      lastClaimedAssistantOrdinal = 0;
      hydrateCooldown();
      seenInitial = false;
      lastKey = "";
      handled = new Set();
      cancelPending();
    }
    if (checkError()) {
      cancelPending();
      return;
    }
    if (config.mode === "errors") {
      cancelPending();
      return;
    }
    // Global lock is checked BEFORE inspecting the completion marker, so no
    // new timers, editor fills or Send attempts can start during cooldown.
    if (!cooldownHydrated || cooldownRemainingMs()) {
      cancelPending();
      return;
    }
    const selectors = currentSelectors();
    const result = latestAssistant(selectors.assistant);
    // Establish the baseline even for an empty/new conversation. Otherwise
    // the very first short assistant reply is silently ignored.
    if (!result.node) {
      if (pending) {
        autoDecision("Таймер отменён: пользователь отправил новое сообщение");
        cancelPending();
      }
      seenInitial = true;
      return;
    }
    const text = textOf(result.node);
    const key = messageKey(result.node, result.count, text);
    if (key !== lastKey) {
      if (pending) autoDecision("Таймер отменён: ответ изменился во время ожидания");
      lastKey = key;
      stableSince = Date.now();
      cancelPending();
    }
    if (!seenInitial) {
      seenInitial = true;
      if (Core.completionMatches(text, config.marker, config.markerRegex)) handled.add(key);
      return;
    }
    if (handled.has(key) || sending ||
      result.ordinal <= lastClaimedAssistantOrdinal ||
      submittedAssistantTokens.has(sendToken(result.node, text, result.count)) ||
      !Core.completionMatches(text, config.marker, config.markerRegex) ||
      sendGuard.alreadySent(text, latestUserTurn().logicalTurn)) return;
    if (Date.now() - stableSince < (config.marker ? 1500 : 4500)) return;
    if (hasStopButton(selectors.stop)) {
      recordEvent("blocked", "Ожидание: видна кнопка Stop");
      return;
    }
    if (cooldownRemainingMs()) {
      recordEvent("blocked", "Пауза между отправками: ещё " +
        Math.ceil(cooldownRemainingMs() / 1000) + " с");
      return;
    }
    if (config.completionSelector && !query(config.completionSelector).some(visible)) return;
    if (pending && pending.key === key) return;
    cancelPending();
    pending = {
      key,
      dueAt: Date.now() + config.delaySeconds * 1000,
      timer: setTimeout(() => { sendIfReady(key).catch(console.warn); },
        config.delaySeconds * 1000)
    };
    recordEvent("detected", config.marker ? "Найден маркер: " + config.marker +
      " — отправка через " + config.delaySeconds + " с" :
      "Ответ завершён — отправка через " + config.delaySeconds + " с");
  }

  function scheduleCheck() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(check, 300);
  }

  // Local-only diagnostics: return counts and booleans, never message content.
  function diagnosticSnapshot() {
    const selectors = currentSelectors();
    const found = assistantElements(selectors.assistant);
    const assistantNodes = found.nodes;
    const lastAssistant = assistantNodes[assistantNodes.length - 1];
    const editor = findEditor(selectors.editor);
    return {
      enabled: config.enabled,
      mode: config.mode,
      assistantCount: assistantNodes.length,
      assistantDetection: found.source,
      legacyAssistantCount: query('[data-message-author-role="assistant"]').length,
      chatGptSearchUnitCount: query('[data-content-search-unit-key$=":assistant"]').length,
      chatGptTurnCount: query('[data-turn-key]').length,
      chatGptUserBubbleCount: query('[data-user-message-bubble="true"]').length,
      customAssistantSelector: !!config.assistantSelector,
      markerDetected: !!lastAssistant &&
        Core.completionMatches(textOf(lastAssistant), config.marker, config.markerRegex),
      markerDisabled: !config.marker,
      assistantFollowsLastUser: !!lastAssistant &&
        followsUser(lastAssistant, latestUserTurn().node),
      markerAlreadySent: !!lastAssistant &&
        sendGuard.alreadySent(textOf(lastAssistant), latestUserTurn().logicalTurn),
      logicalUserTurnDetected: !!latestUserTurn().logicalTurn,
      sendClicks,
      rememberedAssistantReplies: submittedAssistantTokens.size,
      assistantOrdinal: latestAssistant(selectors.assistant).ordinal,
      lastClaimedAssistantOrdinal,
      cooldownRemainingSeconds: Math.ceil(cooldownRemainingMs() / 1000),
      cooldownHydrated, globalLockedUntil,
      sending,
      toastEnabled: config.toastEnabled,
      editorFound: !!editor,
      editorEmpty: !!editor && !editorText(editor),
      sendButtonFound: !!findSendButton(selectors.send),
      stopButtonVisible: hasStopButton(selectors.stop),
      pending: !!pending,
      seenInitial,
      lastAutoDecision, lastAutoDecisionAt,
      scheduledSendAt: pending ? pending.dueAt : null
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "WATCHDOG_LOG") {
      sendResponse({ events: eventLog.slice() });
      return false;
    }
    if (message && message.type === "WATCHDOG_CLEAR_LOG") {
      eventLog.length = 0;
      lastEventSignature.clear();
      sendResponse({ ok: true });
      return false;
    }
    if (message && message.type === "WATCHDOG_DIAGNOSE") {
      sendResponse(diagnosticSnapshot());
      return false;
    }
    if (!message || message.type !== "WATCHDOG_CONFIG") return false;
    const wasEnabled = config.enabled;
    const previousMode = config.mode;
    config = Core.normalize(message.config);
    if (previousMode !== config.mode) {
      modeEpoch++;
      cancelPending();
      if (config.enabled) recordEvent("mode", config.mode === "errors" ?
        "Режим: только ошибки — автоотправка отключена" :
        "Режим: автопродолжение и ошибки");
      // Returning to auto mode must not replay an already completed reply.
      if (config.mode === "auto") {
        hydrateCooldown();
        seenInitial = false;
        lastKey = "";
        handled = new Set();
      }
    }
    if (!config.enabled) {
      cooldownHydrated = false;
      hydrationEpoch++;
      cancelPending();
      errorTracker.reset();
      closeDialog();
    }
    if (!wasEnabled && config.enabled) {
      hydrateCooldown();
      route = location.href;
      seenInitial = false;
      handled = new Set();
      errorTracker.reset();
    }
    scheduleCheck();
  });

  chrome.runtime.sendMessage({ type: "GET_CONFIG" }).then((saved) => {
    config = Core.normalize(saved);
    if (config.enabled) hydrateCooldown();
    check();
  }).catch(() => {});

  // Detect reappearing errors even when a site removes and reinserts them
  // between two polling cycles. Text replacement can also happen in the
  // same persistent [role="alert"] element.
  function errorTextIn(node) {
    if (!node || isWatchdogUi(node)) return false;
    const content = node.nodeType === 3 ? node.nodeValue : node.textContent;
    return !!Core.findError(String(content || "").slice(0, 1000), config.errorWords);
  }

  function inspectMutations(records) {
    if (config.enabled) {
      for (const record of records) {
        if (isWatchdogUi(record.target)) continue;
        if (record.type === "childList") {
          const added = Array.from(record.addedNodes).filter(node => !isWatchdogUi(node));
          const removed = Array.from(record.removedNodes).filter(node => !isWatchdogUi(node));
          // Ignore our own dialog/toasts in BOTH directions. Their text often
          // contains the error phrase, so watching them created a feedback loop.
          const textRemoved = removed.some(errorTextIn);
          const textAdded = added.some(errorTextIn);
          for (const node of removed) errorTracker.forgetSubtree(node);
          // The tracker only re-arms an error if a mutation happens INSIDE
          // the actual error node, never merely somewhere inside the page.
          if (textRemoved || textAdded) errorTracker.markUpdated(record.target);
        } else if (record.type === "characterData") {
          if (errorTextIn(record.target)) {
            errorTracker.markUpdated(record.target.parentNode);
          }
        } else if (record.type === "attributes") {
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
