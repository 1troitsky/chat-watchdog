"use strict";

importScripts("audio-db.js");

const key = (tabId) => "tab:" + tabId;
const audioEpochs = new Map();
const completionQueues = new Map();
const sendClaimQueues = new Map();
// Serialized, tab-wide ownership of the error modal. A DOM ID alone cannot
// arbitrate between independent extension content-script contexts/frames.
const dialogClaimQueues = new Map();
const dialogLeaseKey = tabId => "watchdog:error-modal:" + tabId;
let nextDialogLease = 0;

async function withDialogLock(tabId, task) {
  const prev = dialogClaimQueues.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  dialogClaimQueues.set(tabId, next);
  try { return await next; }
  finally { if (dialogClaimQueues.get(tabId) === next) dialogClaimQueues.delete(tabId); }
}

async function claimErrorDialog(tabId, sender, incidentKey) {
  if (typeof incidentKey !== "string" || !incidentKey || incidentKey.length > 2048 ||
      !sender.tab?.url) return { ok: false, reason: "invalid-dialog-claim" };
  return withDialogLock(tabId, async () => {
    const leaseKey = dialogLeaseKey(tabId);
    const state = await chrome.storage.session.get([key(tabId), leaseKey]);
    const config = state[key(tabId)];
    if (!config?.enabled || config.mode === "continue" ||
        new URL(sender.tab.url).origin !== config.origin)
      return { ok: false, reason: "dialog-monitor-inactive" };
    const old = state[leaseKey];
    // Do NOT expire an open modal on a timer: a user may leave it visible
    // for longer than ten minutes. Ownership ends only on close/reload.
    if (old && old.origin === config.origin)
      return { ok: false, reason: "dialog-already-open" };
    const leaseId = tabId + ":" + Date.now() + ":" + (++nextDialogLease) + ":" + Math.random();
    await chrome.storage.session.set({ [leaseKey]: {
      leaseId, origin: config.origin, incidentKey, createdAt: Date.now()
    } });
    return { ok: true, leaseId };
  });
}

async function playErrorIncidentOnce(tabId, sender, incidentKey) {
  if (typeof incidentKey !== "string" || !incidentKey || incidentKey.length > 2048 ||
      !sender.tab?.url) return { ok: false, reason: "invalid-audio-incident" };
  const scope = "watchdog:error-audio:" + tabId;
  const page = new URL(sender.tab.url);
  const claim = await withDialogLock(tabId, async () => {
    const saved = await chrome.storage.session.get([key(tabId), scope]);
    const config = saved[key(tabId)];
    if (!config?.enabled || config.mode === "continue" || config.origin !== page.origin)
      return { ok: false, reason: "inactive-or-error-sounds-disabled" };
    const ledger = saved[scope];
    const seen = ledger?.origin === page.origin && Array.isArray(ledger?.incidents) ?
      ledger.incidents : [];
    if (seen.includes(incidentKey)) return { ok: false, reason: "audio-incident-duplicate" };
    await chrome.storage.session.set({ [scope]: {
      origin: page.origin, incidents: [...seen.slice(-199), incidentKey]
    } });
    return { ok: true };
  });
  if (!claim.ok) return claim;
  return playTabAudio(tabId, sender, "error");
}

async function releaseErrorDialog(tabId, sender, leaseId) {
  if (!leaseId || !sender.tab?.url) return { ok: false, reason: "invalid-dialog-release" };
  return withDialogLock(tabId, async () => {
    const leaseKey = dialogLeaseKey(tabId);
    const value = (await chrome.storage.session.get(leaseKey))[leaseKey];
    if (!value || value.leaseId !== leaseId ||
        value.origin !== new URL(sender.tab.url).origin)
      return { ok: false, reason: "dialog-lease-mismatch" };
    await chrome.storage.session.remove(leaseKey);
    return { ok: true };
  });
}
const healthAlarmName = "chat-watchdog-health";
let healthScanning = false;
let nextSendLease = 0;
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
async function claimSend(tabId, token, assistantOrdinal, sender, userTurnKey, assistantStable) {
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
    // Assistant ordinal is only the position in the *currently rendered* DOM.
    // ChatGPT can virtualize older turns, so a genuinely new reply can reuse
    // an ordinal. A stable assistant ID PLUS a distinct logical user turn is
    // stronger evidence than the (possibly recycled) ordinal.
    const identified = assistantStable === true &&
      typeof userTurnKey === "string" && userTurnKey.length > 0 &&
      userTurnKey.length <= 1024;
    const knownUserTurns = prior && prior.origin === config.origin &&
      Array.isArray(prior.userTurns) ? prior.userTurns : [];
    if (identified && knownUserTurns.includes(userTurnKey))
      return { ok: false, reason: "user-turn-already-handled" };
    // Keep the ordinal guard for older clients, ID-less replies, and pages
    // where there is no identifiable user turn (fail closed, no duplicates).
    if (!identified && prior && prior.origin === config.origin &&
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
    // A short-lived, exclusive pre-click reservation. If the UI changes
    // BEFORE any click, its owner may safely release it. Once a click is
    // attempted the reservation is never released: delayed network delivery
    // must not cause a duplicate user message.
    const leaseId = tabId + ":" + now + ":" + (++nextSendLease) + ":" + Math.random();
    await chrome.storage.session.set({
      [scope]: {
        origin: config.origin, tokens: [...seen.slice(-499), token],
        lastClaimAt: now, lockedUntil: now + minIntervalMs,
        maxAssistantOrdinal: Math.max(prior?.maxAssistantOrdinal || 0, assistantOrdinal),
        userTurns: identified ? [...knownUserTurns.filter(t => t !== userTurnKey).slice(-499), userTurnKey] : knownUserTurns,
        leaseId, leaseTabId: tabId,
        leaseToken: token,
        previousLastClaimAt: prior?.lastClaimAt || 0,
        previousLockedUntil: prior?.lockedUntil || 0,
        previousMaxAssistantOrdinal: prior?.maxAssistantOrdinal || 0,
        previousUserTurns: knownUserTurns
      }
    });
    return { ok: true, lockedUntil: now + minIntervalMs, leaseId };
  });
  sendClaimQueues.set(scope, work);
  try { return await work; }
  finally { if (sendClaimQueues.get(scope) === work) sendClaimQueues.delete(scope); }
}

// Atomic rollback ONLY when the original tab proves it never clicked Send.
// A mismatched lease, token, or tab cannot release another sender's claim.
async function releaseUnclickedSend(tabId, token, leaseId, sender) {
  if (typeof token !== "string" || !token ||
      typeof leaseId !== "string" || !leaseId || !sender.tab?.url)
    return { ok: false, reason: "invalid-release" };
  let scope;
  try { scope = conversationKey(sender.tab.url); }
  catch { return { ok: false, reason: "invalid-url" }; }
  const previous = sendClaimQueues.get(scope) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    const ledger = (await chrome.storage.session.get(scope))[scope];
    if (!ledger || ledger.leaseToken !== token || ledger.leaseId !== leaseId ||
        ledger.leaseTabId !== tabId ||
        ledger.origin !== new URL(sender.tab.url).origin)
      return { ok: false, reason: "lease-mismatch" };
    const restored = {
      origin: ledger.origin,
      tokens: ledger.tokens.filter(value => value !== token),
      lastClaimAt: ledger.previousLastClaimAt,
      lockedUntil: ledger.previousLockedUntil,
      maxAssistantOrdinal: ledger.previousMaxAssistantOrdinal,
      userTurns: Array.isArray(ledger.previousUserTurns) ? ledger.previousUserTurns : []
    };
    await chrome.storage.session.set({ [scope]: restored });
    return { ok: true, lockedUntil: restored.lockedUntil };
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
      justification: "Play bundled or user-selected error and completed-reply notification sounds."
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
  // Bundled sounds are always available; a user-selected file simply overrides
  // the corresponding channel. Do not require custom audio names in settings.
  if (!config || !config.enabled ||
      (kind === "error" && config.mode === "continue"))
    return { ok: false, reason: "inactive-or-error-sounds-disabled" };
  if (!sender.tab?.url || new URL(sender.tab.url).origin !== config.origin)
    return { ok: false, reason: "invalid-origin" };
  await ensureOffscreen();
  if (audioEpochs.get(tabId + ":" + kind) !== epoch)
    return { ok: false, cancelled: true };
  const result = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PLAY", tabId, kind });
  if (!result?.ok && !result?.cancelled) {
    console.warn("Chat Watchdog audio:", result?.error || "playback failed");
  }
  return result || { ok: false, reason: "no-audio-response" };
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
    await playTabAudio(tabId, sender, "completion");
    return { ok: true };
  });
  completionQueues.set(sessionKey, task);
  try { return await task; }
  finally { if (completionQueues.get(sessionKey) === task) completionQueues.delete(sessionKey); }
}

// Recover a content script that never initialized (e.g. worker temporarily
// unavailable during GET_CONFIG). A live observer is only nudged to check;
// it is never re-injected, reset or duplicated.
async function scanEnabledTabs() {
  if (healthScanning) return;
  healthScanning = true;
  try {
    const all = await chrome.storage.session.get(null);
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      const saved = all[key(tab.id)];
      if (!saved?.enabled || !tab.url || tab.discarded) continue;
      let origin;
      try { origin = new URL(tab.url).origin; } catch { continue; }
      if (origin !== saved.origin) continue;
      try {
        const reply = await chrome.tabs.sendMessage(tab.id, { type: "WATCHDOG_HEALTH" });
        if (reply?.ok && reply.enabled) continue;
        if (reply?.ok) {
          await chrome.tabs.sendMessage(tab.id, { type: "WATCHDOG_CONFIG", config: saved });
          continue;
        }
      } catch { /* No responding content script: try injecting it. */ }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id }, files: ["core.js", "content.js"]
        });
        await chrome.tabs.sendMessage(tab.id, { type: "WATCHDOG_CONFIG", config: saved });
      } catch (error) {
        console.warn("Chat Watchdog recovery:", error);
      }
    }
  } catch (error) {
    console.warn("Chat Watchdog health scan:", error);
  } finally { healthScanning = false; }
}

if (chrome.alarms?.create && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === healthAlarmName) scanEnabledTabs().catch(console.warn);
  });
  // Existing alarms survive a service-worker suspension. Do not postpone
  // the next probe every time the worker wakes for an unrelated message.
  const ensureHealthAlarm = async () => {
    const existing = chrome.alarms.get ? await chrome.alarms.get(healthAlarmName) : null;
    if (!existing) await chrome.alarms.create(healthAlarmName, { periodInMinutes: 1 });
  };
  ensureHealthAlarm().catch(console.warn);
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
  if (message.type === "CLAIM_ERROR_DIALOG") {
    claimErrorDialog(tabId, sender, message.incidentKey).then(sendResponse)
      .catch(() => sendResponse({ ok: false, reason: "dialog-storage-error" }));
    return true;
  }
  if (message.type === "RELEASE_ERROR_DIALOG") {
    releaseErrorDialog(tabId, sender, message.leaseId).then(sendResponse)
      .catch(() => sendResponse({ ok: false, reason: "dialog-storage-error" }));
    return true;
  }
  if (message.type === "CLAIM_SEND") {
    claimSend(tabId, message.token, message.assistantOrdinal, sender,
      message.userTurnKey, message.assistantStable)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, reason: "storage-error" }));
    return true;
  }
  if (message.type === "RELEASE_UNCLICKED_SEND") {
    releaseUnclickedSend(tabId, message.token, message.leaseId, sender)
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
    // Legacy callers without an incidentKey still play directly. New content
    // scripts supply one to guarantee one sound per new incident per tab.
    const playback = message.incidentKey ?
      playErrorIncidentOnce(tabId, sender, message.incidentKey) :
      playTabAudio(tabId, sender);
    playback.then(sendResponse).catch(error => {
      console.warn("Chat Watchdog audio:", error);
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (message.type === "STOP_ERROR") {
    stopTabAudio(tabId, "error").catch(console.warn);
    return false;
  }
  return false;
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === "loading") {
    // New document: allow alerts for new incidents without stale tab tokens.
    withDialogLock(tabId, () => chrome.storage.session.remove([
      dialogLeaseKey(tabId), "watchdog:error-audio:" + tabId
    ]))
      .catch(console.warn);
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
  chrome.storage.session.remove([key(tabId), dialogLeaseKey(tabId),
    "watchdog:error-audio:" + tabId]).catch(() => {});
  ChatWatchdogAudio.remove(tabId).catch(() => {});
  ChatWatchdogAudio.remove(tabId, "completion").catch(() => {});
  audioEpochs.delete(tabId + ":error");
  audioEpochs.delete(tabId + ":completion");
});
