# DOM research — Gemini web & Google AI Studio

Owner: C. Date: **2026-10-11**. Output: `extension/content/selectors.js`
(`DSG.SELECTORS`), fixtures `test/fixtures/gemini-chat.html`,
`test/fixtures/aistudio-chat.html`.

## How this was researched

| Site | Method | Status |
| --- | --- | --- |
| Gemini web | Live inspection with `agent-browser`, **fresh isolated browser, no profile, logged out** (incognito-equivalent temp user-data-dir), system Chrome 154, Korean UI, default logged-out model "3.5 Flash-Lite". One harmless prompt sent; DOM sampled every 250 ms during streaming and after completion. | **Live-verified** (except thoughts panel) |
| AI Studio | Login required. The user does **not** want their Google account used, so the user's Chrome profile was **never opened**. Selectors come from open-source automation code only. | **OSS, not live-verified** |

The bundled agent-browser Chrome (`~/.agent-browser/browsers/chrome-153…`) is
blocked by Windows application-control policy on this machine; use
`AGENT_BROWSER_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"`.

OSS sources (latest commit date checked 2026-10-11):

| Repo | Date | Used for |
| --- | --- | --- |
| `chiimagnus/SyncNos` — `src/collectors/googleaistudio/*`, tests | 2026-10-04 commit on the AI Studio collector | AI Studio turn structure, `.turn-content`, `ms-thought-chunk`/`.thought-panel`, `ms-code-block[data-test-language]`, `ms-katex pre>code`, `.author-label`, `ms-run-button .stoppable-spinner/.stoppable-stop`, URL id rules |
| `lumingya/universal-web-api` — `config/sites/aistudio.google.com.json`, `gemini.google.com.json` | adapter_version 2026.09.26 | AI Studio input/run/stop (`ms-run-button button[type=submit|button]`), `ms-text-chunk`/`ms-prompt-chunk`; Gemini logged-in stop variant `.blue-circle.stop-icon` |
| `voyager-crew/voyager` (ex gemini-voyager) | 2026-10-10 | Gemini thoughts (`model-thoughts`, `.thoughts-container`, `.thoughts-content`, `.thoughts-header`); "expanded thoughts render their own message-content first"; AI Studio `[data-turn-role]`, composer; send-key behaviour |
| `CJackHwang/AIstudioProxyAPI` — `config/selectors.py` | 2026-04-22 | AI Studio input wrappers, Run/Stop aria-labels, `ms-thought-chunk`, code-block header spans |
| `afumu/openlink`, `Crazy-ChenMiLin/intense-rp-next` | 2026-03 / 2026-05 | AI Studio system instructions (`button[data-test-system-instructions-card]`, `textarea[aria-label="System instructions"]`, `.in-run-settings`, `button[data-test-close-button]`) |
| `SNiPERxDD/Frankenreview` | selectors verified 2026-02 | Claims `data-turn-role` was removed → `.chat-turn-container.model` is the primary model-turn marker |
| `IvanSkainet/arena-agent` | 2026-10-09 | Confirms `ms-chat-turn` + `data-turn-role` usage in some builds |

## Gemini web — verified live

### Structure

```
chat-window
  #chat-history.chat-history-scroll-container
    infinite-scroller[data-test-id=chat-history-container]
      div.conversation-container#<16-hex response id>        (one per exchange)
        user-query > … .query-text > h5.cdk-visually-hidden("말씀하신 내용") + p.query-text-line*
        model-response
          response-container > .response-container
            .response-container-header > … .response-container-header-processing-state
            .presented-response-container > .response-container-content > .response-content
              thinking-overlay                       (empty for non-thinking model)
              .model-response-label-announcer > h6.cdk-visually-hidden("Gemini의 응답")
              model-response-content > structured-content-container.model-response-text
                message-content#message-content-id-r_<id>
                  div.markdown.markdown-main-panel[aria-busy][aria-live=polite]
                    response-element > code-block > div.code-block > …
                      div.code-block-decoration > span("코드 스니펫") + div.buttons(download, copy)
                      pre > code[data-test-id=code-content].code-container
              div.response-footer.gap(.complete)
            .response-container-footer > message-actions (regenerate / copy / more)
input-area-v2 > … rich-textarea.ql-container > div.ql-editor[contenteditable][role=textbox]
  … .trailing-actions-wrapper > .input-buttons-wrapper-bottom >
      [data-test-id=send-button-container] > gem-icon-button.send-button(.submit|.stop) > button
```

- **User text is not markdown-rendered**: each line is a `p.query-text-line`;
  a fenced block pasted by the user never becomes `<pre>`. Only scan
  `model-response`.
- **Code language label is lost** for unknown languages: a ```` ```devspace ````
  block is labelled with the localized generic "코드 스니펫" ("Code snippet").
  The fence label is only a hint (as the spec already assumes).
- `code[data-test-id=code-content]` textContent is the raw code plus a trailing `\n`.
- `mat-icon`s use `fonticon="…"` with **empty** text now — no ligature
  pollution from icons. But `.markdown` textContent does include the
  code-block header label ("코드 스니펫") and the turn contains visually-hidden
  headings ("Gemini의 응답"); both are in `exclude`.
- Conversation id: URL changes from `/app` to `/app/<16 hex>` right after the
  first send (observed `/app/4b07f16c074c5252` within 4 s, before the answer).

### Generating / complete detection (observed timeline)

| t (ms after click) | Observation |
| --- | --- |
| 0 | `gem-icon-button.send-button.has-input.submit`, icon `arrow_upward`, label "메시지 보내기" |
| 250 | same element: `.submit`/`.has-input` removed, **`.stop` added**, icon `stop`, label "대답 생성 중지"; `user-query` appended |
| 4 200 | `model-response` appears; `.markdown[aria-busy=true]` + class `animate`; `response-element.first-token.animating`; `.response-footer` **without** `complete`; `.response-container-footer` empty |
| 5 500 | **send-button-container removed entirely** (editor empty ⇒ no send slot at all) |
| ≤ 9 000 | `.markdown[aria-busy=false]`, no `.animating`, `.response-footer.complete`, `message-actions` rendered |

Strategy for B (encoded in `selectors.js`):
- generating ⇔ `stopButton` visible **or** `generatingIndicator`
  (`.markdown-main-panel[aria-busy=true]`, `response-element.animating`);
- complete ⇔ none of the above **and** `turnComplete`
  (`.response-footer.complete` / `message-actions`) present in the latest
  `model-response` **and** text stable ≥ 1.5 s.
- The stop button vanished ~3.5 s *before* the footer completed, so
  stop-button absence alone is not sufficient — use `turnComplete`.

### Input method (tested live)

| Method | Result |
| --- | --- |
| `editor.focus(); document.execCommand('insertText', false, text)` | **Works.** Quill model updates (`ql-blank` removed), send slot appears; clicking `[data-test-id=send-button-container] button` via `.click()` **sent the message** (verified). Newlines → one `<p>` per line; leading spaces and tabs preserved. |
| Same, large multi-line text | Slow: 200 lines ≈ 3.5 s, 600 lines ≈ 15 s (synchronous, blocks the page). |
| Hard cap | **32,000 characters** (newlines count); excess is silently dropped. Spec default `maxMessageChars.gemini = 24000` is safely under it. |
| Synthetic `ClipboardEvent('paste')` with DataTransfer | **Ignored** (untrusted event; nothing inserted). Long-paste-to-attachment conversion therefore cannot be triggered by script (and did not occur with insertText up to 32k). |
| Build `<p>` nodes with `createElement`/`textContent`, `editor.replaceChildren(...)`, dispatch `input` | Inserts 300 lines in ~2 ms; Quill accepts it (`ql-blank` cleared, send button shows, a following `insertText` stays consistent). **Not verified that the sent message contains it** (would have required a second prompt). Fast-path candidate for long results; fall back to insertText. |
| Clearing | `execCommand('selectAll')` + `delete` failed once with big content; **select a Range over `editor` contents, then `execCommand('delete')`** worked reliably. |

Other notes:
- The page enforces **Trusted Types**: `innerHTML =` / `DOMParser` on page-world
  strings throw ("requires 'TrustedHTML' assignment"). Content scripts run in an
  isolated world, but to be safe build DOM with `createElement`/`textContent`
  only (the extension's panel uses Shadow DOM anyway).
- The send slot (`[data-test-id=send-button-container]`) exists **only while
  the editor has text**; after inserting text, poll briefly (Angular renders
  it on the next tick) before clicking.
- Keyboard: Enter sends, Shift+Enter newline (OSS: voyager offers a
  "Ctrl+Enter to send" override, implying Enter is the default). Not tested
  live (would have needed a second send).
- Logged-out: chatting works without sign-in; model menu shows only
  "3.5 Flash-Lite" enabled ("3.6 Flash" and "3.1 Pro" disabled), so **thinking
  models / the thoughts panel could not be observed**. The `model-thoughts`
  selectors are OSS-derived; `thinking-overlay` (empty) was observed live.
- Logged-in UI may differ: universal-web-api (2026-09, logged-in, zh UI) uses
  `.blue-circle.stop-icon mat-icon[data-mat-icon-name=stop]` for stop — included
  as a fallback.

## Google AI Studio — OSS, not live-verified

Everything in `DSG.SELECTORS.aistudio` and `test/fixtures/aistudio-chat.html`
is reconstructed from the OSS sources above and **must be checked on the live
site** (by the user, logged in) before relying on it.

### Structure (per OSS)

```
.chat-session-content (inside ms-autoscroll-container)
  ms-chat-turn#<id>
    div.chat-turn-container.render.(user|model)
      div.virtual-scroll-container.(user|model)-prompt-container[data-turn-role=User|Model]  (attr may be gone)
        div.turn-content
          div.author-label[role=heading] + span.timestamp
          ms-prompt-chunk > ms-thought-chunk > mat-accordion > mat-expansion-panel.thought-panel …   (thoughts)
          ms-prompt-chunk > ms-text-chunk > ms-cmark-node.cmark-node …                              (answer)
            ms-code-block[data-test-language=<lang>] > mat-expansion-panel >
              mat-expansion-panel-header (mat-panel-title: span.material-symbols-outlined + span(<Lang>); toolbar buttons)
              … pre > code
            ms-katex > pre > code          (math — NOT a code block)
    .actions-container (rerun / edit / ms-chat-turn-options)
footer > ms-prompt-input-wrapper > … ms-chunk-input > ms-autosize-textarea > textarea[formcontrolname=promptText]
  ms-run-button > button[type=submit] "Run" (Ctrl+Enter)   →  while generating: button[type=button] "Stop" with .stoppable-spinner/.stoppable-stop
button[data-test-system-instructions-card]  →  panel with textarea[aria-label="System instructions"].in-run-settings + button[data-test-close-button]
```

### Generating / complete detection

- generating ⇔ `ms-run-button` contains `.stoppable-spinner` / `.stoppable-stop`,
  or its button is `type=button` / aria-label "Stop generating".
- `turnComplete` is **deliberately not defined**: no source shows a
  completion-only element (edit/rerun buttons are hover-dependent). Rely on
  stop absence + 1.5 s text stability. Frankenreview: "complete only after the
  latest model turn stabilizes and Stop/active Thinking indicators disappear;
  do not require Run to re-enable."
- Thought panels may keep a progress icon after thinking ends; it is not used
  as a generating signal.

### Input method

- Plain `<textarea>`: set via the native setter
  `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta, text)`
  then `ta.dispatchEvent(new Event('input',{bubbles:true}))` (AIstudioProxyAPI,
  openlink). Then click `ms-run-button button[type=submit]` once it is enabled
  (it is disabled while empty), or press **Ctrl+Enter**. **Enter inserts a
  newline** (voyager adds an opt-in "Enter sends" for AI Studio).
- System instructions: click `systemInstructionsOpen`, wait ~600 ms, set
  `systemInstructionsInput` the same way, then click `systemInstructionsClose`
  (extra key in selectors.js).
- Code language: `ms-code-block[data-test-language]` attribute (exposed as the
  extra key `codeLanguageAttr`) is more reliable than the header label text.

### Quirks / risks (AI Studio)

- **KaTeX renders as `ms-katex > pre > code`** — the `codeBlock` selectors and
  `exclude` skip it; a naive `pre code` scan would pick math up.
- Code-block header toolbar uses `span.material-symbols-outlined` ligatures:
  textContent of the whole block reads like "code Devspace download
  content_copy expand_less {…}". Use `ms-code-block pre code`, never the wrapper.
- User turns *are* markdown-rendered in AI Studio (a pasted example block
  becomes an `ms-code-block`) — scan model turns only.
- Virtual scrolling: off-screen turns may have an empty `.turn-content`; the
  latest turn is normally rendered. Baselining historic turns should key on
  `ms-chat-turn[id]`, not content.
- UI language: AI Studio aria-labels in the OSS are English; Korean label
  fallbacks in selectors.js are guesses.
- `/prompts/new_chat` (and other `new_*`) has no id; the id appears after the
  first run (autosave on). With autosave off / temporary chat, there may be no
  id at all — B should fall back to the path.

## Cross-site risks

- Google ships UI changes frequently (Gemini's `input-area-v2`,
  `enable-lr26-*` flags indicate active A/B rollouts). Everything is ordered
  with stable custom-element tags / `data-test-id` first; Angular `ng-tns-*`
  classes are never used.
- Logged-in Gemini may differ from the logged-out DOM observed (stop-button
  styling, thinking models, Gems, Canvas, deep research panels).
- Thinking models (Gemini) not observed live; if thoughts render elsewhere
  than `model-thoughts`/`.thoughts-*`, tool calls in thoughts could be picked
  up — the `:not(model-thoughts *)` guards on `turnBody` plus `exclude` are the
  defence.
- Fixtures strip Angular noise attributes; selectors that depend on them
  would pass fixtures but fail live — none in selectors.js do.

## Fixture usage (for E2E mock pages)

Both fixtures render the **completed** state in `<body>`; alternate states are
inert `<template>`s to clone in:
- `gemini-chat.html`: `tpl-send-slot-idle`, `tpl-send-slot-generating`
  (append into `.input-buttons-wrapper-bottom`), `tpl-model-response-streaming`
  (append into `.conversation-container`), `tpl-model-thoughts` (prepend into
  `.response-content`; contains a decoy tool call that must NOT run).
- `aistudio-chat.html`: `tpl-run-button-generating` (replace `ms-run-button`),
  `tpl-system-instructions-open` (append to body). The model turn already
  contains a thought decoy, a KaTeX `pre>code` decoy, and the user turn a
  pasted devspace block decoy.

Validated 2026-10-11 by loading each fixture plus `selectors.js` in Chrome and
simulating B's lookup: all selectors parse; only the real
`{"tool":"list_dir",…}` block is found in each latest model turn (thought /
KaTeX / user decoys ignored); stop/generating/complete states toggle as
expected; `conversationIdFromUrl` returns the id for `/app/<hex>`,
`/u/1/app/<hex>`, `/gem/<g>/<hex>`, `/prompts/<id>` and `null` for `/app`,
`/prompts/new_chat`.
