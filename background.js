"use strict";

importScripts("audio-db.js");

const key = (tabId) => "tab:" + tabId;
const audioEpochs = new Map();
let creatingOffscreen;

function nextAudioEpoch(tabId) {
  const epoch = (audioEpochs.get(tabId) || 0) + 1;
  audioEpochs.set(tabId, epoch);
  return epoch;
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
  chrome.storage.session.remove(key(tabId)).catch(() => {});
  ChatWatchdogAudio.remove(tabId).catch(() => {});
  audioEpochs.delete(tabId);
});
