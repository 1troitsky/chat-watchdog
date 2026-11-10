(async function () {
  "use strict";
  const fields = ["marker", "reply", "delaySeconds", "errorWords",
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
    for (const field of fields) $(field).value = config[field];
    $("audioName").textContent = config.audioName || "Файл не выбран";
  };
  render();

  async function save() {
    config = ChatWatchdogCore.normalize(config);
    await chrome.storage.session.set({ [storageKey]: config });
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "WATCHDOG_CONFIG", config });
    } catch {
      // The content script is not loaded when the switch is OFF.
    }
    status("Сохранено для этой вкладки");
  }

  for (const field of fields) {
    $(field).addEventListener("change", async () => {
      config[field] = $(field).value;
      await save();
    });
  }

  $("enabled").addEventListener("change", async () => {
    const checked = $("enabled").checked;
    $("enabled").disabled = true;
    try {
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
