const assert = require("node:assert/strict");
const test = require("node:test");
const Core = require("../core.js");

test("defaults are safe and disabled", () => {
  const value = Core.normalize();
  assert.equal(value.enabled, false);
  assert.equal(value.delaySeconds, 30);
  assert.equal(value.reply, "Ок, продолжаем");
});
test("old saved five-second default migrates to 30 seconds, custom delays stay unchanged", () => {
  assert.equal(Core.normalize({ delaySeconds: 5 }).delaySeconds, 30);
  assert.equal(Core.normalize({ delaySeconds: 5, delaySecondsVersion: 2 }).delaySeconds, 5);
  assert.equal(Core.normalize({ delaySeconds: 13 }).delaySeconds, 13);
  const upgraded = Core.normalize({ delaySeconds: 5 });
  assert.equal(Core.normalize(upgraded).delaySeconds, 30);
  assert.equal(upgraded.delaySecondsVersion, 2);
});

test("limits the delay and normalizes strings", () => {
  assert.equal(Core.normalize({ delaySeconds: -9 }).delaySeconds, 1);
  assert.equal(Core.normalize({ delaySeconds: 9999 }).delaySeconds, 600);
});
test("matches marker only on the edges of an answer", () => {
  assert.equal(Core.hasMarker("Answer\n!!!ГОТОВО!!!", "!!!ГОТОВО!!!"), true);
  assert.equal(Core.hasMarker("!!!ГОТОВО!!!\nStill working", "!!!ГОТОВО!!!"), true);
  assert.equal(Core.hasMarker("Answer\n!!!ГОТОВО!!!\nMore", "!!!ГОТОВО!!!"), false);
});
test("literal completion marker matches at the start OR end, never the middle", () => {
  assert.equal(Core.hasMarker("!!!ГОТОВО!!!\nПодробный отчёт", "!!!ГОТОВО!!!"), true);
  assert.equal(Core.hasMarker("Подробный отчёт\n!!!ГОТОВО!!!", "!!!ГОТОВО!!!"), true);
  assert.equal(Core.hasMarker("Отчёт\n!!!ГОТОВО!!!\nВажное продолжение", "!!!ГОТОВО!!!"), false);
});

test("Regex respects start and end of the entire reply", () => {
  assert.equal(Core.hasMarker("!!!ГОТОВО!!!\nПодробный отчёт", "/!!!ГОТОВО!!!/i", true), true);
  assert.equal(Core.hasMarker("Подробный отчёт\n!!!ГОТОВО!!!", "/!!!ГОТОВО!!!/i", true), true);
  assert.equal(Core.hasMarker("Подробный отчёт\n!!!ГОТОВО!!!\nВажное продолжение", "/!!!ГОТОВО!!!/i", true), false);
  assert.equal(Core.hasMarker("Отчёт\n!!!ГОТОВО!!!\nТекст", "/!!!ГОТОВО!!!/im", true), false);
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
  assert.equal(Core.hasMarker("ГОТОВО! но дальше ещё текст", "/готово!/i", true), true);
  assert.equal(Core.hasMarker("В середине ГОТОВО! но дальше ещё текст", "/готово!/i", true), false);
  assert.equal(Core.hasMarker("hello more text", "hello|text", true), true);
  assert.equal(Core.hasMarker("hello more text still going", "hello|text", true), true);
  assert.equal(Core.hasMarker("somewhere hello more text still going", "hello|text", true), false);
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

test("mutations inside a tracked error re-arm; unrelated ancestor changes do not", () => {
  const tracker = Core.createErrorTracker();
  const wrapper = { contains: (child) => child === message };
  const message = { contains: (child) => child === leaf };
  const leaf = {};
  const error = { node: message, signature: "Ошибка соединения" };
  assert.equal(tracker.observe([error]), error);
  assert.equal(tracker.observe([error]), null);
  tracker.markUpdated(wrapper); // Rendering a toast into <body> does not re-arm.
  assert.equal(tracker.observe([error]), null);
  tracker.markUpdated(leaf); // Content of the tracked error actually changed.
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

test("ChatGPT selector supports 2026 search-unit and turn-key markup, keeping old selector", () => {
  const selector = Core.selectorsFor("chatgpt.com").assistant;
  assert.match(selector, /data-message-author-role/);
  assert.match(selector, /data-content-search-unit-key/);
  assert.match(selector, /data-turn-key/);
  assert.match(selector, /data-user-message-bubble/);
  assert.match(Core.selectorsFor("claude.ai").assistant, /claude-message/);
});
test("logical user turn fingerprint survives React node replacement", () => {
  assert.equal(Core.userTurnFingerprint(2, "  Давай   дальше "), Core.userTurnFingerprint(2, "Давай дальше"));
  assert.notEqual(Core.userTurnFingerprint(2, "Давай дальше"), Core.userTurnFingerprint(3, "Давай дальше"));
  assert.notEqual(Core.userTurnFingerprint(2, "Давай дальше"), Core.userTurnFingerprint(2, "Другая задача"));
});

test("re-rendering both the assistant and the user cannot re-arm the old marker", () => {
  const guard = Core.createSendGuard();
  const oldTurn = Core.userTurnFingerprint(1, "Ну давай пиши готово");
  assert.equal(guard.alreadySent("!!!ГОТОВО!!!", oldTurn), false);
  guard.record("!!!ГОТОВО!!!", oldTurn);
  assert.equal(guard.alreadySent("!!!ГОТОВО!!!", oldTurn), true);
  assert.equal(guard.alreadySent("Работа завершена !!!ГОТОВО!!!", oldTurn), true);
});

test("new user turn can send identical marker, but unknown turns fail closed", () => {
  const guard = Core.createSendGuard();
  const first = Core.userTurnFingerprint(1, "Ну давай пиши готово");
  const second = Core.userTurnFingerprint(2, "Ок, продолжаем");
  guard.record("!!!ГОТОВО!!!", first);
  assert.equal(guard.alreadySent("!!!ГОТОВО!!!", second), false);
  guard.record("!!!ГОТОВО!!!", second);
  assert.equal(guard.alreadySent("!!!ГОТОВО!!!", second), true);
  assert.equal(guard.alreadySent("!!!ГОТОВО!!!", null), true);
});

test("error-only mode is normalized, kept independent of the ON switch", () => {
  assert.equal(Core.normalize({ enabled: true, mode: "errors" }).mode, "errors");
  assert.equal(Core.normalize({ enabled: false, mode: "errors" }).mode, "errors");
  assert.equal(Core.normalize({ enabled: true }).mode, "auto");
  assert.equal(Core.normalize({ enabled: true, mode: "something" }).mode, "auto");
  assert.equal(Core.normalize({ enabled: true, mode: "errors" }).enabled, true);
});

test("empty completion marker is intentional and not replaced with a default", () => {
  const config = Core.normalize({ marker: "", markerRegex: true });
  assert.equal(config.marker, "");
  assert.equal(Core.completionMatches("A completed reply", config.marker, config.markerRegex), true);
  assert.equal(Core.completionMatches("   ", config.marker, config.markerRegex), false);
});

test("requested assistant alert phrases match with exact exclamation points", () => {
  const expected = [
    "!!!ЕСТЬ ЗАДАНИЕ ДЛЯ АГЕНТА!!!",
    "!!!ЖДУ РЕШЕНИЕ!!!",
    "!!!У НАС ПРОБЛЕМА!!!",
    "!!НУЖНА ЛОКАЛЬНАЯ ПРОВЕРКА!!!"
  ];
  for (const phrase of expected) {
    assert.ok(Core.DEFAULTS.errorWords.split("\n").includes(phrase));
    assert.equal(Core.findErrorLine("Текст ответа\n" + phrase, Core.DEFAULTS.errorWords), phrase);
  }
  assert.equal(Core.findErrorLine(
    "Например, !!!У НАС ПРОБЛЕМА!!! может использоваться как маркер.",
    Core.DEFAULTS.errorWords
  ), null);
});

test("upgrading previous session settings adds new alert markers once", () => {
  const old = Core.normalize({
    errorWords: "Ошибка соединения",
    marker: "!!!ГОТОВО!!!"
  });
  assert.match(old.errorWords, /!!!ЕСТЬ ЗАДАНИЕ ДЛЯ АГЕНТА!!!/);
  assert.match(old.errorWords, /!!НУЖНА ЛОКАЛЬНАЯ ПРОВЕРКА!!!/);
  const next = Core.normalize(old);
  assert.equal(next.errorWords, old.errorWords);
  const edited = Core.normalize({ ...next, errorWords: "Моя новая ошибка" });
  assert.equal(edited.errorWords, "Моя новая ошибка");
});

test("sensitive Stop controls are never treated as Send buttons", () => {
  const button = { getAttribute: name =>
    name === "aria-label" ? "Остановить генерацию" : null };
  assert.equal(Core.isStopAction(button), true);
  assert.equal(Core.isStopAction({ getAttribute: name =>
    name === "aria-label" ? "Отправить" : null }), false);
});

test("uses different selectors for different assistants", () => {
  assert.match(Core.selectorsFor("chatgpt.com").assistant, /data-message-author-role/);
  assert.match(Core.selectorsFor("chatgpt.com").editor, /pending-conversation-input/);
  assert.match(Core.selectorsFor("chatgpt.com").send, /aria-label="Отправить"/);
  assert.match(Core.selectorsFor("claude.ai").assistant, /claude-message/);
});
