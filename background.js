"use strict";

importScripts("audio-db.js");

const key = (tabId) => "tab:" + tabId;
const audioEpochs = new Map();
const sendClaimQueues = new Map();
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

// Atomic per-tab claims across all injected scripts. The ledger survives
// service-worker suspension and content-script reinjection during this session.
async function claimSend(tabId, token, assistantOrdinal, sender) {
  if (typeof token !== "string" || !token || token.length > 2048 ||
      !Number.isSafeInteger(assistantOrdinal) ||
      assistantOrdinal < 1 || assistantOrdinal > 1000000) {
    return { ok: false, reason: "invalid-claim" };
  }
  if (!sender.tab?.url) return { ok: false, reason: "missing-url" };
  let scope;
  try { scope = conversationKey(sender.tab.url); }
  catch { return { ok: false, reason: "invalid-url" }; }
  const previous = sendClaimQueues.get(scope) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    const keys = [key(tabId), scope];
    const items = await chrome.storage.session.get(keys);
    const config = items[key(tabId)];
    if (!config || config.enabled !== true || config.mode === "errors" ||
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
        Number.isFinite(prior.lastClaimAt)) {
      const elapsed = now - prior.lastClaimAt;
      if (elapsed < minIntervalMs) {
        return { ok: false, reason: "cooldown",
          retryAfterSeconds: Math.ceil((minIntervalMs - elapsed) / 1000) };
      }
    }
    await chrome.storage.session.set({
      [scope]: {
        origin: config.origin, tokens: [...seen.slice(-499), token],
        lastClaimAt: now, maxAssistantOrdinal: assistantOrdinal
      }
    });
    return { ok: true };
  });
  sendClaimQueues.set(scope, work);
  try { return await work; }
  finally { if (sendClaimQueues.get(scope) === work) sendClaimQueues.delete(scope); }
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
  if (message.type === "CLAIM_SEND") {
    claimSend(tabId, message.token, message.assistantOrdinal, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, reason: "storage-error" }));
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
