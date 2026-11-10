(async function () {
  "use strict";
  const fields = ["mode", "marker", "reply", "delaySeconds", "cooldownSeconds", "errorWords",
    "assistantSelector", "editorSelector", "sendSelector", "stopSelector",
    "completionSelector", "errorSelector"];
  const $ = (id) => document.getElementById(id);
  const status = (text) => { $("status").textContent = text; };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin;
  try {
    const url = new URL(tab.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Not a webpage");
    origin = url.origin;
  } catch {
    $("site").textContent = "Открой веб-чат";
    $("settings").hidden = true;
    $("enabled").disabled = true;
    return;
  }
  $("site").textContent = origin + " · только эта вкладка";
  const storageKey = "tab:" + tab.id;
  const stored = await chrome.storage.session.get(storageKey);
  let config = ChatWatchdogCore.normalize(stored[storageKey]);
  if (config.origin && config.origin !== origin) {
    config.enabled = false;
    config.audioName = "";
  }
  config.origin = origin;

  const render = () => {
    $("enabled").checked = config.enabled;
    $("markerRegex").checked = config.markerRegex;
    $("toastEnabled").checked = config.toastEnabled;
    for (const field of fields) $(field).value = config[field];
    $("autoSendSettings").hidden = config.mode === "errors";
    $("audioName").textContent = config.audioName || "Файл не выбран";
  };
  render();

  function markerError() {
    if (config.mode === "errors" || !config.markerRegex || !config.marker.trim()) return "";
    try {
      ChatWatchdogCore.compileMarker(config.marker);
      return "";
    } catch (error) {
      return "Ошибка Regex: " + error.message;
    }
  }

  async function save() {
    config = ChatWatchdogCore.normalize(config);
    await chrome.storage.session.set({ [storageKey]: config });
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "WATCHDOG_CONFIG", config });
    } catch {
      // The content script is not loaded when the switch is OFF.
    }
    status(markerError() || "Сохранено для этой вкладки");
  }

  for (const field of fields) {
    $(field).addEventListener("change", async () => {
      config[field] = $(field).value;
      if (field === "mode") $("autoSendSettings").hidden = config.mode === "errors";
      await save();
    });
  }

  $("toastEnabled").addEventListener("change", async () => {
    config.toastEnabled = $("toastEnabled").checked;
    await save();
  });

  $("markerRegex").addEventListener("change", async () => {
    config.markerRegex = $("markerRegex").checked;
    await save();
  });

  $("enabled").addEventListener("change", async () => {
    const checked = $("enabled").checked;
    $("enabled").disabled = true;
    try {
      if (checked && markerError()) throw new Error(markerError());
      if (checked) {
        const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
        if (!granted) throw new Error("Доступ к сайту не предоставлен");
      }
      config.enabled = checked;
      await save();
      if (checked) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["core.js", "content.js"]
        });
        await chrome.tabs.sendMessage(tab.id, { type: "WATCHDOG_CONFIG", config });
        status("Включено только в этой вкладке");
      } else {
        await chrome.runtime.sendMessage({ type: "STOP_TAB_AUDIO", tabId: tab.id });
        status("Выключено");
      }
    } catch (error) {
      config.enabled = false;
      await save();
      status(error.message || "Ошибка включения");
    } finally {
      $("enabled").checked = config.enabled;
      $("enabled").disabled = false;
    }
  });

  $("diagnose").addEventListener("click", async () => {
    const output = $("diagnostic");
    output.textContent = "Проверка…";
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: "WATCHDOG_DIAGNOSE" });
      if (!result) throw new Error("Монитор не отвечает. Включи ON и обнови страницу.");
      output.textContent = [
        "Монитор: " + (result.enabled ? "ON" : "OFF"),
        "Режим: " + (result.mode === "errors" ? "Только ошибки" : "Автопродолжение + ошибки"),
        "Сообщений ИИ: " + result.assistantCount,
        "Режим поиска: " + result.assistantDetection,
        "Старые роли: " + result.legacyAssistantCount,
        "Новые search-unit: " + result.chatGptSearchUnitCount,
        "Новые turn-key: " + result.chatGptTurnCount,
        "Сообщения пользователя: " + result.chatGptUserBubbleCount,
        "Свой селектор ИИ: " + (result.customAssistantSelector ? "да" : "нет"),
        "Режим без маркера: " + (result.markerDisabled ? "ДА" : "НЕТ"),
        "Последний ответ после пользователя: " + (result.assistantFollowsLastUser ? "ДА" : "НЕТ"),
        "Условие продолжения: " + (result.markerDetected ? "ДА" : "НЕТ"),
        "Ход пользователя распознан: " + (result.logicalUserTurnDetected ? "да" : "нет"),
        "Маркер уже отправлен: " + (result.markerAlreadySent ? "ДА" : "НЕТ"),
        "Нажатий Отправить монитором: " + result.sendClicks,
        "Запомнено ответов ИИ: " + result.rememberedAssistantReplies,
        "Пауза до следующей отправки: " + result.cooldownRemainingSeconds + " с",
        "Отправка в процессе: " + (result.sending ? "да" : "нет"),
        "Редактор: " + (result.editorFound ? "найден" : "НЕ НАЙДЕН"),
        "Поле пустое: " + (result.editorEmpty ? "да" : "нет"),
        "Кнопка отправки активна: " + (result.sendButtonFound ? "да" : "нет"),
        "Кнопка остановки видна: " + (result.stopButtonVisible ? "да" : "нет"),
        "Ожидание отправки: " + (result.pending ? "да" : "нет")
      ].join("\n");
    } catch (error) {
      output.textContent = "Не удалось проверить: " + (error.message || String(error));
    }
  });

  async function refreshLog() {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: "WATCHDOG_LOG" });
      const events = result?.events || [];
      $("eventLog").textContent = events.length ?
        events.slice(-30).map(entry => entry.time + "  " + entry.message).join("\n") :
        "Событий пока нет";
    } catch {
      $("eventLog").textContent = "Монитор недоступен: включи ON и обнови страницу";
    }
  }

  $("refreshLog").addEventListener("click", refreshLog);
  $("clearLog").addEventListener("click", async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "WATCHDOG_CLEAR_LOG" });
      await refreshLog();
    } catch { $("eventLog").textContent = "Не удалось очистить журнал"; }
  });

  $("audioFile").addEventListener("change", async () => {
    const file = $("audioFile").files[0];
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      status("Выбери аудиофайл");
      return;
    }
    try {
      await ChatWatchdogAudio.save(tab.id, file);
      config.audioName = file.name;
      $("audioName").textContent = file.name;
      await save();
    } catch (error) {
      status("Не получилось сохранить MP3: " + error.message);
    }
  });
})();
