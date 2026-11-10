"use strict";
let sound = null;
let objectUrl = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "OFFSCREEN_PLAY") return false;
  (async () => {
    const audioFile = await ChatWatchdogAudio.get(message.tabId);
    if (!audioFile) {
      sendResponse({ ok: false, error: "No audio file selected" });
      return;
    }
    if (sound) {
      sound.pause();
      sound = null;
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(audioFile);
    sound = new Audio(objectUrl);
    sound.onended = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      sound = null;
    };
    await sound.play();
    sendResponse({ ok: true });
  })().catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
