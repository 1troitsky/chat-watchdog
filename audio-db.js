(function (root) {
  "use strict";

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("chat-watchdog-audio", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("audio")) {
          request.result.createObjectStore("audio");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function run(mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("audio", mode);
      const request = operation(transaction.objectStore("audio"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    });
  }

  // Keep the original tab ID key for error audio, so upgrades do not lose it.
  const fileKey = (tabId, kind = "error") => kind === "completion" ?
    "completion:" + tabId : String(tabId);
  root.ChatWatchdogAudio = {
    save: (tabId, file, kind = "error") =>
      run("readwrite", store => store.put(file, fileKey(tabId, kind))),
    get: (tabId, kind = "error") =>
      run("readonly", store => store.get(fileKey(tabId, kind))),
    remove: (tabId, kind = "error") =>
      run("readwrite", store => store.delete(fileKey(tabId, kind)))
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
