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
test("regex mode recognizes both development report endings and an explicit marker", () => {
  const pattern = "(?:!!!ГОТОВО!!!|Следующий (?:этап|участок)[\\s\\S]{0,400})$";
  const first = "CI 3/3 PASS\nСледующий этап P1 — версии MediaFile и интеграция видео/аудио с заданиями и разрешениями доступа.";
  const second = "P1-20 закончен.\nСледующий участок — безопасное автоудаление файлов и заданий: сроки хранения, права, восстановление после сбоев и подтверждённая очистка из S3. Это отдельный механизм, чтобы изменение расписания никогда случайно не уничтожало данные.";
  assert.equal(Core.hasMarker(first, pattern, true), true);
  assert.equal(Core.hasMarker(second, pattern, true), true);
  assert.equal(Core.hasMarker("Итоги\n!!!ГОТОВО!!!", pattern, true), true);
  assert.equal(Core.hasMarker("Следующий этап будет позже. " + "Работа продолжается. ".repeat(60), pattern, true), false);
});
test("regex /pattern/i uses flags and anchors all alternatives", () => {
  assert.equal(Core.hasMarker("ГОТОВО!", "/готово!/i", true), true);
  assert.equal(Core.hasMarker("ГОТОВО! но дальше ещё текст", "/готово!/i", true), false);
  assert.equal(Core.hasMarker("hello more text", "hello|text", true), true);
  assert.equal(Core.hasMarker("hello more text still going", "hello|text", true), false);
});
test("invalid patterns are ignored and plain text remains compatible", () => {
  assert.throws(() => Core.compileMarker("("), SyntaxError);
  assert.equal(Core.hasMarker("(", "(", true), false);
  assert.equal(Core.normalize().markerRegex, false);
  assert.equal(Core.normalize({markerRegex:true}).markerRegex, true);
  assert.equal(Core.hasMarker("Ответ !!!ГОТОВО!!!", "!!!ГОТОВО!!!"), true);
});
test("detects Russian and English error phrases", () => {
  const words = Core.DEFAULTS.errorWords;
  assert.equal(Core.findError("Ошибка соединения. Повторите", words), "Ошибка соединения");
  assert.equal(Core.findError("NETWORK ERROR: retry", words), "Network error");
  assert.equal(Core.findError("No issue", words), null);
});
test("same visible error remains acknowledged after closing the dialog", () => {
  const tracker = Core.createErrorTracker();
  const first = { node: {}, signature: "Ошибка соединения", phrase: "Ошибка соединения" };
  assert.equal(tracker.observe([first]), first);
  assert.equal(tracker.observe([first]), null); // repeated polling after dismissal
  assert.equal(tracker.observe([first]), null);
});

test("new DOM error with identical text alerts even while the old one remains", () => {
  const tracker = Core.createErrorTracker();
  const first = { node: {}, signature: "Ошибка соединения", phrase: "Ошибка соединения" };
  const second = { node: {}, signature: "Ошибка соединения", phrase: "Ошибка соединения" };
  assert.equal(tracker.observe([first]), first);
  assert.equal(tracker.observe([first, second]), second);
  assert.equal(tracker.observe([first, second]), null);
  assert.equal(tracker.observe([first]), null); // old error must not re-alert
});

test("reappearance of the same node and changed errors are new occurrences", () => {
  const tracker = Core.createErrorTracker();
  const node = {};
  const original = { node, signature: "Ошибка соединения", phrase: "Ошибка соединения" };
  const changed = { node, signature: "Ошибка соединения: попытка 2", phrase: "Ошибка соединения" };
  assert.equal(tracker.observe([original]), original);
  assert.equal(tracker.observe([]), null);
  assert.equal(tracker.observe([original]), original);
  assert.equal(tracker.observe([changed]), changed);
  assert.equal(tracker.observe([changed]), null);
  tracker.reset();
  assert.equal(tracker.observe([changed]), changed);
});
test("a removed and re-inserted identical error triggers again even between polls", () => {
  const tracker = Core.createErrorTracker();
  const node = { contains: (other) => other === node };
  const error = { node, signature: "Ошибка соединения" };
  assert.equal(tracker.observe([error]), error);
  tracker.forgetSubtree(node); // DOM removal; next poll sees the same node again
  assert.equal(tracker.observe([error]), error);
  assert.equal(tracker.observe([error]), null);
});

test("re-rendering an identical error in the same wrapper triggers again", () => {
  const tracker = Core.createErrorTracker();
  const wrapper = { contains: (child) => child === message };
  const message = { contains: () => false };
  const error = { node: message, signature: "Ошибка соединения" };
  assert.equal(tracker.observe([error]), error);
  assert.equal(tracker.observe([error]), null); // Closing does not rearm
  tracker.markUpdated(wrapper); // the site replaced the text in its wrapper
  assert.equal(tracker.observe([error]), error);
  assert.equal(tracker.observe([error]), null);
});

test("an unrelated DOM change does not re-arm an already dismissed error", () => {
  const tracker = Core.createErrorTracker();
  const node = {};
  const error = { node, signature: "Ошибка соединения" };
  assert.equal(tracker.observe([error]), error);
  tracker.markUpdated({ contains: () => false });
  tracker.forgetSubtree({ contains: () => false });
  assert.equal(tracker.observe([error]), null);
});

test("uses different selectors for different assistants", () => {
  assert.match(Core.selectorsFor("chatgpt.com").assistant, /data-message-author-role/);
  assert.match(Core.selectorsFor("chatgpt.com").editor, /pending-conversation-input/);
  assert.match(Core.selectorsFor("chatgpt.com").send, /aria-label="Отправить"/);
  assert.match(Core.selectorsFor("claude.ai").assistant, /claude-message/);
});
