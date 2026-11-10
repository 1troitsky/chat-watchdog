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

  root.ChatWatchdogAudio = {
    save: (tabId, file) => run("readwrite", (store) => store.put(file, String(tabId))),
    get: (tabId) => run("readonly", (store) => store.get(String(tabId))),
    remove: (tabId) => run("readwrite", (store) => store.delete(String(tabId)))
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
