"use strict";

// Completion and error sounds use independent players. A completion plays
// only once; an error continues to use the original repeat-on-new-error flow.
const players = new Map();
const revisions = new Map();
const channelKey = (tabId, kind = "error") => tabId + ":" + kind;

function nextRevision(key) {
  const revision = (revisions.get(key) || 0) + 1;
  revisions.set(key, revision);
  return revision;
}

function releasePlayer(key) {
  const player = players.get(key);
  if (!player) return;
  players.delete(key);
  player.audio.pause();
  player.audio.removeAttribute("src");
  player.audio.load();
  URL.revokeObjectURL(player.url);
}

async function playForTab(tabId, kind = "error") {
  const key = channelKey(tabId, kind);
  const revision = nextRevision(key);
  const file = await ChatWatchdogAudio.get(tabId, kind);
  if (revisions.get(key) !== revision) return { ok: false, cancelled: true };
  if (!file) return { ok: false, error: "No audio file selected" };

  releasePlayer(key);
  const url = URL.createObjectURL(file);
  const audio = new Audio(url);
  audio.loop = false;
  players.set(key, { audio, url });
  audio.addEventListener("ended", () => {
    if (players.get(key)?.audio === audio) releasePlayer(key);
  }, { once: true });
  try {
    await audio.play();
    if (revisions.get(key) !== revision) return { ok: false, cancelled: true };
    return { ok: true };
  } catch (error) {
    if (players.get(key)?.audio === audio) releasePlayer(key);
    return { ok: false, error: String(error) };
  }
}

function stopForTab(tabId, kind) {
  for (const channel of kind ? [kind] : ["error", "completion"]) {
    const key = channelKey(tabId, channel);
    nextRevision(key);
    releasePlayer(key);
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !Number.isInteger(message.tabId)) return false;
  const kind = message.kind === "completion" ? "completion" : "error";
  if (message.type === "OFFSCREEN_STOP") {
    sendResponse(stopForTab(message.tabId, message.kind ? kind : null));
    return false;
  }
  if (message.type === "OFFSCREEN_PLAY") {
    playForTab(message.tabId, kind).then(sendResponse).catch((error) =>
      sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
