## v0.3.0 Strict Send Protocol

The background service worker now **arms** a completion token and sets an absolute `dueAt` on the worker clock. Content scripts cannot claim a send without the exact background-issued `armId`, the matching token/ordinal/tab, and a reached deadline. A canceled pending timer revokes its arm; any observed user turn revokes outstanding arms in that conversation. Old content scripts' bare `CLAIM_SEND` requests fail closed. One arm per conversation is allowed and service-worker suspension does not reset it. The existing atomic 45-second cooldown and one-reply deduplication still apply.

This is a safeguard for Watchdog's own send path; it cannot prevent other browser extensions or external tools from submitting to ChatGPT.

# Chat Watchdog

A small, local Chrome/Chromium Manifest V3 extension for continuing AI chat tasks automatically.

## Features

- Independent ON/OFF and configuration for **each browser tab**, even for two tabs on the same AI website.
- **Two modes** per tab: **Автопродолжение + ошибки** (default), or **Только ошибки — без отправки**. Error-only mode watches status alerts and assistant error phrases, shows the error dialog, logs notifications and plays the selected audio, but never fills or submits the composer. Switching to error-only cancels any scheduled submission, including an in-progress async wait for the Send button. A rapid toggle back to auto mode cannot resume a stale in-flight send. Invalid marker Regex settings do not block enabling the error-only mode. Switching back to auto mode does not replay an already displayed assistant reply.
- Alert overlays are globally deduplicated through the page DOM. Independent injected content-script worlds may not stack dialogs or play duplicate alarms; closing an alert removes all orphaned overlays and remembers the acknowledgement without storing the chat text.
- From v0.2.13 Watchdog also records the time a new user turn appears in the observed page and whether there was a recent composer input, Enter, or Send-button event (with Chrome's trusted/synthetic event flag). This is **observational telemetry**, not proof of who submitted the message, and does not log message contents. It helps diagnose user turns that appear before the Watchdog delay expires and have no corresponding claim.
- From v0.2.11 the copied diagnostic report includes the modes of every open tab on the same site and a **shared send-attempt audit across all tabs** (accepted/rejected claims and click calls), without saving transcript text or full conversation IDs. Entries are stored in session storage, limited to the last 100. This helps distinguish Watchdog actions from messages originating elsewhere.
- The event journal has a **Скопировать** button that refreshes and copies the latest event log **and the complete chat-element diagnostics** in one text report, without copying the chat transcript. The diagnostic panel records the reason each scheduled automatic send was cancelled and the scheduled send time. The event journal records the moment a send timer actually fires, so detection is not confused with submission.
- Has a **hard conversation-wide auto-continuation lockout** after every accepted Send claim: 45 seconds by default (10–3600 seconds). The content script synchronizes the stored absolute lock deadline on activation and refuses to detect completion markers, start send timers, fill editors or send messages until the deadline passes. If the lock state cannot be read, auto-send fails closed. Error detection remains active during the lockout. Checks both the live Stop button and the enabled Send button before submission, and never clicks buttons labeled Stop. Can display short event notifications; the per-tab event journal remains available in the popup even when notifications are OFF.
- Waits for the assistant's response to **start or end with** the configured text marker (default: !!!ГОТОВО!!!) or match an optional **Regex** at the beginning or end of the answer. **Leave the marker empty to continue after every finished assistant reply** (stable text + stop-generation button absent), with no Regex required. The follow-up is sent after the configured delay (**30 seconds by default**). The former 5-second default is automatically migrated to 30 seconds in saved tab settings; custom delay values are preserved.
- Optional local MP3 alert and a **Chatbot Mistake** dialog when an error phrase appears in a visible error/status element. Chat Watchdog explicitly ignores its own alert dialog and toast notifications when detecting errors; closing an alert cannot re-trigger it. Assistant error phrases are acknowledged once per logical chat turn, even when React rerenders the same reply. Closing the dialog (× or Escape) stops that tab's sound immediately. An unchanged visible error does not restart the alert, but the next appearance of an error triggers again even when the text is identical. The detector also handles a site recycling the same alert element by watching message replacement and visibility changes.
- Automatic detection for old and new ChatGPT layouts (role attributes, assistant search units, turn keys, or a guarded marker after the last user bubble), Claude, Gemini, and a basic DeepSeek adapter. Other UIs can use optional CSS selectors. Web-chat interfaces change; these selectors need real-browser verification.
- Per-site permission is requested **only when you switch ON** in that tab. No blanket permission at installation.
- No analytics, trackers, external scripts, network requests, or backend. Selected sounds stay in browser IndexedDB and **are not uploaded**.

## Install

1. Download or clone the repository.
2. In Chrome, open chrome://extensions and turn on Developer mode.
3. Click Load unpacked and select the folder containing manifest.json.
4. Open an AI chat and click the Chat Watchdog icon.
5. Choose an MP3 using the file picker and select a mode: **Автопродолжение + ошибки** or **Только ошибки — без отправки**. Configure the marker/delay/message only for auto mode, then turn ON.
6. Repeat independently in another tab. Settings are kept for each tab within the browser session.

For any local MP3 file, use the **file picker**. A file:// URL alone is not permission for a web page or extension to load its bytes.

## Safety and limitations

- The extension is **OFF by default**. The cooldown and reply journal are shared by all tabs with the same conversation URL within one installed extension. If several independent copies of Chat Watchdog are enabled in Chrome, disable all but one: different extension IDs do not share storage. Enabling skips an already-completed assistant response to avoid replaying old tasks; a new conversation with no responses is armed immediately, including for a very short first response.
- It never overwrites a nonempty input draft.
- Error-only mode leaves the chat's composer untouched and preserves existing error detection, dialog, audio and event journal. The main ON/OFF toggle remains independent of the mode selection.
- Before clicking Send, the extension obtains a one-time **assistant-reply ID** claim from the background service worker, serialized across **all tabs showing the same conversation** and persisted in Chrome session storage. The assistant's monotonic reply ordinal also blocks an old answer if its DOM ID changes and the timer has expired. If DOM history is virtualized and the count decreases, Watchdog conservatively refuses a send rather than risking duplicates. The ID is tied to the assistant reply (not the user's most recent message), so sending a new user bubble cannot rearm an old answer. A second independently enforced **global per-tab cooldown** also prevents rapid duplicates, even if another observer produces a different token.
- After sending a follow-up, the extension remembers both the assistant reply identifier and the logical user turn. Where the site does not expose a stable assistant identifier, an identical answer with the same visible assistant ordinal is conservatively treated as already processed. This avoids duplicates but may skip legitimately repeated identical replies on unsupported DOM layouts. It will not send twice if the SPA rerenders both the user message and the assistant reply. A genuinely new user turn can still trigger its own continuation. When no reliable user turn can be located, repeated identical replies are conservatively ignored.
- A small notification indicates a follow-up was sent. The extension never cuts text out of, or rewrites, ChatGPT's rendered messages because React could restore the changed DOM and the message is not actually changed on the server.
- It uses UI automation, not the AI provider's API, and does not guarantee that a response is correct or that a task has truly completed.
- Completion is detected by plain text or an end-anchored Regex at the **end of the last assistant message** (or no marker at all if the field is empty), stable text, an absent stop button, and optionally a user-provided completion element. An assistant message **must follow the most recent user message**; an old completed reply visible above a newly sent user turn can never cause another send.
- Errors are detected in toast/alert/status elements and as standalone lines in the **latest assistant response**. Merely quoting an error phrase within an ordinary sentence will not alarm. When upgrading older session settings, the newly supported error phrases are appended once; after migration they can be freely edited or removed. The default error list includes the exact Russian strings «Ошибка в потоке сообщений», «Нет ответа от ChatGPT. Проверьте подключение к интернету», «!!!ЕСТЬ ЗАДАНИЕ ДЛЯ АГЕНТА!!!», «!!!ЖДУ РЕШЕНИЕ!!!», «!!!У НАС ПРОБЛЕМА!!!», «!!НУЖНА ЛОКАЛЬНАЯ ПРОВЕРКА!!!».
- MP3 playback is subject to Chrome audio restrictions. An error alarm requires selecting a file for that tab.
- If an error occurs, close the page dialog with × or Escape to silence it. Switching the tab's Watchdog OFF also stops audio. Different tabs have independent audio players.
- Timers in background tabs may be throttled by Chrome. The minimum interval is counted from the last automatic Send click and is local to the tab; a full reload starts a fresh content-script instance. The saved event log is also in tab/page memory, and resets on page reload.
- In no-marker mode, a response must be stable for at least 4.5 seconds before the configured delay begins. Even then, no automatic action occurs while a Stop control is present. This cannot absolutely guarantee that an AI stream is finished if a site hides its Stop control while still generating.
- Per-tab settings are session-only, and turn OFF when the browser session ends or the tab navigates to a different origin. Local sound blobs are deleted on tab close.
- Built-in selectors are best-effort; unsupported sites require custom CSS selectors and manual testing.
- This is a local developer extension, not a Chrome Web Store release.

## Completion marker: optional, plain text or Regex

The default remains the literal `!!!ГОТОВО!!!` (Regex OFF). **An empty marker field now explicitly disables marker matching**: Chat Watchdog sends the follow-up after any new completed assistant answer. This requires detecting the latest assistant turn after the latest user turn; if ordering cannot be verified on a site, auto-send safely waits. When the marker is empty, the Regex toggle does not matter. Enable **Regex (регулярное выражение)** below the marker field to use a regular expression. You can enter a raw JavaScript regex or `/pattern/i` with optional flags. The match must touch the **very beginning or very end of the most recent assistant reply**; a phrase appearing in the middle does not trigger continuation.

### Recognize either the explicit marker or a final next-stage summary

Turn on Regex and paste:

```regex
(?:!!!ГОТОВО!!!|Следующий (?:этап|участок)[\s\S]{0,400})$
```

The `|` means **OR**. This recognizes `!!!ГОТОВО!!!`, `Следующий этап ...`, or `Следующий участок ...` at the end of the reply. The `{0,400}` bound allows up to 400 further characters after the next-stage phrase.

To use only the next-stage summary:

```regex
Следующий (?:этап|участок)[\s\S]{0,400}$
```

To ignore capitalization, wrap the combined pattern in slashes and add `i`:

```regex
/(?:!!!ГОТОВО!!!|Следующий (?:этап|участок)[\s\S]{0,400})$/i
```

Invalid regex patterns display a warning and never trigger auto-send. Regex is only evaluated against the final 4000 characters. This is a heuristic and could trigger before a task is genuinely complete; an explicit unique end marker remains more reliable.

## CSS selectors (advanced)

**Usually you can leave all these fields blank.** Chat Watchdog has built-in selectors for ChatGPT, Claude, Gemini, and a basic DeepSeek adapter. Enter a custom CSS selector only when the site layout has changed or you want to use another web chat. A custom value overrides the default for that field in the current tab.

### Example: ChatGPT

| Field in the extension | Example CSS selector |
| --- | --- |
| Assistant message / Сообщение ИИ | `[data-message-author-role="assistant"]` or `[data-content-search-unit-key$=":assistant"]` or `[data-turn-key]:not(:has([data-user-message-bubble="true"]))` |
| Message editor / Поле ввода | `#prompt-textarea` or `#pending-conversation-input` (as in the newer browser composer) |
| Send button / Кнопка отправки | `button[data-testid="send-button"]` or `button[aria-label="Отправить"]` |
| Stop button / Кнопка остановки | `button[data-testid="stop-button"]` |
| Completion element / Элемент завершения | Leave blank; optional extra signal |
| Error element / Элемент ошибки | `[role="alert"], [role="status"]` |

These are **examples**, not a guarantee that every version of ChatGPT uses the same HTML. A saved **View Source** page may only show the initial page shell and not dynamically rendered assistant messages; inspect the live **Elements** panel when diagnosing assistant selectors. The extension already includes selectors for ChatGPT, so you do not need to copy this table into its settings unless troubleshooting.

### How to find a selector yourself

1. Open the chat in Chrome.
2. Right-click the element you want to detect, for example the **Send** button, and choose **Inspect** (Просмотреть код).
3. In DevTools, inspect attributes such as `id`, `data-testid`, or `aria-label`. For example:

   ```html
   <button data-testid="send-button">...</button>
   ```

4. Enter the corresponding **CSS selector**, not the whole HTML tag:

   ```css
   button[data-testid="send-button"]
   ```

5. Alternatively, right-click the highlighted element in the **Elements** panel and select **Copy → Copy selector**. Beware: automatically generated selectors often contain temporary classes or positional fragments and may break after a site update.

### Test a selector in Chrome

Open **DevTools → Console** and run:

```javascript
document.querySelectorAll('button[data-testid="send-button"]')
```

- If Chrome returns elements, the selector currently matches them.
- If Chrome returns `NodeList []`, there are no matches **right now**. The selector may be incorrect *or* the element may be temporarily absent.
- For example, a **Stop** button generally appears only during generation. Test while the assistant is replying.
- You can list alternatives separated by commas: `button[data-testid="send-button"], button[aria-label="Отправить"]`.
- If you see a syntax error in the console, the CSS selector itself is invalid.

**What each field controls:** Assistant message identifies the text to examine for the completion marker; Message editor is where the follow-up is entered; Send button submits it; Stop button indicates generation is ongoing; Completion element is an optional extra required signal (leave it blank by default); Error element limits where error phrases are searched (e.g. visible alerts and status messages). Error phrases are configured separately, one per line.

## Troubleshooting a marker that does not send

Open **Chat Watchdog → CSS-селекторы (необязательно) → Проверить элементы чата** while viewing the conversation. The diagnostic checks only the current tab and reports element counts and booleans; it does not copy or upload conversation text.

If a message was already sent for the current reply, the diagnostic reports this as a previously submitted marker; it is not treated as a new task.

Expected in an idle chat after a new assistant message ending with the marker: **Сообщений ИИ** greater than zero, **Маркер** = ДА, **Редактор** = найден, **Поле пустое** = да, **Кнопка отправки активна** = да and **Кнопка остановки видна** = нет. The waiting flag appears while the configured delay is counting down. If the assistant count is zero, check the additional counters for legacy roles, search-unit keys, turn keys, and user bubbles. You may need to inspect a *live assistant reply* (not the composer) and configure its CSS selector. If a stale custom selector was entered, clear it to use automatic detection. The generic marker fallback only runs when the DOM confirms the latest user message and the candidate marker is after it; it deliberately refuses to send when message ownership cannot be determined.

Note that the HTML source of a ChatGPT page can contain only the initial app shell. For a JavaScript error, copy its complete message and source file from Chrome DevTools → Console.

## Check

Run: node --test

## Permissions

- storage: per-tab settings in chrome.storage.session.
- scripting + activeTab: run the tab monitor after the user enables it.
- offscreen: play audio without opening a new visible browser tab.
- optional_host_permissions: supports sites you may add later, **granted one origin at a time by an explicit click**. It does not automatically access every website.

Licensed under MIT.
