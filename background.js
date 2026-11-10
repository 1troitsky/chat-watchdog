"use strict";

importScripts("audio-db.js");

const key = (tabId) => "tab:" + tabId;
const lastAlarm = new Map();
let creatingOffscreen;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play a user-selected alert sound when a chat shows an error."
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab || !Number.isInteger(sender.tab.id)) return false;
  const tabId = sender.tab.id;
  if (message && message.type === "GET_CONFIG") {
    chrome.storage.session.get(key(tabId))
      .then((items) => sendResponse(items[key(tabId)] || null))
      .catch(() => sendResponse(null));
    return true;
  }
  if (message && message.type === "PLAY_ERROR") {
    (async () => {
      const items = await chrome.storage.session.get(key(tabId));
      const config = items[key(tabId)];
      if (!config || !config.enabled || !config.audioName) return;
      if (new URL(sender.tab.url).origin !== config.origin) return;
      const now = Date.now();
      if (now - (lastAlarm.get(tabId) || 0) < 60000) return;
      lastAlarm.set(tabId, now);
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ type: "OFFSCREEN_PLAY", tabId });
    })().catch((error) => console.warn("Chat Watchdog audio:", error));
    return false;
  }
  return false;
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  try {
    const items = await chrome.storage.session.get(key(tabId));
    const config = items[key(tabId)];
    if (!config || !config.enabled) return;
    if (new URL(tab.url).origin !== config.origin) {
      await chrome.storage.session.set({ [key(tabId)]: Object.assign({}, config, { enabled: false }) });
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
  chrome.storage.session.remove(key(tabId)).catch(() => {});
  ChatWatchdogAudio.remove(tabId).catch(() => {});
  lastAlarm.delete(tabId);
});
