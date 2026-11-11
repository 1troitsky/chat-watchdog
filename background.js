"use strict";

importScripts("audio-db.js");

const key = (tabId) => "tab:" + tabId;
const audioEpochs = new Map();
const completionQueues = new Map();
const sendClaimQueues = new Map();
// Scope to the conversation, not the tab: the same chat can be open twice.
const conversationKey = url => {
  const parsed = new URL(url);
  return "watchdog:conversation:" + parsed.origin + parsed.pathname;
};
let creatingOffscreen;

function nextAudioEpoch(tabId, kind = "error") {
  const channel = tabId + ":" + kind;
  const epoch = (audioEpochs.get(channel) || 0) + 1;
  audioEpochs.set(channel, epoch);
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
      Number(config.cooldownSeconds) || 30)) * 1000;
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
    await chrome.storage.session.set({
      [scope]: {
        origin: config.origin, tokens: [...seen.slice(-499), token],
        lastClaimAt: now, lockedUntil: now + minIntervalMs,
        maxAssistantOrdinal: assistantOrdinal
      }
    });
    return { ok: true, lockedUntil: now + minIntervalMs };
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
      justification: "Play user-selected error and completed-reply notification sounds."
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function stopTabAudio(tabId, kind = null) {
  if (kind) nextAudioEpoch(tabId, kind);
  else { nextAudioEpoch(tabId, "error"); nextAudioEpoch(tabId, "completion"); }
  if (await offscreenExists()) {
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP", tabId, kind });
  }
}

async function playTabAudio(tabId, sender, kind = "error") {
  const epoch = nextAudioEpoch(tabId, kind);
  const items = await chrome.storage.session.get(key(tabId));
  const config = items[key(tabId)];
  if (!config || !config.enabled ||
      !(kind === "completion" ? config.completionAudioName : config.audioName) ||
      (kind === "error" && config.mode === "continue")) return;
  if (!sender.tab?.url || new URL(sender.tab.url).origin !== config.origin) return;
  await ensureOffscreen();
  if (audioEpochs.get(tabId + ":" + kind) !== epoch) return;
  const result = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PLAY", tabId, kind });
  if (!result?.ok && !result?.cancelled) {
    console.warn("Chat Watchdog audio:", result?.error || "playback failed");
  }
}

// Serialize completion claims so two observers or a worker restart cannot
// replay the same answer. Persist only a bounded set of opaque turn IDs.
async function playCompletionOnce(tabId, sender, token) {
  if (typeof token !== "string" || !token || token.length > 2048)
    return { ok: false, reason: "invalid-token" };
  if (!sender.tab?.url) return { ok: false, reason: "missing-url" };
  const page = new URL(sender.tab.url);
  const sessionKey = "watchdog:completed:" + tabId + ":" + page.origin + page.pathname;
  const prior = completionQueues.get(sessionKey) || Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const values = await chrome.storage.session.get([key(tabId), sessionKey]);
    const config = values[key(tabId)];
    if (!config?.enabled || config.origin !== page.origin)
      return { ok: false, reason: "inactive" };
    const known = Array.isArray(values[sessionKey]) ? values[sessionKey] : [];
    if (known.includes(token)) return { ok: false, reason: "duplicate" };
    await chrome.storage.session.set({ [sessionKey]: [...known.slice(-199), token] });
    if (config.completionAudioName) await playTabAudio(tabId, sender, "completion");
    return { ok: true };
  });
  completionQueues.set(sessionKey, task);
  try { return await task; }
  finally { if (completionQueues.get(sessionKey) === task) completionQueues.delete(sessionKey); }
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
              Number(config.cooldownSeconds) || 30)) * 1000 : 0)) : 0;
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
  if (message.type === "PLAY_COMPLETION") {
    playCompletionOnce(tabId, sender, message.token)
      .then(sendResponse).catch(error => sendResponse({ ok: false, reason: String(error) }));
    return true;
  }
  if (message.type === "PLAY_ERROR") {
    playTabAudio(tabId, sender).catch(console.warn);
    return false;
  }
  if (message.type === "STOP_ERROR") {
    stopTabAudio(tabId, "error").catch(console.warn);
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
  ChatWatchdogAudio.remove(tabId, "completion").catch(() => {});
  audioEpochs.delete(tabId + ":error");
  audioEpochs.delete(tabId + ":completion");
});
