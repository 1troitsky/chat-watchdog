"use strict";

// One independent player per monitored tab; STOP also cancels pending file loads.
const players = new Map();
const revisions = new Map();

function nextRevision(tabId) {
  const value = (revisions.get(tabId) || 0) + 1;
  revisions.set(tabId, value);
  return value;
}

function releasePlayer(tabId) {
  const player = players.get(tabId);
  if (!player) return;
  players.delete(tabId);
  player.audio.pause();
  player.audio.removeAttribute("src");
  player.audio.load();
  URL.revokeObjectURL(player.url);
}

async function playForTab(tabId) {
  const revision = nextRevision(tabId);
  const file = await ChatWatchdogAudio.get(tabId);
  if (revisions.get(tabId) !== revision) return { ok: false, cancelled: true };
  if (!file) return { ok: false, error: "No audio file selected" };

  releasePlayer(tabId);
  const url = URL.createObjectURL(file);
  const audio = new Audio(url);
  players.set(tabId, { audio, url });
  audio.addEventListener("ended", () => {
    if (players.get(tabId)?.audio === audio) releasePlayer(tabId);
  }, { once: true });
  try {
    await audio.play();
    if (revisions.get(tabId) !== revision) return { ok: false, cancelled: true };
    return { ok: true };
  } catch (error) {
    if (players.get(tabId)?.audio === audio) releasePlayer(tabId);
    return { ok: false, error: String(error) };
  }
}

function stopForTab(tabId) {
  nextRevision(tabId);
  releasePlayer(tabId);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !Number.isInteger(message.tabId)) return false;
  if (message.type === "OFFSCREEN_STOP") {
    sendResponse(stopForTab(message.tabId));
    return false;
  }
  if (message.type === "OFFSCREEN_PLAY") {
    playForTab(message.tabId).then(sendResponse).catch((error) =>
      sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
