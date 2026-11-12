const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  const listeners = [];
  const playing = [];
  const revoked = [];
  const fetched = [];
  let fetchFailure = false;
  const context = {
    fetch: async url => {
      fetched.push(url);
      if (fetchFailure) throw new Error("fetch is blocked");
      return { ok: true, blob: async () => ({ size: 3, type: "audio/mpeg" }) };
    },
    Map, URL: {
      createObjectURL: () => "blob:fixture",
      revokeObjectURL: url => { revoked.push(url); }
    },
    ChatWatchdogAudio: { get: async () => ({ type: "audio/mp3" }) },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      getURL: url => "chrome-extension://watchdog-test/" + url
    } },
    Audio: class {
      constructor(src) {
        this.src = src;
        this.paused = false;
        this.events = {};
        playing.push(this);
      }
      play() { return Promise.resolve(); }
      pause() { this.paused = true; }
      removeAttribute() {}
      load() {}
      addEventListener(type, fn) { this.events[type] = fn; }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8"), context);
  function send(type, tabId, kind) {
    return new Promise((resolve) => {
      listeners[0]({ type, tabId, kind }, {}, resolve);
    });
  }
  return { send, playing, context, revoked, fetched,
    failFetch() { fetchFailure = true; } };
}

test("dialog STOP immediately pauses the matching tab without affecting another tab", async () => {
  const { send, playing } = harness();
  assert.equal((await send("OFFSCREEN_PLAY", 1)).ok, true);
  assert.equal((await send("OFFSCREEN_PLAY", 2)).ok, true);
  assert.equal(playing.length, 2);
  assert.equal((await send("OFFSCREEN_STOP", 1)).ok, true);
  assert.equal(playing[0].paused, true);
  assert.equal(playing[1].paused, false);
  assert.equal((await send("OFFSCREEN_STOP", 2)).ok, true);
  assert.equal(playing[1].paused, true);
});

test("STOP invalidates an unfinished audio-file load", async () => {
  const { send, playing, context } = harness();
  let resolveFile;
  context.ChatWatchdogAudio.get = () => new Promise(resolve => { resolveFile = resolve; });
  const start = send("OFFSCREEN_PLAY", 3);
  // A pending async load must not start playing after STOP.
  await send("OFFSCREEN_STOP", 3);
  resolveFile({ type: "audio/mp3" });
  const result = await start;
  assert.equal(result.cancelled, true);
  assert.equal(playing.length, 0);
});


test("completion and error use independent players; stopping an error does not cut off completion", async () => {
  const { send, playing } = harness();
  assert.equal((await send("OFFSCREEN_PLAY", 11, "completion")).ok, true);
  assert.equal((await send("OFFSCREEN_PLAY", 11, "error")).ok, true);
  assert.equal(playing.length, 2);
  assert.equal(playing[0].paused, false);
  assert.equal(playing[1].paused, false);
  assert.equal((await send("OFFSCREEN_STOP", 11, "error")).ok, true);
  assert.equal(playing[0].paused, false);
  assert.equal(playing[1].paused, true);
  // Error alerts can recur. They must never replay the completion channel.
  assert.equal((await send("OFFSCREEN_PLAY", 11, "error")).ok, true);
  assert.equal(playing.length, 3);
  assert.equal(playing[0].paused, false);
  assert.equal((await send("OFFSCREEN_STOP", 11)).ok, true);
  assert.equal(playing[0].paused, true);
  assert.equal(playing[2].paused, true);
});


test("fresh tabs use bundled MP3s and keep each channel independent", async () => {
  const { send, playing, context, revoked, fetched } = harness();
  context.ChatWatchdogAudio.get = async () => undefined; // Fresh installation.
  assert.equal((await send("OFFSCREEN_PLAY", 7, "completion")).ok, true);
  assert.equal((await send("OFFSCREEN_PLAY", 7, "error")).ok, true);
  assert.equal(playing[0].src, "blob:fixture");
  assert.equal(playing[1].src, "blob:fixture");
  assert.deepEqual(fetched, [
    "chrome-extension://watchdog-test/sounds/sfx-16.mp3",
    "chrome-extension://watchdog-test/sounds/01507.mp3"
  ]);
  assert.equal(playing[0].loop, false);
  assert.equal(playing[1].loop, false);
  assert.deepEqual(revoked, [], "bundled Blob URLs remain live until playback ends/STOP");
  await send("OFFSCREEN_STOP", 7, "error");
  assert.equal(playing[0].paused, false, "error sound cannot stop completion");
  assert.equal(playing[1].paused, true);
  assert.equal((await send("OFFSCREEN_PLAY", 7, "error")).ok, true);
  assert.equal(playing[2].src, "blob:fixture");
});

test("per-tab uploaded audio overrides only its channel and releases its blob", async () => {
  const { send, playing, context, revoked } = harness();
  context.ChatWatchdogAudio.get = async (_tab, kind) =>
    kind === "completion" ? { name: "custom.wav", type: "audio/wav" } : undefined;
  await send("OFFSCREEN_PLAY", 7, "completion");
  await send("OFFSCREEN_PLAY", 7, "error");
  assert.equal(playing[0].src, "blob:fixture");
  assert.equal(playing[1].src, "blob:fixture");
  await send("OFFSCREEN_STOP", 7, "completion");
  assert.deepEqual(revoked, ["blob:fixture"]);
});

test("unavailable IndexedDB still falls back to bundled sounds", async () => {
  const { send, playing, context } = harness();
  context.ChatWatchdogAudio.get = async () => { throw new Error("IndexedDB unavailable"); };
  assert.equal((await send("OFFSCREEN_PLAY", 7, "error")).ok, true);
  assert.equal(playing[0].src, "blob:fixture");
});

test("bundle fetch falls back to direct extension URL if fetch fails", async () => {
  const app = harness();
  app.context.ChatWatchdogAudio.get = async () => undefined;
  app.failFetch();
  assert.equal((await app.send("OFFSCREEN_PLAY", 15, "error")).ok, true);
  assert.equal(app.playing[0].src, "chrome-extension://watchdog-test/sounds/01507.mp3");
});

test("bundled playback failures return actionable errors instead of success", async () => {
  const app = harness();
  app.context.ChatWatchdogAudio.get = async () => undefined;
  app.context.Audio.prototype.play = async function () { throw new Error("NotAllowedError"); };
  const result = await app.send("OFFSCREEN_PLAY", 16, "error");
  assert.equal(result.ok, false);
  assert.equal(result.source, "bundled-blob");
  assert.match(result.error, /NotAllowedError/);
});

test("bundled files are real readable MP3s included in the extension directory", () => {
  const root = path.join(__dirname, "..", "sounds");
  for (const file of ["sfx-16.mp3", "01507.mp3"]) {
    const audio = fs.readFileSync(path.join(root, file));
    assert.ok(audio.length > 1000, file + " must not be empty");
    assert.equal(audio.subarray(0, 3).toString("ascii"), "ID3", "expected an MP3 header");
  }
});
