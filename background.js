"use strict";

importScripts("audio-db.js");

const key = (tabId) => "tab:" + tabId;
const audioEpochs = new Map();
const sendClaimQueues = new Map();
const SEND_PROTOCOL_VERSION = 3;
const armKeyFor = scope => "watchdog:armed:" + scope;

// Every arm, cancellation and claim for a conversation is serialized. The
// service worker owns the clock; an injected script must never authorize its
// own delay or claim without having been armed.
async function serializeConversation(scope, task) {
  const previous = sendClaimQueues.get(scope) || Promise.resolve();
  const work = previous.catch(() => {}).then(task);
  sendClaimQueues.set(scope, work);
  try { return await work; }
  finally { if (sendClaimQueues.get(scope) === work) sendClaimQueues.delete(scope); }
}
const auditKey = "watchdog:send-audit";
let auditQueue = Promise.resolve();

// Every claim (accepted or rejected), and every click reported by a content
// script, is audited across all tabs. Only metadata is stored: never message
// text, send tokens, full conversation identifiers or chat contents.
function auditSend({ tabId, url, event, outcome, ordinal, mode }) {
  let origin = "", conversationHint = "";
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    conversationHint = parsed.pathname.slice(-6);
  } catch {}
  const entry = {
    at: Date.now(), tabId, origin, conversationHint,
    event, outcome, mode: mode || "unknown",
    ordinal: Number.isSafeInteger(ordinal) ? ordinal : null
  };
  const operation = auditQueue.catch(() => {}).then(async () => {
    const items = await chrome.storage.session.get(auditKey);
    const prior = Array.isArray(items[auditKey]) ? items[auditKey] : [];
    await chrome.storage.session.set({ [auditKey]: [...prior.slice(-99), entry] });
  });
  auditQueue = operation;
  return operation;
}
// Scope to the conversation, not the tab: the same chat can be open twice.
const conversationKey = url => {
  const parsed = new URL(url);
  return "watchdog:conversation:" + parsed.origin + parsed.pathname;
};
let creatingOffscreen;

function nextAudioEpoch(tabId) {
  const epoch = (audioEpochs.get(tabId) || 0) + 1;
  audioEpochs.set(tabId, epoch);
  return epoch;
}

// The background—not the DOM observer—decides when a reply becomes eligible.
// A legacy/unarmed content script has no capability to request a Send claim.
async function armSend(tabId, token, assistantOrdinal, sender) {
  if (typeof token !== "string" || !token || token.length > 2048 ||
      !Number.isSafeInteger(assistantOrdinal) ||
      assistantOrdinal < 1 || assistantOrdinal > 1000000) {
    return { ok: false, reason: "invalid-arm" };
  }
  if (!sender.tab?.url) return { ok: false, reason: "missing-url" };
  let scope;
  try { scope = conversationKey(sender.tab.url); }
  catch { return { ok: false, reason: "invalid-url" }; }
  return serializeConversation(scope, async () => {
    const armedKey = armKeyFor(scope);
    const items = await chrome.storage.session.get([key(tabId), scope, armedKey]);
    const config = items[key(tabId)];
    if (!config || config.enabled !== true || config.mode !== "auto" ||
        new URL(sender.tab.url).origin !== config.origin)
      return { ok: false, reason: "inactive" };
    const prior = items[scope];
    if (prior?.tokens?.includes(token))
      return { ok: false, reason: "duplicate" };
    if (Number.isSafeInteger(prior?.maxAssistantOrdinal) &&
        assistantOrdinal <= prior.maxAssistantOrdinal)
      return { ok: false, reason: "assistant-already-handled" };
    const now = Date.now();
    if (Number.isFinite(prior?.lockedUntil) && now < prior.lockedUntil)
      return { ok: false, reason: "cooldown", lockedUntil: prior.lockedUntil };
    const existing = items[armedKey];
    if (existing && now < existing.dueAt + 120000)
      return { ok: false, reason: "already-armed" };
    const delay = Math.max(1, Math.min(600,
      Number(config.delaySeconds) || 30)) * 1000;
    const dueAt = now + delay;
    const armId = crypto.randomUUID();
    await chrome.storage.session.set({
      [armedKey]: { armId, token, assistantOrdinal, tabId, dueAt,
        origin: config.origin, protocol: SEND_PROTOCOL_VERSION }
    });
    return { ok: true, armId, dueAt, protocol: SEND_PROTOCOL_VERSION };
  });
}

async function cancelArm(tabId, armId, sender) {
  if (typeof armId !== "string" || !armId || !sender.tab?.url)
    return { ok: false };
  let scope;
  try { scope = conversationKey(sender.tab.url); }
  catch { return { ok: false }; }
  return serializeConversation(scope, async () => {
    const armedKey = armKeyFor(scope);
    const items = await chrome.storage.session.get(armedKey);
    if (items[armedKey]?.armId !== armId ||
        items[armedKey]?.tabId !== tabId) return { ok: false };
    await chrome.storage.session.remove(armedKey);
    return { ok: true };
  });
}

async function invalidateArmForUserTurn(sender) {
  if (!sender.tab?.url) return;
  let scope;
  try { scope = conversationKey(sender.tab.url); }
  catch { return; }
  await serializeConversation(scope, async () => {
    const armedKey = armKeyFor(scope);
    const items = await chrome.storage.session.get(armedKey);
    if (items[armedKey]) await chrome.storage.session.remove(armedKey);
  });
}

// Atomic per-conversation claims across tabs and re-injected scripts.
async function claimSend(tabId, token, assistantOrdinal, armId, sender) {
  if (typeof token !== "string" || !token || token.length > 2048 ||
      !Number.isSafeInteger(assistantOrdinal) ||
      assistantOrdinal < 1 || assistantOrdinal > 1000000) {
    return { ok: false, reason: "invalid-claim" };
  }
  if (!sender.tab?.url) return { ok: false, reason: "missing-url" };
  let scope;
  try { scope = conversationKey(sender.tab.url); }
  catch { return { ok: false, reason: "invalid-url" }; }
  return serializeConversation(scope, async () => {
    const armedKey = armKeyFor(scope);
    const keys = [key(tabId), scope, armedKey];
    const items = await chrome.storage.session.get(keys);
    const config = items[key(tabId)];
    if (!config || config.enabled !== true || config.mode !== "auto" ||
        !sender.tab?.url || new URL(sender.tab.url).origin !== config.origin) {
      return { ok: false, reason: "inactive" };
    }
    const prior = items[scope];
    const seen = prior && prior.origin === config.origin && Array.isArray(prior.tokens) ?
      prior.tokens : [];
    if (seen.includes(token)) return { ok: false, reason: "duplicate" };
    // A replaced DOM turn ID cannot re-open an already processed reply.
    if (prior && prior.origin === config.origin &&
        Number.isSafeInteger(prior.maxAssistantOrdinal) &&
        assistantOrdinal <= prior.maxAssistantOrdinal) {
      return { ok: false, reason: "assistant-already-handled",
        lastOrdinal: prior.maxAssistantOrdinal };
    }
    const now = Date.now();
    const minIntervalMs = Math.max(10, Math.min(3600,
      Number(config.cooldownSeconds) || 45)) * 1000;
    // A shared cooldown across ALL content scripts in this tab. An old reply
    // whose dedupe token unexpectedly changes still cannot cause rapid sends.
    if (prior && prior.origin === config.origin &&
        Number.isFinite(prior.lockedUntil || prior.lastClaimAt)) {
      // Persist the absolute deadline and never shorten it because of a
      // later settings change. Old ledgers used lastClaimAt only.
      const lockedUntil = Number.isFinite(prior.lockedUntil) ? prior.lockedUntil :
        prior.lastClaimAt + minIntervalMs;
      if (now < lockedUntil) {
        return { ok: false, reason: "cooldown", lockedUntil,
          retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000) };
      }
    }
    // Reject all old scripts, even ones that ask for a claim at the correct
    // time: a matching, unexpired, background-created arm is mandatory.
    const armed = items[armedKey];
    if (!armed || armed.protocol !== SEND_PROTOCOL_VERSION ||
        typeof armId !== "string" || armId !== armed.armId ||
        armed.tabId !== tabId || armed.token !== token ||
        armed.assistantOrdinal !== assistantOrdinal ||
        armed.origin !== config.origin)
      return { ok: false, reason: "unarmed" };
    if (now < armed.dueAt)
      return { ok: false, reason: "too-early",
        retryAfterSeconds: Math.ceil((armed.dueAt - now) / 1000) };
    if (now > armed.dueAt + 120000)
      return { ok: false, reason: "expired-arm" };
    await chrome.storage.session.set({
      [scope]: {
        origin: config.origin, tokens: [...seen.slice(-499), token],
        lastClaimAt: now, lockedUntil: now + minIntervalMs,
        maxAssistantOrdinal: assistantOrdinal
      }
    });
    await chrome.storage.session.remove(armedKey);
    return { ok: true, lockedUntil: now + minIntervalMs };
  });
}

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play a user-selected alert sound when a chat shows an error."
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function stopTabAudio(tabId) {
  nextAudioEpoch(tabId);
  if (await offscreenExists()) {
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP", tabId });
  }
}

async function playTabAudio(tabId, sender) {
  const epoch = nextAudioEpoch(tabId);
  const items = await chrome.storage.session.get(key(tabId));
  const config = items[key(tabId)];
  if (!config || !config.enabled || !config.audioName) return;
  if (!sender.tab?.url || new URL(sender.tab.url).origin !== config.origin) return;
  await ensureOffscreen();
  if (audioEpochs.get(tabId) !== epoch) return;
  const result = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PLAY", tabId });
  if (!result?.ok && !result?.cancelled) {
    console.warn("Chat Watchdog audio:", result?.error || "playback failed");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  // The popup sends this when switching OFF, even when the content script is unavailable.
  if (message.type === "STOP_TAB_AUDIO" &&
      sender.id === chrome.runtime.id && !sender.tab &&
      Number.isInteger(message.tabId)) {
    stopTabAudio(message.tabId).catch(console.warn);
    return false;
  }
  if (!sender.tab || !Number.isInteger(sender.tab.id)) return false;
  const tabId = sender.tab.id;
  if (message.type === "ARM_SEND") {
    armSend(tabId, message.token, message.assistantOrdinal, sender)
      .then(async result => {
        const conf = await chrome.storage.session.get(key(tabId));
        await auditSend({
          tabId, url: sender.tab.url, event: "arm",
          outcome: result.ok ? "armed" : result.reason,
          ordinal: message.assistantOrdinal,
          mode: conf[key(tabId)]?.enabled ? conf[key(tabId)].mode : "OFF"
        }).catch(() => {});
        sendResponse(result);
      })
      .catch(() => sendResponse({ ok: false, reason: "storage-error" }));
    return true;
  }
  if (message.type === "CANCEL_ARM") {
    cancelArm(tabId, message.armId, sender)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === "CLAIM_SEND") {
    claimSend(tabId, message.token, message.assistantOrdinal, message.armId, sender)
      .then(async result => {
        const conf = await chrome.storage.session.get(key(tabId));
        await auditSend({
          tabId, url: sender.tab.url, event: "claim",
          outcome: result.ok ? "allowed" : result.reason,
          ordinal: message.assistantOrdinal,
          mode: conf[key(tabId)]?.enabled ?
            conf[key(tabId)].mode : "OFF"
        }).catch(() => {});
        sendResponse(result);
      })
      .catch(() => sendResponse({ ok: false, reason: "storage-error" }));
    return true;
  }
  if (message.type === "WATCHDOG_USER_TURN") {
    invalidateArmForUserTurn(sender).then(() =>
      chrome.storage.session.get(key(tabId)))
      .then(items => {
        const config = items[key(tabId)];
        if (!config?.enabled || !sender.tab?.url ||
            new URL(sender.tab.url).origin !== config.origin) return;
        const source = typeof message.observation === "string" &&
          /^(input|enter|send-click|send-pointer|submit):(trusted|synthetic)$|^no-recent-composer-event$/.test(message.observation) ?
          message.observation : "unknown";
        return auditSend({
          tabId, url: sender.tab.url, event: "user-turn",
          outcome: source, mode: config.mode
        });
      })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === "WATCHDOG_SEND_CLICKED") {
    chrome.storage.session.get(key(tabId))
      .then(items => auditSend({
        tabId, url: sender.tab.url, event: "click-called",
        outcome: "content-script-reported",
        ordinal: message.assistantOrdinal,
        mode: items[key(tabId)]?.enabled ?
          items[key(tabId)].mode : "OFF"
      }))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === "GET_SEND_STATE") {
    const scope = (() => {
      try { return conversationKey(sender.tab.url); }
      catch { return null; }
    })();
    if (!scope) {
      sendResponse({ ok: false, lockedUntil: 0 });
      return false;
    }
    chrome.storage.session.get([key(tabId), scope])
      .then(items => {
        const config = items[key(tabId)];
        const ledger = items[scope];
        if (!config || config.origin !== new URL(sender.tab.url).origin) {
          sendResponse({ ok: false, lockedUntil: 0 });
          return;
        }
        const until = ledger && ledger.origin === config.origin ?
          (Number.isFinite(ledger.lockedUntil) ? ledger.lockedUntil :
          (Number.isFinite(ledger.lastClaimAt) ?
            ledger.lastClaimAt + Math.max(10, Math.min(3600,
              Number(config.cooldownSeconds) || 45)) * 1000 : 0)) : 0;
        sendResponse({ ok: true, lockedUntil: until,
          lastOrdinal: ledger && ledger.origin === config.origin ?
            ledger.maxAssistantOrdinal || 0 : 0 });
      })
      .catch(() => sendResponse({ ok: false, lockedUntil: 0 }));
    return true;
  }
  if (message.type === "GET_CONFIG") {
    chrome.storage.session.get(key(tabId))
      .then((items) => sendResponse(items[key(tabId)] || null))
      .catch(() => sendResponse(null));
    return true;
  }
  if (message.type === "PLAY_ERROR") {
    playTabAudio(tabId, sender).catch(console.warn);
    return false;
  }
  if (message.type === "STOP_ERROR") {
    stopTabAudio(tabId).catch(console.warn);
    return false;
  }
  return false;
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === "loading") {
    stopTabAudio(tabId).catch(console.warn);
    return;
  }
  if (info.status !== "complete" || !tab.url) return;
  try {
    const items = await chrome.storage.session.get(key(tabId));
    const config = items[key(tabId)];
    if (!config || !config.enabled) return;
    if (new URL(tab.url).origin !== config.origin) {
      await chrome.storage.session.set({
        [key(tabId)]: Object.assign({}, config, { enabled: false })
      });
      await stopTabAudio(tabId);
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId }, files: ["core.js", "content.js"]
    });
  } catch (error) {
    console.warn("Chat Watchdog injection:", error);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopTabAudio(tabId).catch(() => {});
  // Keep the shared conversation ledger while another tab may be open.
  chrome.storage.session.remove(key(tabId)).catch(() => {});
  ChatWatchdogAudio.remove(tabId).catch(() => {});
  audioEpochs.delete(tabId);
});
