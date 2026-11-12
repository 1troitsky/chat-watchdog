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
  if (player.objectUrl) URL.revokeObjectURL(player.objectUrl);
}

async function playForTab(tabId, kind = "error") {
  const key = channelKey(tabId, kind);
  const revision = nextRevision(key);
  // Existing per-tab audio in IndexedDB wins. Fresh installations and tabs
  // automatically use the files bundled with this Chrome extension instead.
  const file = await ChatWatchdogAudio.get(tabId, kind).catch(() => null);
  if (revisions.get(key) !== revision) return { ok: false, cancelled: true };

  releasePlayer(key);
  let objectUrl = null;
  let src;
  let source = "custom";
  if (file) {
    objectUrl = URL.createObjectURL(file);
    src = objectUrl;
  } else {
    // Chrome has behaved differently for URL-backed MP3 and uploaded Blob
    // audio on some installations. Load bundled audio as a Blob too, using
    // the same path as the working user-selected override.
    const resource = kind === "completion" ? "sounds/sfx-16.mp3" : "sounds/01507.mp3";
    const url = chrome.runtime.getURL(resource);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Bundled audio HTTP " + response.status);
      const blob = await response.blob();
      if (!blob.size) throw new Error("Bundled audio is empty: " + resource);
      objectUrl = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "audio/mpeg" }));
      src = objectUrl;
      source = "bundled-blob";
    } catch (error) {
      // Missing fetch permission/API or an unavailable bundle: try direct URL
      // as last resort. If playback fails, report it back to the content log.
      src = url;
      source = "bundled-url-fallback";
    }
  }
  if (revisions.get(key) !== revision) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return { ok: false, cancelled: true };
  }
  const audio = new Audio(src);
  audio.loop = false;
  players.set(key, { audio, objectUrl });
  audio.addEventListener("ended", () => {
    if (players.get(key)?.audio === audio) releasePlayer(key);
  }, { once: true });
  try {
    await audio.play();
    if (revisions.get(key) !== revision) return { ok: false, cancelled: true };
    return { ok: true, source };
  } catch (error) {
    if (players.get(key)?.audio === audio) releasePlayer(key);
    return { ok: false, source, error: String(error) };
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
