(function () {
  "use strict";
  if (globalThis.__CHAT_WATCHDOG_RUNNING__) return;
  globalThis.__CHAT_WATCHDOG_RUNNING__ = true;

  const Core = globalThis.ChatWatchdogCore;
  let config = Core.normalize();
  const GLOBAL_ERRORS_KEY = "watchdog:global:error-words:v1";
  let sharedErrorWords = null;
  chrome.storage?.onChanged?.addListener((changes, area) => {
    const next = area === "local" && changes[GLOBAL_ERRORS_KEY]?.newValue;
    if (typeof next !== "string") return;
    sharedErrorWords = next;
    // Do not invalidate the pending GET_CONFIG reply at startup: that reply
    // also contains the per-tab ON/OFF state. Keep the live shared list on top.
    config = Core.normalize({ ...config, errorWords: next, errorWordsVersion: 3 });
    if (config.enabled) scheduleCheck();
  });
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
  let dialogLeaseId = null;
  let dialogClaimPending = false;
  let dialogEpoch = 0;
  // An error can temporarily disappear during ChatGPT DOM reconciliation.
  // Acknowledgement is per user turn and phrase, NOT a 2.5-second timeout:
  // otherwise one error can reopen repeatedly after a single dismissal.
  const dismissedErrorIncidents = new Set();
  let visibleErrorIncidents = new Set();
  let activeDialogIncidentKey = null;
  // These small hashed acknowledgements live in the shared DOM, so multiple
  // injected observers of this extension cannot undo each other's dismissals.
  const ERROR_ACK_ATTR = "data-chat-watchdog-error-acks";

  function errorIncidentKey(phrase) {
    const userTurn = latestUserTurn().logicalTurn || "no-user-turn";
    return route + "|" + userTurn + "|" + String(phrase).toLocaleLowerCase().trim();
  }

  function incidentHash(key) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function acknowledgedInPage(key) {
    const element = document.documentElement;
    if (!element || typeof element.getAttribute !== "function") return false;
    return (element.getAttribute(ERROR_ACK_ATTR) || "").split(",")
      .includes(incidentHash(key));
  }

  function acknowledgeError(key) {
    dismissedErrorIncidents.add(key);
    if (dismissedErrorIncidents.size > 256)
      dismissedErrorIncidents.delete(dismissedErrorIncidents.values().next().value);
    const element = document.documentElement;
    if (!element || typeof element.setAttribute !== "function" ||
        typeof element.getAttribute !== "function") return;
    const previous = (element.getAttribute(ERROR_ACK_ATTR) || "").split(",").filter(Boolean);
    const hash = incidentHash(key);
    if (!previous.includes(hash)) previous.push(hash);
    element.setAttribute(ERROR_ACK_ATTR, previous.slice(-256).join(","));
  }

  function trackErrorIncidents(activeKeys) {
    visibleErrorIncidents = activeKeys;
  }

  function isErrorAcknowledged(key) {
    return dismissedErrorIncidents.has(key) || acknowledgedInPage(key);
  }
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
  // Only a real send attempt counts. Monitoring, streaming and changing text
  // must not use up the five attempts for an assistant reply.
  const attemptsByAssistant = new Map();
  const exhaustedAssistantTokens = new Set();
  let watchdogDraft = null;
  let lastClaimRejectReason = null;
  let lastClaimRejectOrdinal = null;
  let configRevision = 0;
  // Completion alerts use a separate stable-turn key and are evaluated before
  // the auto-send cooldown / error modes. They never depend on the marker.
  let completionInitialized = false;
  let completionCandidate = null;
  const completionNotified = new Set();
  let completionNotifications = 0;
  let completionBaselineToken = null;
  let missingMarkerCandidate = null;
  const missingMarkerNotified = new Set();
  // An independent wake-up at the end of each cooldown complements the
  // MutationObserver and 1.5-second polling timer. No state is reset after
  // Send: the existing duplicate guards must remain intact.
  let cooldownWakeTimer = null;
  let cooldownWakeAt = 0;
  let cooldownWakeCount = 0;
  let lastMonitorCheckAt = 0;
  let monitorCheckCount = 0;
  let healthWakeCount = 0;
  let lastHealthWakeAt = 0;

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

  // A repeated user phrase is NOT a message identity. Only ChatGPT-provided
  // DOM turn/message keys are authoritative; text+visible-count is diagnostic
  // fallback only (it can collide when the virtualized chat window changes).
  function stableUserTurn(node) {
    for (const [selector, attribute] of [
      ["[data-turn-key]", "data-turn-key"],
      ["[data-message-id]", "data-message-id"],
      ["[data-content-search-unit-key]", "data-content-search-unit-key"]
    ]) {
      const owner = node && typeof node.closest === "function" && node.closest(selector);
      const value = owner && typeof owner.getAttribute === "function" && owner.getAttribute(attribute);
      if (typeof value === "string" && value.trim())
        return "user:" + value.trim();
    }
    return null;
  }

  // The current app-shell has multiple account-dependent DOM variants.
  // Choose one user-bubble scheme instead of counting nested aliases.
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
      const stableKey = stableUserTurn(node);
      return {
        node,
        logicalTurn: stableKey || Core.userTurnFingerprint(nodes.length, textOf(node)),
        stable: !!stableKey
      };
    }
    return { node: null, logicalTurn: null, stable: false };
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

  function sendGuardTurn(result) {
    const user = latestUserTurn();
    // A fingerprint derived from text and visible DOM count is not safe to
    // use as an exclusive send guard. Stable assistant ID is the next-best
    // identity. For ID-less assistants, the ordinal fail-closed guard remains.
    return user.stable ? user.logicalTurn :
      sendToken(result.node, textOf(result.node), result.count);
  }

  function ordinalAlreadyHandled(ordinal, token) {
    // A stable assistant identity survives ChatGPT's virtualized DOM. Only
    // apply the ordinal guard to old layouts without stable message IDs.
    return !token.includes("|assistant:") &&
      ordinal <= lastClaimedAssistantOrdinal;
  }

  function completionTurnKey(result) {
    const node = result.node;
    if (!node) return null;
    for (const [selector, attr] of [
      ["[data-turn-key]", "data-turn-key"],
      ["[data-message-id]", "data-message-id"],
      ["[data-content-search-unit-key]", "data-content-search-unit-key"]
    ]) {
      const parent = typeof node.closest === "function" && node.closest(selector);
      const id = parent && parent.getAttribute(attr);
      if (id) return route + "|complete:" + id;
    }
    // Unlike sendToken(), a completion key must not change while the text
    // streams. Fallback to the position and latest user turn instead.
    return route + "|complete-fallback:" + result.ordinal + ":" +
      (latestUserTurn().logicalTurn || "unknown");
  }

  function checkReplyCompletion() {
    if (!config.enabled) return;
    const result = latestAssistant(currentSelectors().assistant);
    const stopped = hasStopButton(currentSelectors().stop);
    if (!result.node) {
      completionInitialized = true;
      completionCandidate = null;
      return;
    }
    const token = completionTurnKey(result);
    const text = textOf(result.node);
    const now = Date.now();
    if (!completionInitialized) {
      completionInitialized = true;
      // Do not play the old chat history upon enabling the extension.
      if (!stopped && text) {
        completionNotified.add(token);
        completionBaselineToken = token;
      }
    }
    if (!text || !followsUser(result.node, latestUserTurn().node) ||
        completionNotified.has(token)) return;
    if (!completionCandidate || completionCandidate.token !== token ||
        completionCandidate.text !== text) {
      completionCandidate = { token, text, stableAt: now, stopSeen: stopped };
      return;
    }
    if (stopped) {
      completionCandidate.stableAt = now;
      completionCandidate.stopSeen = true;
      return;
    }
    if (completionCandidate.stopSeen) {
      // Require a fresh stability window after Stop disappears.
      completionCandidate.stopSeen = false;
      completionCandidate.stableAt = now;
      return;
    }
    // Must be both stable and not actively generating. This is independent
    // from the user's completion-marker setting and auto-send delay.
    if (now - completionCandidate.stableAt < 3000) return;
    completionNotified.add(token);
    if (completionNotified.size > 200) completionNotified.delete(completionNotified.values().next().value);
    completionNotifications++;
    // Playback is available from bundled sounds even when no custom file
    // has been selected. Background/offscreen chooses the configured override
    // or bundled sfx-16.mp3 and deduplicates each assistant completion.
    chrome.runtime.sendMessage({ type: "PLAY_COMPLETION", token }).catch(() => {});
  }

  // Optional heuristic: a stable answer without a configured completion
  // marker is suspicious, but it is NOT a proven transport error. The user
  // must opt in, and each assistant turn triggers at most one notification.
  function checkMissingMarker() {
    if (!config.enabled || config.mode === "continue" ||
        !config.missingMarkerError || !config.marker) {
      missingMarkerCandidate = null;
      return;
    }
    const result = latestAssistant(currentSelectors().assistant);
    if (!result.node || hasStopButton(currentSelectors().stop)) {
      missingMarkerCandidate = null;
      return;
    }
    const token = completionTurnKey(result);
    const text = textOf(result.node);
    if (!text || token === completionBaselineToken || missingMarkerNotified.has(token) ||
        Core.completionMatches(text, config.marker, config.markerRegex)) {
      missingMarkerCandidate = null;
      return;
    }
    if (!missingMarkerCandidate || missingMarkerCandidate.token !== token ||
        missingMarkerCandidate.text !== text) {
      missingMarkerCandidate = { token, text, stableSince: Date.now() };
      return;
    }
    if (Date.now() - missingMarkerCandidate.stableSince < 10000) return;
    missingMarkerNotified.add(token);
    if (missingMarkerNotified.size > 200)
      missingMarkerNotified.delete(missingMarkerNotified.values().next().value);
    const message = "Ответ завершился без маркера «" + config.marker + "» (возможен обрыв)";
    recordEvent("error", message);
    playErrorSound(errorIncidentKey(message));
    if (dialogRoot) dialogError.textContent = message;
    else showDialog(message);
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
    const editors = query(selector).filter((element) => visible(element) &&
      (element.isContentEditable || /^(TEXTAREA|INPUT)$/.test(element.tagName)));
    if (editors.length <= 1) return editors[0];
    // ChatGPT may keep a secondary or stale composer in the DOM. Prefer the
    // editor whose form owns the live Send button instead of DOM order.
    const sendSelector = currentSelectors().send;
    const linked = editors.filter((element) => {
      const form = typeof element.closest === "function" && element.closest("form");
      return !!(form && typeof form.querySelector === "function" &&
        form.querySelector(sendSelector));
    });
    const candidates = linked.length ? linked : editors;
    const focused = candidates.find((element) =>
      element === document.activeElement ||
      (typeof element.contains === "function" && element.contains(document.activeElement)));
    if (focused) return focused;
    return candidates.find((element) => element.id === "prompt-textarea") || candidates[0];
  }

  function findSendButton(selector, editor = null) {
    const isEnabled = (button) => visible(button) && !Core.isStopAction(button) &&
      !button.disabled && button.getAttribute("aria-disabled") !== "true";
    // Prefer the button associated with the composer we filled. A second
    // mounted chat/editor must never redirect our send to the wrong form.
    const form = editor && typeof editor.closest === "function" && editor.closest("form");
    if (form && typeof form.querySelectorAll === "function") {
      let sameForm = [];
      try { sameForm = Array.from(form.querySelectorAll(selector)); } catch {}
      if (sameForm.length) return sameForm.find(isEnabled);
    }
    return query(selector).find(isEnabled);
  }

  function hasStopButton(selector) {
    if (query(selector).some(visible)) return true;
    if (!isChatGPT()) return false;
    // Check actual visible stop actions even when the current site uses a
    // new selector not yet covered by our defaults.
    return query("button[aria-label], button[title], button[data-testid]")
      .some(button => visible(button) && Core.isStopAction(button));
  }

  function playErrorSound(incidentKey) {
    // Sound is a notification about a NEW error, not a side effect of creating
    // a modal. A denied modal claim must never silence a new error. The worker
    // atomically deduplicates incidentKey across observers within this tab.
    chrome.runtime.sendMessage({ type: "PLAY_ERROR", incidentKey }).then(result => {
      if (result && result.ok === false && !result.cancelled &&
          result.reason !== "audio-incident-duplicate")
        recordEvent("error", "Звук ошибки не воспроизведён: " +
          (result.error || result.reason || "неизвестная причина"));
    }).catch(error => recordEvent("error", "Ошибка запуска звука: " + String(error)));
  }

  function closeDialog() {
    dialogEpoch++;
    const leaseId = dialogLeaseId;
    dialogLeaseId = null;
    if (leaseId) {
      chrome.runtime.sendMessage({ type: "RELEASE_ERROR_DIALOG", leaseId }).catch(() => {});
    }
    if (dialogRoot) {
      for (const key of visibleErrorIncidents) acknowledgeError(key);
      if (activeDialogIncidentKey) acknowledgeError(activeDialogIncidentKey);
      dialogRoot.remove();
      dialogRoot = null;
      dialogError = null;
      activeDialogIncidentKey = null;
      // Older injected scripts or duplicate installations may have created
      // additional overlays. One user dismissal removes all of them.
      for (const duplicate of query("#chat-watchdog-alert-host")) duplicate.remove();
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

  async function showDialog(message, incidentKey = errorIncidentKey(message)) {
    if (isErrorAcknowledged(incidentKey) || dialogClaimPending) return false;
    // This permission is serialized by the extension worker across ALL
    // observers/frames in this tab, not just the current document.
    const epoch = dialogEpoch;
    const targetRoute = route;
    dialogClaimPending = true;
    let claim;
    try {
      claim = await chrome.runtime.sendMessage({ type: "CLAIM_ERROR_DIALOG", incidentKey });
    } catch (error) {
      recordEvent("blocked", "Не удалось проверить доступность окна ошибки: " + String(error));
      return false;
    } finally { dialogClaimPending = false; }
    if (!claim?.ok) return false;
    const release = () => chrome.runtime.sendMessage({
      type: "RELEASE_ERROR_DIALOG", leaseId: claim.leaseId
    }).catch(() => {});
    if (epoch !== dialogEpoch || targetRoute !== route || !config.enabled ||
        config.mode === "continue" || isErrorAcknowledged(incidentKey) ||
        query("#chat-watchdog-alert-host").length || dialogRoot) {
      release();
      return false;
    }
    dialogLeaseId = claim.leaseId;
    // The tab-wide claim was granted; the page-wide DOM check above also
    // protects against older injected scripts using the same dialog host ID.
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
    activeDialogIncidentKey = incidentKey;
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

  // ChatGPT can put a recovery button inside an otherwise standalone alert.
  // The button's label must not become the "last line" of the error message.
  // Clone only the alert, remove UI actions/hidden decoration, and match the
  // remaining message. Never scan the surrounding conversation container.
  // Text matching is independent of the HTML element used to render a
  // notification. Strip controls (such as "Start new chat") before matching.
  // Never use broad document/turn text to infer that the user got an error.
  function systemAlertMessage(node) {
    if (!node || typeof node.cloneNode !== "function") return textOf(node);
    const copy = node.cloneNode(true);
    if (typeof copy.querySelectorAll === "function") {
      for (const action of copy.querySelectorAll(
        'button, [role="button"], [aria-hidden="true"], input, textarea, nav, script, style'
      )) action.remove();
    }
    return String(copy.textContent || "").trim();
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

  const SYSTEM_CANDIDATE_SELECTOR = 'div, span, p, aside, section, li, [role="paragraph"]';
  const SYSTEM_NOTICE_SELECTOR =
    '[role="alert"], [role="status"], [aria-live="assertive"], ' +
    '[data-sonner-toast], [data-testid*="error"], ' +
    '.toast, .error-banner, .alert-danger, [data-state="error"]';
  const AUTHOR_CONTAINER_SELECTOR =
    '[data-message-author-role="assistant"], [data-message-role="assistant"], ' +
    '[data-role="assistant"], [data-message-author="assistant"], ' +
    '[data-testid="assistant-message"], [data-content-search-unit-key$=":assistant"], ' +
    '[data-content-search-unit-key$=":assistant:final"], ' +
    '.font-claude-message, model-response, .model-response, .ds-markdown';
  const USER_CONTAINER_SELECTOR =
    '[data-user-message-bubble], [data-message-author-role="user"], ' +
    '[data-message-role="user"], [data-content-search-unit-key$=":user"], ' +
    '[data-testid="user-message"]';
  // Some providers don't expose user-turn IDs. On those pages, text-only
  // notifications must be NEW or CHANGED since observation began: otherwise a
  // historical quote containing an exact error phrase may fire at startup.
  let systemBaselineReady = false;
  let observedSystemText = new WeakMap();
  const recentlyChangedSystemNodes = new Set();

  function systemTextMatch(node, explicit) {
    const raw = String(node && (node.textContent || textOf(node)) || "");
    if (!raw || raw.length > 900 || !Core.findError(raw, config.errorWords)) return null;
    const cleaned = systemAlertMessage(node).replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.length > 500) return null;
    // A complete system notice can have a recovery action removed from it.
    // Generic user-configured phrases also work, but never match substrings
    // from an arbitrary message or entire transcript container.
    return Core.findSystemErrorLine(cleaned, config.errorWords) ||
      Core.findErrorLine(cleaned, config.errorWords);
  }

  function systemCandidateAllowed(node, explicit, currentUser, currentReply) {
    if (!visible(node) || isWatchdogUi(node)) return false;
    if (typeof node.closest === "function") {
      if (node.closest(USER_CONTAINER_SELECTOR + ', [contenteditable], ' +
          '[data-composer-input], form, pre, code, #chat-watchdog-alert-host')) return false;
      if (!explicit && node.closest('nav, header, footer, [role="dialog"], button')) return false;
      const authored = node.closest(AUTHOR_CONTAINER_SELECTOR);
      // Explicit UI notifications inside the currently active assistant turn
      // are allowed; ordinary text inside any assistant message is not.
      if (authored && (!explicit || !currentReply ||
          (authored !== currentReply &&
           !(typeof currentReply.contains === "function" && currentReply.contains(authored)))))
        return false;
    }
    // Never read large wrappers containing history as independent errors.
    if (typeof node.querySelector === "function" && node.querySelector(
      USER_CONTAINER_SELECTOR + ', ' + AUTHOR_CONTAINER_SELECTOR +
      ', [data-turn-key], [data-content-search-unit-key], [contenteditable]')) return false;
    if (!explicit && currentUser && !followsUser(node, currentUser)) {
      // Some providers mount newly-created toast portals BEFORE <main> in
      // DOM order. A fresh mutation outside the conversation is still a new
      // notice; a pre-existing element or an old in-chat quote is not.
      const outsideChat = typeof node.closest === "function" &&
        !node.closest('main, [role="main"]');
      if (!(outsideChat && recentlyChangedSystemNodes.has(node))) return false;
    }
    // Role-based notifications in portals can precede the chat in DOM order;
    // within main, however, a notification before the latest user is stale.
    if (explicit && currentUser && typeof node.closest === "function" &&
        node.closest('main, [role="main"]') && !followsUser(node, currentUser)) return false;
    return true;
  }

  function checkError() {
    const currentUser = latestUserTurn().node;
    const currentReply = latestAssistant(currentSelectors().assistant).node;
    const explicitNodes = new Set([
      ...query(SYSTEM_NOTICE_SELECTOR).slice(-800),
      ...query(config.errorSelector).slice(-800)
    ]);
    const matches = [];
    const matchedTargets = new Set();
    // First look at semantic UI notices on ANY provider: role, aria-live,
    // toast classes and custom CSS selectors. Custom selectors are additive:
    // an invalid override must not silently disable the built-in detector.
    for (const node of explicitNodes) {
      if (!systemCandidateAllowed(node, true, currentUser, currentReply)) continue;
      const phrase = systemTextMatch(node, true);
      if (!phrase) continue;
      const target = specificErrorNode(node, phrase);
      if (matchedTargets.has(target)) continue;
      matchedTargets.add(target);
      matches.push({node: target,
        signature: "notice:" + phrase + ":" + systemAlertMessage(target).slice(0, 500), phrase});
    }
    // The same error may be a plain <div>, <span>, <p>, <section>, <li>,
    // or <aside> with NO role/class. Search for exact configured errors on
    // supported and custom sites alike, with strict author/history exclusions.
    // DOM mutations additionally cover portals inserted before the chat.
    const candidates = new Set([
      ...query(SYSTEM_CANDIDATE_SELECTOR).slice(-1400),
      ...recentlyChangedSystemNodes
    ]);
    for (const node of candidates) {
      if (!node || matchedTargets.has(node)) continue;
      const raw = String(node.textContent || textOf(node) || "");
      const priorText = observedSystemText.get(node);
      observedSystemText.set(node, raw.slice(0, 900));
      // Most elements on a large chat page contain no known error text.
      // Avoid expensive layout/ancestor checks for those elements.
      if (raw.length > 900 || !Core.findError(raw, config.errorWords)) continue;
      if (!systemCandidateAllowed(node, false, currentUser, currentReply)) continue;
      // Without a known user turn, only a NEW/CHANGED free-standing message
      // can alert; don't wake up to yesterday's error on initial activation.
      if (!currentUser && !recentlyChangedSystemNodes.has(node) &&
          (!systemBaselineReady || priorText === undefined ||
           priorText === raw.slice(0, 900))) continue;
      const phrase = systemTextMatch(node, false);
      if (!phrase) continue;
      const target = specificErrorNode(node, phrase);
      if (matchedTargets.has(target)) continue;
      // If the error also appears in a nested leaf, prefer that leaf over a
      // parent. Dedupe by node and later by logical error incident.
      matchedTargets.add(target);
      const signature = "system:" + phrase + ":" + systemAlertMessage(target).slice(0, 500);
      matches.push({node: target, signature, phrase});
    }
    systemBaselineReady = true;
    recentlyChangedSystemNodes.clear();
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
    trackErrorIncidents(new Set(matches.map((entry) => errorIncidentKey(entry.phrase))));
    const fresh = errorTracker.observe(matches);
    if (fresh && !isErrorAcknowledged(errorIncidentKey(fresh.phrase))) {
      recordEvent("error", "Ошибка: " + fresh.phrase);
      // Audio must not depend on whether the tab-wide modal is newly opened,
      // already open, or temporarily blocked by a stale dialog lease.
      playErrorSound(errorIncidentKey(fresh.phrase));
      if (dialogRoot) {
        dialogError.textContent = "Обнаружена ошибка: " + fresh.phrase;
      } else {
        showDialog(fresh.phrase);
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

  function cancelCooldownWake() {
    if (cooldownWakeTimer !== null) clearTimeout(cooldownWakeTimer);
    cooldownWakeTimer = null;
    cooldownWakeAt = 0;
  }

  function armCooldownWake() {
    if (!config.enabled || config.mode === "errors" || !cooldownHydrated) {
      cancelCooldownWake();
      return;
    }
    const remaining = cooldownRemainingMs();
    if (remaining <= 0) {
      cancelCooldownWake();
      return;
    }
    const dueAt = Date.now() + remaining + 100;
    if (cooldownWakeTimer !== null && Math.abs(cooldownWakeAt - dueAt) < 250) return;
    cancelCooldownWake();
    cooldownWakeAt = dueAt;
    const expectedRoute = route;
    cooldownWakeTimer = setTimeout(() => {
      cooldownWakeTimer = null;
      cooldownWakeAt = 0;
      if (!config.enabled || config.mode === "errors" || route !== expectedRoute) return;
      cooldownWakeCount++;
      recordEvent("monitor", "Пауза завершена — проверка нового ответа ИИ");
      scheduleCheck();
    }, remaining + 100);
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
      armCooldownWake();
      scheduleCheck();
    }).catch(() => {
      if (epoch === hydrationEpoch)
        recordEvent("blocked", "Автопродолжение недоступно: таймер не синхронизирован");
    });
  }

  function cleanOwnDraft(token) {
    if (watchdogDraft && (!token || watchdogDraft.token === token)) {
      const { editor, text } = watchdogDraft;
      if (editorText(editor) === text) fillEditor(editor, "");
      watchdogDraft = null;
    }
  }

  function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  function editorText(editor) {
    // innerText is the rendered, user-visible text. An empty innerText must
    // NOT fall back to textContent: hidden placeholder/stale DOM text can
    // persist after ChatGPT clears a ProseMirror contenteditable field.
    const text = editor.isContentEditable
      ? (typeof editor.innerText === "string" ? editor.innerText : editor.textContent || "")
      : String(editor.value || "");
    return text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
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

  // No click occurred: remove the provisional shared claim, allowing the
  // following scheduled attempt to try again without losing duplicate safety.
  async function releaseUnclickedClaim(token, claim) {
    try {
      const result = await chrome.runtime.sendMessage({
        type: "RELEASE_UNCLICKED_SEND", token, leaseId: claim.leaseId
      });
      if (result?.ok && Number.isFinite(result.lockedUntil)) {
        globalLockedUntil = result.lockedUntil;
        armCooldownWake();
      } else {
        // A failed rollback is ambiguous. Do not risk a double submission.
        submittedAssistantTokens.add(token);
        recordEvent("blocked", "Резервирование отправки не удалось снять — повтор заблокирован");
      }
    } catch {
      submittedAssistantTokens.add(token);
      recordEvent("blocked", "Не удалось подтвердить отмену отправки — повтор заблокирован");
    }
  }

  async function sendIfReady(expectedKey) {
    pending = null;
    const expectedModeEpoch = modeEpoch;
    autoDecision("Таймер ожидания истёк — проверяем отправку", "attempt");
    if (sending || !config.enabled || config.mode === "errors" ||
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
    if (ordinalAlreadyHandled(result.ordinal, assistantToken) ||
        submittedAssistantTokens.has(assistantToken) ||
        sendGuard.alreadySent(text, sendGuardTurn(result))) {
      autoDecision("Отправка отменена: ответ уже обработан");
      return;
    }
    if (!Core.completionMatches(text, config.marker, config.markerRegex)) {
      autoDecision("Отправка отменена: маркер исчез из ответа");
      return;
    }
    if (config.completionSelector && !query(config.completionSelector).some(visible)) {
      autoDecision("Отправка отменена: нет элемента завершения");
      return;
    }
    if (config.mode !== "continue" && checkError()) {
      autoDecision("Отправка отменена: обнаружена ошибка");
      return;
    }

    const remaining = cooldownRemainingMs();
    if (remaining) {
      recordEvent("blocked", "Пауза между отправками: ещё " +
        Math.ceil(remaining / 1000) + " с");
      return;
    }
    // Count only attempts that reach the actual composer/Stop/Send checks.
    const attempt = (attemptsByAssistant.get(assistantToken) || 0) + 1;
    if (attempt > 5) return;
    attemptsByAssistant.set(assistantToken, attempt);
    const failed = (reason) => {
      autoDecision(reason + ": " + attempt + "/5");
      if (attempt === 5) {
        exhaustedAssistantTokens.add(assistantToken);
        cleanOwnDraft(assistantToken);
        cancelPending();
        autoDecision("Лимит 5/5 попыток отправки: текущий ответ пропущен; монитор активен");
      }
    };
    if (hasStopButton(selectors.stop)) {
      failed("Кнопка Stop блокирует отправку");
      return;
    }
    const editor = findEditor(selectors.editor);
    // The composer can outlive a content-script restart or a lost draft
    // reference. Reuse its text when it exactly equals the configured
    // auto-reply, regardless of who entered it. Never overwrite other text.
    const currentDraft = editor ? editorText(editor) : "";
    const replyAlreadyPresent = !!(editor && currentDraft === config.reply);
    if (!editor || (currentDraft && !replyAlreadyPresent)) {
      failed(editor ? "Поле ввода занято" : "Поле ввода не найдено");
      return; // Preserve any different user draft.
    }
    // A stable finished reply must be the newest visible turn.
    if (!followsUser(result.node, latestUserTurn().node)) {
      autoDecision("Отправка отменена: пользователь отправил новое сообщение");
      return;
    }
    sending = true;
    try {
      if (!replyAlreadyPresent) {
        fillEditor(editor, config.reply);
        watchdogDraft = { editor, text: config.reply, token: assistantToken };
      }
      // Reactive UIs sometimes need more than 2 seconds to activate Send.
      for (let retry = 0; retry < 25; retry++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (!config.enabled || config.mode === "errors" ||
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
          failed("Кнопка Stop блокирует отправку");
          return;
        }
        if ((config.mode !== "continue" && checkError()) || cooldownRemainingMs()) return;
        const current = latestAssistant(selectors.assistant);
        if (!current.node || messageKey(current.node, current.count, textOf(current.node)) !== expectedKey ||
            !followsUser(current.node, latestUserTurn().node) ||
            !Core.completionMatches(textOf(current.node), config.marker, config.markerRegex)) {
          autoDecision("Отправка отменена: ответ изменился после заполнения поля");
          return;
        }
        const button = findSendButton(selectors.send, editor);
        if (!button) continue;
        if (!config.enabled || config.mode === "errors" || modeEpoch !== expectedModeEpoch) return;
        if (Core.isStopAction(button) || hasStopButton(selectors.stop)) {
          failed("Кнопка Stop блокирует отправку");
          return;
        }
        const user = latestUserTurn();
        const userTurn = user.logicalTurn;
        if (sendGuard.alreadySent(text, sendGuardTurn(current))) return;
        // The background worker owns the deduplication ledger for this tab.
        // It serializes claims and persists them in chrome.storage.session,
        // preventing another content-script instance from sending as well.
        const token = sendToken(current.node, text, current.count);
        if (submittedAssistantTokens.has(token) ||
            ordinalAlreadyHandled(current.ordinal, token)) return;
        let claim;
        try {
          claim = await chrome.runtime.sendMessage({
            type: "CLAIM_SEND", token, assistantOrdinal: current.ordinal,
            userTurnKey: userTurn,
            userTurnStable: user.stable,
            assistantStable: token.includes("|assistant:")
          });
        } catch (error) {
          recordEvent("blocked", "Отправка отменена: нет подтверждения защиты от дублей");
          return; // Fail closed, not open.
        }
        if (!claim || !claim.ok) {
          if (claim && Number.isFinite(claim.lockedUntil))
            globalLockedUntil = Math.max(globalLockedUntil, claim.lockedUntil);
          lastClaimRejectReason = claim?.reason || "unknown";
          lastClaimRejectOrdinal = current.ordinal;
          if (claim?.reason === "cooldown") {
            recordEvent("blocked", "Глобальная пауза: ещё " +
              claim.retryAfterSeconds + " с");
            armCooldownWake();
          } else if (["duplicate", "user-turn-already-handled",
                      "assistant-already-handled"].includes(claim?.reason)) {
            // These are definitive deduplication verdicts, not transient UI
            // failures. Retrying five times can never change the verdict.
            // Skip this answer, while leaving the observer active for new ones.
            handled.add(expectedKey);
            cancelPending();
            cleanOwnDraft(assistantToken);
            autoDecision("Фоновая защита: ответ уже обработан (" +
              lastClaimRejectReason + "); повтор не требуется");
          } else {
            failed("Фоновая защита отклонила отправку (" + lastClaimRejectReason + ")");
          }
          return;
        }
        globalLockedUntil = Math.max(globalLockedUntil,
          Number.isFinite(claim.lockedUntil) ? claim.lockedUntil :
          Date.now() + config.cooldownSeconds * 1000);
        cancelPending();
        // The claim is provisional until Send is actually clicked. If the
        // composer changes during the worker round trip, RELEASE it safely.
        if (!config.enabled || config.mode === "errors" || modeEpoch !== expectedModeEpoch ||
            location.href !== route || hasStopButton(selectors.stop) ||
            editorText(editor) !== config.reply) {
          await releaseUnclickedClaim(token, claim);
          failed("Отправка заблокирована до нажатия Send");
          return;
        }
        const verified = latestAssistant(selectors.assistant);
        if (!verified.node ||
            !followsUser(verified.node, latestUserTurn().node) ||
            sendToken(verified.node, textOf(verified.node), verified.count) !== token ||
            !Core.completionMatches(textOf(verified.node), config.marker, config.markerRegex)) {
          await releaseUnclickedClaim(token, claim);
          autoDecision("Ответ изменился до нажатия Send");
          return;
        }
        const finalButton = findSendButton(selectors.send, editor);
        if (!finalButton || Core.isStopAction(finalButton) ||
            hasStopButton(selectors.stop) || !config.enabled ||
            config.mode === "errors" || modeEpoch !== expectedModeEpoch) {
          await releaseUnclickedClaim(token, claim);
          failed("Кнопка Send исчезла до отправки");
          return;
        }
        // From this point onward clicking is ambiguous if ChatGPT delays
        // processing. Never release this token after the click attempt.
        submittedAssistantTokens.add(token);
        lastClaimedAssistantOrdinal = Math.max(lastClaimedAssistantOrdinal, current.ordinal);
        sendGuard.record(text, sendGuardTurn(current));
        lastUserTurnAtSend = userTurn;
        handled.add(expectedKey);
        lastClickAt = Date.now();
        sendClicks++;
        try { finalButton.click(); }
        catch (error) {
          recordEvent("blocked", "Клик Send завершился ошибкой; повтор запрещён во избежание дубля");
          return;
        }
        watchdogDraft = null;
        // A click is not proof the app accepted the message. Diagnose a
        // stuck composer, but do not click twice after an ambiguous send.
        const clickRoute = route;
        setTimeout(() => {
          if (route === clickRoute && editor.isConnected !== false &&
              latestUserTurn().logicalTurn === userTurn &&
              editorText(editor) === config.reply) {
            recordEvent("blocked", "Нажатие Send не подтверждено: текст остался в поле; " +
              "автоповтор запрещён для защиты от дублей");
          }
        }, 2500);
        // Explicitly re-arm monitoring after Send. Also wake at cooldown end
        // even if the next answer arrived while we were paused.
        armCooldownWake();
        scheduleCheck();
        recordEvent("monitor", "Монитор активен — ожидаем следующий ответ ИИ");
        autoDecision("Отправлено одно сообщение автопродолжения", "sent");
        recordEvent("sent", "Отправлено: " + config.reply);
        return;
      }
      failed("Кнопка отправки недоступна");
      console.warn("Chat Watchdog: send button unavailable; retry is bounded.");
    } finally {
      sending = false;
    }
  }

  function check() {
    if (!config.enabled) return;
    lastMonitorCheckAt = Date.now();
    monitorCheckCount++;
    if (route !== location.href) {
      closeDialog();
      errorTracker.reset();
      acknowledgedAssistantAlerts.clear();
      systemBaselineReady = false;
      observedSystemText = new WeakMap();
      recentlyChangedSystemNodes.clear();
      completionInitialized = false;
      completionCandidate = null;
      completionNotified.clear();
      completionBaselineToken = null;
      missingMarkerCandidate = null;
      missingMarkerNotified.clear();
      route = location.href;
      lastClaimedAssistantOrdinal = 0;
      cancelCooldownWake();
      hydrateCooldown();
      seenInitial = false;
      lastKey = "";
      handled = new Set();
      cancelPending();
    }
    checkReplyCompletion();
    if (config.mode !== "continue" && checkError()) {
      // An explicit transport failure outranks the optional missing-marker
      // heuristic. Never alert twice for the same incomplete reply.
      const latest = latestAssistant(currentSelectors().assistant);
      if (latest.node) missingMarkerNotified.add(completionTurnKey(latest));
      cancelPending();
      return;
    }
    checkMissingMarker();
    if (config.mode === "errors") {
      cancelPending();
      return;
    }
    // Global lock is checked BEFORE inspecting the completion marker, so no
    // new timers, editor fills or Send attempts can start during cooldown.
    if (!cooldownHydrated || cooldownRemainingMs()) {
      if (cooldownHydrated) armCooldownWake();
      cancelPending();
      return;
    }
    cancelCooldownWake();
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
      // A changing response is still streaming; earlier Stop encounters
      // must not exhaust the budget before generation completes.
      const turnToken = sendToken(result.node, text, result.count);
      attemptsByAssistant.delete(turnToken);
      exhaustedAssistantTokens.delete(turnToken);
      cancelPending();
    }
    if (!seenInitial) {
      seenInitial = true;
      if (Core.completionMatches(text, config.marker, config.markerRegex)) handled.add(key);
      return;
    }
    if (handled.has(key) || sending ||
      ordinalAlreadyHandled(result.ordinal, sendToken(result.node, text, result.count)) ||
      submittedAssistantTokens.has(sendToken(result.node, text, result.count)) ||
      !Core.completionMatches(text, config.marker, config.markerRegex) ||
      sendGuard.alreadySent(text, sendGuardTurn(result))) return;
    const assistantToken = sendToken(result.node, text, result.count);
    if ((attemptsByAssistant.get(assistantToken) || 0) >= 5) {
      if (!exhaustedAssistantTokens.has(assistantToken)) {
        exhaustedAssistantTokens.add(assistantToken);
        autoDecision("Лимит 5/5 попыток отправки: текущий ответ пропущен; монитор активен");
      }
      return;
    }
    if (Date.now() - stableSince < (config.marker ? 1500 : 4500)) return;
    if (hasStopButton(selectors.stop) && Date.now() - stableSince < 5000) {
      recordEvent("blocked", "Ожидание: видна кнопка Stop");
      return;
    }
    // A persistent Stop button with no text changes for long enough now
    // gets one scheduled blocked attempt. We never click Stop.
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
        sendGuard.alreadySent(textOf(lastAssistant), sendGuardTurn(latestAssistant(selectors.assistant))),
      logicalUserTurnDetected: !!latestUserTurn().logicalTurn,
      sendClicks,
      rememberedAssistantReplies: submittedAssistantTokens.size,
      lastClaimRejectReason, lastClaimRejectOrdinal,
      assistantOrdinal: latestAssistant(selectors.assistant).ordinal,
      lastClaimedAssistantOrdinal,
      cooldownRemainingSeconds: Math.ceil(cooldownRemainingMs() / 1000),
      cooldownHydrated, globalLockedUntil,
      sending,
      toastEnabled: config.toastEnabled,
      editorFound: !!editor,
      editorEmpty: !!editor && !editorText(editor),
      editorElement: editor ? (editor.id || editor.tagName.toLowerCase()) : null,
      editorCandidates: query(selectors.editor).filter((element) => visible(element) &&
        (element.isContentEditable || /^(TEXTAREA|INPUT)$/.test(element.tagName))).length,
      editorRenderedLength: editor ? editorText(editor).length : 0,
      editorHiddenDomText: !!(editor && editor.isContentEditable &&
        typeof editor.innerText === "string" && !editor.innerText.trim() &&
        (editor.textContent || "").trim()),
      sendButtonFound: !!findSendButton(selectors.send),
      stopButtonVisible: hasStopButton(selectors.stop),
      pending: !!pending,
      monitorCheckCount,
      healthWakeCount, lastHealthWakeAt,
      lastMonitorCheckAt,
      monitorCheckAgeSeconds: lastMonitorCheckAt ?
        Math.floor((Date.now() - lastMonitorCheckAt) / 1000) : null,
      cooldownWakeAt,
      cooldownWakeCount,
      seenInitial,
      completionNotifications,
      missingMarkerError: config.missingMarkerError,
      missingMarkerAlerts: missingMarkerNotified.size,
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
    if (message && message.type === "WATCHDOG_HEALTH") {
      healthWakeCount++;
      lastHealthWakeAt = Date.now();
      if (config.enabled) {
        if (!cooldownHydrated && config.mode !== "errors") hydrateCooldown();
        scheduleCheck();
      }
      sendResponse({ ok: true, enabled: config.enabled, monitorCheckCount });
      return false;
    }
    if (message && message.type === "WATCHDOG_DIAGNOSE") {
      sendResponse(diagnosticSnapshot());
      return false;
    }
    if (!message || message.type !== "WATCHDOG_CONFIG") return false;
    const wasEnabled = config.enabled;
    const previousMode = config.mode;
    configRevision++;
    config = Core.normalize({ ...message.config,
      ...(sharedErrorWords !== null ? { errorWords: sharedErrorWords, errorWordsVersion: 3 } : {}) });
    if (previousMode !== "continue" && config.mode === "continue") {
      errorTracker.reset();
      closeDialog();
    }
    if (previousMode !== config.mode) {
      modeEpoch++;
      cancelPending();
      cancelCooldownWake();
      if (config.enabled) recordEvent("mode", config.mode === "errors" ?
        "Режим: только ошибки — автоотправка отключена" :
        "Режим: автопродолжение и ошибки");
      // Returning to auto mode must not replay an already completed reply.
      if (config.mode !== "errors") {
        hydrateCooldown();
        seenInitial = false;
        lastKey = "";
        handled = new Set();
      }
    }
    if (!config.enabled) {
      cancelCooldownWake();
      cooldownHydrated = false;
      hydrationEpoch++;
      cancelPending();
      errorTracker.reset();
      closeDialog();
    }
    if (!wasEnabled && config.enabled) {
      systemBaselineReady = false;
      observedSystemText = new WeakMap();
      recentlyChangedSystemNodes.clear();
      hydrateCooldown();
      route = location.href;
      seenInitial = false;
      handled = new Set();
      errorTracker.reset();
    }
    scheduleCheck();
  });

  const startupConfigRevision = configRevision;
  chrome.runtime.sendMessage({ type: "GET_CONFIG" }).then((saved) => {
    if (configRevision !== startupConfigRevision) return;
    config = Core.normalize({ ...saved,
      ...(sharedErrorWords !== null ? { errorWords: sharedErrorWords, errorWordsVersion: 3 } : {}) });
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

  function rememberSystemMutation(node) {
    const element = node && (node.nodeType === 3 ? node.parentNode : node);
    if (!element || isWatchdogUi(element)) return;
    recentlyChangedSystemNodes.add(element);
    if (typeof element.querySelectorAll === "function") {
      for (const child of Array.from(element.querySelectorAll(SYSTEM_CANDIDATE_SELECTOR)).slice(-100))
        recentlyChangedSystemNodes.add(child);
    }
    if (recentlyChangedSystemNodes.size > 400)
      for (const old of Array.from(recentlyChangedSystemNodes).slice(0, 200))
        recentlyChangedSystemNodes.delete(old);
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
          for (const node of added) rememberSystemMutation(node);
          for (const node of removed) errorTracker.forgetSubtree(node);
          // The tracker only re-arms an error if a mutation happens INSIDE
          // the actual error node, never merely somewhere inside the page.
          if (textRemoved || textAdded) errorTracker.markUpdated(record.target);
        } else if (record.type === "characterData") {
          rememberSystemMutation(record.target);
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
  // Browser timers can be throttled when the tab is not foregrounded. As
  // soon as Chrome resumes the page, scan without waiting for user typing.
  function resumeObservation() {
    if (config.enabled) scheduleCheck();
  }
  if (typeof document.addEventListener === "function")
    document.addEventListener("visibilitychange", resumeObservation);
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", resumeObservation);
    window.addEventListener("pageshow", resumeObservation);
  }
})();
