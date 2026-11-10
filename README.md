# Chat Watchdog

A small, local Chrome/Chromium Manifest V3 extension for continuing AI chat tasks automatically.

## Features

- Independent ON/OFF and configuration for **each browser tab**, even for two tabs on the same AI website.
- Waits for the assistant's response to **end with** the configured text marker (default: !!!ГОТОВО!!!) or match an optional **Regex** at the end of the answer, and for the stop-generation control to disappear; then sends the configured follow-up after the chosen delay (5 seconds by default).
- Optional local MP3 alert and a **Chatbot Mistake** dialog when an error phrase appears in a visible error/status element. Closing the dialog (× or Escape) stops that tab's sound immediately. An unchanged visible error does not restart the alert, but the next appearance of an error triggers again even when the text is identical. The detector also handles a site recycling the same alert element by watching message replacement and visibility changes.
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

For any local MP3 file, use the **file picker**. A file:// URL alone is not permission for a web page or extension to load its bytes.

## Safety and limitations

- The extension is **OFF by default**. Enabling skips an already-completed assistant response to avoid replaying old tasks; a new conversation with no responses is armed immediately, including for a very short first response.
- It never overwrites a nonempty input draft.
- It uses UI automation, not the AI provider's API, and does not guarantee that a response is correct or that a task has truly completed.
- Completion is detected by plain text or an end-anchored Regex at the **end of the last assistant message**, stable text, an absent stop button, and optionally a user-provided completion element.
- Errors are detected in toast/alert/status elements, not every mention of error words inside chat history.
- MP3 playback is subject to Chrome audio restrictions. An error alarm requires selecting a file for that tab.
- If an error occurs, close the page dialog with × or Escape to silence it. Switching the tab's Watchdog OFF also stops audio. Different tabs have independent audio players.
- Timers in background tabs may be throttled by Chrome.
- Per-tab settings are session-only, and turn OFF when the browser session ends or the tab navigates to a different origin. Local sound blobs are deleted on tab close.
- Built-in selectors are best-effort; unsupported sites require custom CSS selectors and manual testing.
- This is a local developer extension, not a Chrome Web Store release.

## Completion marker: plain text or Regex

The default remains the literal `!!!ГОТОВО!!!` (Regex OFF). Enable **Regex (регулярное выражение)** below the marker field to use a regular expression. You can enter a raw JavaScript regex or `/pattern/i` with optional flags. The match must reach the **end of the most recent assistant reply**; a phrase appearing earlier does not trigger continuation.

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
| Assistant message / Сообщение ИИ | `[data-message-author-role="assistant"]` |
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

Expected in an idle chat after a new assistant message ending with the marker: **Сообщений ИИ** greater than zero, **Маркер** = ДА, **Редактор** = найден, **Поле пустое** = да, **Кнопка отправки активна** = да and **Кнопка остановки видна** = нет. The waiting flag appears while the configured delay is counting down. If the assistant count is zero, inspect a *live assistant reply* (not the composer) and configure its CSS selector.

Note that the HTML source of a ChatGPT page can contain only the initial app shell. For a JavaScript error, copy its complete message and source file from Chrome DevTools → Console.

## Check

Run: node --test

## Permissions

- storage: per-tab settings in chrome.storage.session.
- scripting + activeTab: run the tab monitor after the user enables it.
- offscreen: play audio without opening a new visible browser tab.
- optional_host_permissions: supports sites you may add later, **granted one origin at a time by an explicit click**. It does not automatically access every website.

Licensed under MIT.
