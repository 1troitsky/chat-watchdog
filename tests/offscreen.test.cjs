const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  const listeners = [];
  const playing = [];
  const context = {
    Map, URL: {
      createObjectURL: () => "blob:fixture",
      revokeObjectURL: () => {}
    },
    ChatWatchdogAudio: { get: async () => ({ type: "audio/mp3" }) },
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } },
    Audio: class {
      constructor() {
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
  return { send, playing, context };
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
