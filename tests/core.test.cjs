const assert = require("node:assert/strict");
const test = require("node:test");
const Core = require("../core.js");

test("defaults are safe and disabled", () => {
  const value = Core.normalize();
  assert.equal(value.enabled, false);
  assert.equal(value.delaySeconds, 5);
  assert.equal(value.reply, "Ок, продолжаем");
});
test("limits the delay and normalizes strings", () => {
  assert.equal(Core.normalize({ delaySeconds: -9 }).delaySeconds, 1);
  assert.equal(Core.normalize({ delaySeconds: 9999 }).delaySeconds, 600);
});
test("only matches marker at the end", () => {
  assert.equal(Core.hasMarker("Answer\n!!!ГОТОВО!!!", "!!!ГОТОВО!!!"), true);
  assert.equal(Core.hasMarker("!!!ГОТОВО!!!\nStill working", "!!!ГОТОВО!!!"), false);
});
test("detects Russian and English error phrases", () => {
  const words = Core.DEFAULTS.errorWords;
  assert.equal(Core.findError("Ошибка соединения. Повторите", words), "Ошибка соединения");
  assert.equal(Core.findError("NETWORK ERROR: retry", words), "Network error");
  assert.equal(Core.findError("No issue", words), null);
});
test("notifies once per continuous error, even after dismissal", () => {
  const tracker = Core.createErrorTracker();
  assert.equal(tracker.observe("Error:Network error"), true);
  assert.equal(tracker.observe("Error:Network error"), false);
  assert.equal(tracker.observe("Error:Network error"), false);
  assert.equal(tracker.observe(null), false);
  assert.equal(tracker.observe("Error:Network error"), true);
  assert.equal(tracker.observe("Error:Rate limit"), true);
});
test("uses different selectors for different assistants", () => {
  assert.match(Core.selectorsFor("chatgpt.com").assistant, /data-message-author-role/);
  assert.match(Core.selectorsFor("claude.ai").assistant, /claude-message/);
});
