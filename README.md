# Chat Watchdog

A small, local Chrome/Chromium Manifest V3 extension for continuing AI chat tasks automatically.

## Features

- Independent ON/OFF and configuration for **each browser tab**, even for two tabs on the same AI website.
- Waits for the assistant's response to **end with** the configured marker (default: !!!ГОТОВО!!!), and for the stop-generation control to disappear; then sends the configured follow-up after the chosen delay (5 seconds by default).
- Optional local MP3 alert when an error phrase appears in a visible error/status element.
- Automatic detection for ChatGPT, Claude, Gemini, and a basic DeepSeek adapter. Other UIs can use optional CSS selectors. Web-chat interfaces change; these selectors need real-browser verification.
- Per-site permission is requested **only when you switch ON** in that tab. No blanket permission at installation.
- No analytics, trackers, external scripts, network requests, or backend. Selected sounds stay in browser IndexedDB and **are not uploaded**.

## Install

1. Download or clone the repository.
2. In Chrome, open chrome://extensions and turn on Developer mode.
3. Click Load unpacked and select the folder containing manifest.json.
4. Open an AI chat and click the Chat Watchdog icon.
5. Choose an MP3 using the file picker, configure the marker/delay/message, then turn ON.
6. Repeat independently in another tab. Settings are kept for each tab within the browser session.

For a local file such as file:///Users/ivan/Music/Can_-_Vitamin_C_(Bib.fm).mp3, use the **file picker**. A file:// URL alone is not permission for a web page or extension to load its bytes.

## Safety and limitations

- The extension is **OFF by default**. Enabling skips the already-completed assistant response to avoid replaying old tasks.
- It never overwrites a nonempty input draft.
- It uses UI automation, not the AI provider's API, and does not guarantee that a response is correct or that a task has truly completed.
- Completion is detected by the marker at the **end of the last assistant message**, stable text, an absent stop button, and optionally a user-provided completion element.
- Errors are detected in toast/alert/status elements, not every mention of error words inside chat history.
- MP3 playback is subject to Chrome audio restrictions. An error alarm requires selecting a file for that tab.
- Timers in background tabs may be throttled by Chrome.
- Per-tab settings are session-only, and turn OFF when the browser session ends or the tab navigates to a different origin. Local sound blobs are deleted on tab close.
- Built-in selectors are best-effort; unsupported sites require custom CSS selectors and manual testing.
- This is a local developer extension, not a Chrome Web Store release.

## Check

Run: node --test

## Permissions

- storage: per-tab settings in chrome.storage.session.
- scripting + activeTab: run the tab monitor after the user enables it.
- offscreen: play audio without opening a new visible browser tab.
- optional_host_permissions: supports sites you may add later, **granted one origin at a time by an explicit click**. It does not automatically access every website.

Licensed under MIT.
