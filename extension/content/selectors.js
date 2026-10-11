/*
 * GemInWeb — DOM selectors for Google AI Studio and Gemini web.
 * Owner: C (DOM research). Evidence and strategy: docs/dom-research.md
 * Researched 2026-10-11.
 *
 * Shape (docs/SPEC.md "Extension"): DSG.SELECTORS = { aistudio: {...}, gemini: {...} }.
 * Every key holds an ORDERED array of CSS selectors; the first one that matches
 * wins. `:has()` and complex `:not()` are used (Chrome 105+). Locale-independent
 * selectors (tags, classes, data-*, mat-icon[fonticon]) come first; English and
 * Korean aria-label variants are last-resort fallbacks.
 * `conversationIdFromUrl` is a RegExp source string with exactly one capture
 * group; it works on either `location.pathname` or the full `location.href`.
 *
 * Evidence tags used in comments:
 *   [LIVE]  observed on the live site 2026-10-11 (Gemini, logged-out, ko UI)
 *   [OSS]   taken from actively maintained open-source automation code
 *           (see docs/dom-research.md for repo + date); NOT live-verified
 *   [GUESS] plausible fallback, unverified
 *
 * Extra keys beyond the spec (B may ignore them):
 *   aistudio.systemInstructionsClose — closes the system-instructions panel.
 *   *.codeLanguageAttr — attribute on the code-block wrapper that carries the
 *     fence language (AI Studio only; more reliable than any label text).
 */
(function () {
  'use strict';
  var g = globalThis;
  g.DSG = g.DSG || {};

  g.DSG.SELECTORS = {
    /* ------------------------------------------------------------------ */
    /* Google AI Studio  (https://aistudio.google.com/prompts/...)         */
    /* NOTHING here is live-verified: the user does not want their Google  */
    /* account used, and AI Studio requires login. All entries are [OSS].  */
    /* ------------------------------------------------------------------ */
    aistudio: {
      // [OSS] Plain <textarea> (Angular cdkTextareaAutosize). Set it with the
      // native HTMLTextAreaElement value setter + bubbling 'input' event.
      // AIstudioProxyAPI 2026-04, universal-web-api 2026-09, voyager 2026-10.
      input: [
        'ms-prompt-input-wrapper textarea',
        'ms-chunk-input textarea',
        'ms-prompt-box textarea',
        'textarea[formcontrolname="promptText"]',
        'ms-autosize-textarea textarea',
        'textarea[aria-label="Enter a prompt"]',
        'textarea[aria-label*="prompt" i]',
        'textarea[aria-label*="프롬프트"]' // [GUESS] Korean UI
      ],

      // [OSS] Run button is a type=submit button inside <ms-run-button>; while
      // generating the same slot becomes a type=button "Stop" button, so the
      // [type=submit] filter keeps Send from matching the Stop state.
      // Keyboard alternative: Ctrl+Enter (Enter inserts a newline).
      sendButton: [
        'ms-run-button button[type="submit"]',
        'button[mattooltipclass="run-button-tooltip"][type="submit"]',
        'button.ctrl-enter-submits',
        'ms-run-button button:not(:has(.stoppable-spinner)):not(:has(.stoppable-stop))',
        'button[aria-label="Run"]',
        'button[aria-label="실행"]' // [GUESS] Korean UI
      ],

      // [OSS] universal-web-api 2026-09: `ms-run-button button[type="button"]`;
      // SyncNos 2026-10: `.stoppable-spinner` / `.stoppable-stop` inside
      // ms-run-button; AIstudioProxyAPI: aria-label "Stop generating".
      stopButton: [
        'ms-run-button button:has(.stoppable-stop)',
        'ms-run-button button:has(.stoppable-spinner)',
        'ms-run-button button[type="button"]',
        'button[aria-label="Stop generating"]',
        'ms-run-button button[aria-label*="Stop" i]',
        'ms-run-button button[aria-label*="중지"]' // [GUESS] Korean UI (scoped to the composer)
      ],

      // [OSS] Extra "busy" signals. Deliberately NOT including thought-panel
      // icons (.thinking-progress-icon) because they may persist after the
      // thought finishes and would block the loop forever.
      generatingIndicator: [
        'ms-run-button .stoppable-spinner',
        'ms-run-button .stoppable-stop',
        'ms-run-button span.spin'
      ],

      // [OSS] Each turn is <ms-chat-turn id="..."> containing
      // div.chat-turn-container.(user|model). Older/other builds also carry
      // [data-turn-role="User"|"Model"] (Frankenreview 2026-02 says that
      // attribute was removed; SyncNos 2026-10 still accepts it).
      turn: ['ms-chat-turn'],
      modelTurn: [
        'ms-chat-turn:has(> .chat-turn-container.model)',
        'ms-chat-turn:has(.chat-turn-container.model)',
        '.chat-turn-container.model',
        'ms-chat-turn:has([data-turn-role="Model"])',
        '[data-turn-role="Model"]',
        '.model-prompt-container'
      ],
      userTurn: [
        'ms-chat-turn:has(> .chat-turn-container.user)',
        'ms-chat-turn:has(.chat-turn-container.user)',
        '.chat-turn-container.user',
        'ms-chat-turn:has([data-turn-role="User"])',
        '[data-turn-role="User"]',
        '.user-prompt-container'
      ],

      // [OSS] .turn-content holds the rendered markdown (ms-cmark-node tree,
      // ms-code-block, ms-katex) AND the ms-thought-chunk, so `exclude` must
      // be applied to it. AI Studio virtualises off-screen turns: their
      // .turn-content can be empty until scrolled into view.
      turnBody: [
        '.chat-turn-container.model .turn-content',
        '[data-turn-role="Model"] .turn-content',
        '.turn-content',
        'ms-prompt-chunk',
        'ms-text-chunk'
      ],

      // [OSS] Real code blocks are <ms-code-block data-test-language="..."> >
      // mat-expansion-panel > pre > code. KaTeX math ALSO renders as
      // ms-katex > pre > code — never treat that as a code block.
      codeBlock: [
        'ms-code-block pre code',
        'ms-code-block pre',
        'pre:not(ms-katex pre) > code',
        'pre:not(ms-katex pre)'
      ],
      // [OSS] Language label is the non-icon span in the expansion header.
      // Prefer the attribute (codeLanguageAttr) on the ms-code-block wrapper.
      codeLanguage: [
        'ms-code-block mat-panel-title span:not(.material-symbols-outlined):not(mat-icon)',
        'ms-code-block .mat-expansion-panel-header-title span:not(.material-symbols-outlined)'
      ],
      codeLanguageAttr: ['data-test-language'],

      // [OSS] Subtrees to drop before reading text / looking for code:
      // thoughts, code-block toolbar (its material-symbols ligatures read as
      // "download content_copy expand_less"), author/timestamp chrome,
      // KaTeX, per-turn action buttons.
      exclude: [
        'ms-thought-chunk',
        '.thought-panel',
        'mat-accordion:has(ms-thought-chunk)',
        'ms-code-block mat-expansion-panel-header',
        '.material-symbols-outlined',
        'mat-icon',
        '.author-label',
        '.timestamp',
        'ms-katex',
        'ms-chat-turn-options',
        '.actions-container',
        '.turn-footer',
        'button'
      ],

      // turnComplete: intentionally omitted for AI Studio. No OSS source shows
      // an element that appears only after completion and never otherwise
      // (candidates such as `.actions-container button.toggle-edit-button`
      // are hover-dependent). Rely on stopButton/generatingIndicator absence
      // + 1.5 s text stability (spec loop rule).

      // [OSS] openlink (2026-03) + intense-rp-next (2026-05).
      systemInstructionsOpen: [
        'button[data-test-system-instructions-card]',
        'button.system-instructions-card',
        '[data-test-id="system-instructions-card"]',
        '.system-instructions-card button',
        '.system-instructions-card',
        'button[aria-label="System instructions"]',
        'button[aria-label*="시스템"]' // [GUESS] Korean UI
      ],
      systemInstructionsInput: [
        'textarea[aria-label="System instructions"]',
        'textarea.in-run-settings',
        'ms-system-instructions textarea',
        '.system-instructions textarea',
        'textarea[aria-label*="시스템"]' // [GUESS] Korean UI
      ],
      systemInstructionsClose: [
        'button[data-test-close-button]',
        '[data-test-close-button]'
      ],

      // [OSS] Saved chats live at /prompts/<id>; /prompts/new_chat (and
      // new_comparison, new_image, ...) have no id yet. Optional /u/<n>/.
      conversationIdFromUrl: '/prompts/(?!new_)([A-Za-z0-9_-]{6,})'
    },

    /* ------------------------------------------------------------------ */
    /* Gemini web  (https://gemini.google.com/app)                         */
    /* Live-inspected 2026-10-11, logged-out, Korean UI, "3.5 Flash-Lite". */
    /* ------------------------------------------------------------------ */
    gemini: {
      // [LIVE] Quill editor: rich-textarea > div.ql-editor[contenteditable]
      // [role=textbox]. document.execCommand('insertText') works and Quill
      // picks it up; clicking Send afterwards sent the message. Hard cap
      // 32,000 chars (excess silently dropped).
      input: [
        'rich-textarea .ql-editor[contenteditable="true"]',
        '.ql-editor[contenteditable="true"][role="textbox"]',
        'input-area-v2 [contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][role="textbox"]'
      ],

      // [LIVE] The send slot only EXISTS when the editor is non-empty:
      // [data-test-id="send-button-container"] > gem-icon-button.send-button
      // (.submit while idle-with-text, .stop while generating) > button.
      // Icon: mat-icon[fonticon="arrow_upward"]. aria-label ko "메시지 보내기".
      // Keyboard alternative: Enter (Shift+Enter = newline) [OSS].
      sendButton: [
        '[data-test-id="send-button-container"] gem-icon-button.send-button.submit:not(.stop) button',
        'gem-icon-button.send-button.submit:not(.stop) button',
        'gem-icon-button.send-button:not(.stop) button:has(mat-icon[fonticon="arrow_upward"])',
        'button:has(mat-icon[fonticon="arrow_upward"])',
        'button.send-button:not(.stop)', // [OSS] older layout
        'button:has(mat-icon[fonticon="send"])', // [OSS] older layout
        'button[aria-label="메시지 보내기"]',
        'button[aria-label="Send message"]'
      ],

      // [LIVE] While generating the same slot gets class `stop`, the icon
      // becomes mat-icon[fonticon="stop"], aria-label ko "대답 생성 중지".
      // `.blue-circle.stop-icon` is the logged-in variant per
      // universal-web-api 2026-09 [OSS].
      // Fallbacks are scoped to the composer (input-area-v2 [LIVE]; input-container /
      // .input-area-container [GUESS] for other layouts) so an unrelated "stop" control elsewhere
      // on the page can never wedge the loop in "generating".
      stopButton: [
        '[data-test-id="send-button-container"] gem-icon-button.send-button.stop button',
        'gem-icon-button.send-button.stop button',
        ':is(input-area-v2, input-container, .input-area-container) button:has(mat-icon[fonticon="stop"])',
        ':is(input-area-v2, input-container, .input-area-container) button:has(.blue-circle.stop-icon)',
        ':is(input-area-v2, input-container, .input-area-container) .blue-circle.stop-icon',
        ':is(input-area-v2, input-container, .input-area-container) button.send-button.stop',
        'button[aria-label="대답 생성 중지"]',
        'button[aria-label="Stop response"]' // [GUESS] English UI
      ],

      // [LIVE] During streaming: the answer's .markdown has aria-busy="true"
      // and the response-element carries `.animating`; both clear on
      // completion. NOTE the stop button disappeared ~3.5 s BEFORE the
      // footer/action bar rendered, so also wait for turnComplete.
      generatingIndicator: [
        'model-response:last-of-type .markdown-main-panel[aria-busy="true"]',
        '.markdown-main-panel[aria-busy="true"]',
        'model-response response-element.animating',
        ':is(input-area-v2, input-container, .input-area-container) mat-icon[data-mat-icon-name="stop"]'
      ],

      // [LIVE] Turns: <user-query> and <model-response> are siblings inside
      // div.conversation-container#<response-id> under
      // infinite-scroller[data-test-id="chat-history-container"]. The comma
      // selector returns them in document order.
      turn: ['user-query, model-response'],
      modelTurn: ['model-response'],
      userTurn: ['user-query'],

      // [LIVE] message-content#message-content-id-r_<id> >
      // div.markdown.markdown-main-panel. [OSS] voyager: an EXPANDED thoughts
      // panel renders its own message-content before the real one, hence the
      // :not(model-thoughts *) guards.
      turnBody: [
        'structured-content-container.model-response-text message-content .markdown-main-panel:not(model-thoughts *):not(.thoughts-container *)',
        'message-content .markdown-main-panel:not(model-thoughts *):not(.thoughts-container *)',
        'message-content:not(model-thoughts *):not(.thoughts-container *)',
        '.markdown-main-panel:not(model-thoughts *)'
      ],

      // [LIVE] code-block > div.code-block > ... > pre > code.code-container
      // [data-test-id="code-content"]; textContent is the raw code (+ "\n").
      codeBlock: [
        'code-block code[data-test-id="code-content"]',
        'code-block pre code',
        'pre code',
        'pre'
      ],
      // [LIVE] Header text in .code-block-decoration > span. For unknown
      // fence languages (e.g. ```devspace) it shows a LOCALISED generic
      // label ("코드 스니펫" = "Code snippet"), so the label is only a hint.
      codeLanguage: [
        'code-block .code-block-decoration > span',
        '.code-block-decoration > span'
      ],

      // [LIVE] mat-icons currently use fonticon="..." with EMPTY text, but the
      // code-block header label ("코드 스니펫") and the visually-hidden
      // "Gemini의 응답"/"말씀하신 내용" headings DO pollute textContent.
      // [OSS] thoughts: model-thoughts / .thoughts-container / .thoughts-content.
      exclude: [
        'model-thoughts',
        '.thoughts-container',
        '.thoughts-content',
        'thinking-overlay',
        '.code-block-decoration',
        '.cdk-visually-hidden',
        'message-actions',
        '.response-container-footer',
        '.response-footer',
        'sources-list',
        'mat-icon',
        'button'
      ],

      // [LIVE] Present only after the turn finished: `.response-footer`
      // gains class `complete` and <message-actions> (regenerate/copy/more)
      // is rendered. During streaming the footer exists without `complete`
      // and message-actions is absent.
      turnComplete: [
        '.response-footer.complete',
        'message-actions .actions-container-v2',
        'message-actions'
      ],

      // [LIVE] /app/<16 hex> after the first send (logged-out observed
      // /app/4b07f16c074c5252). [OSS/GUESS] Gems: /gem/<gemId>/<convId>;
      // multi-account prefix /u/<n>/.
      conversationIdFromUrl: '/(?:app|gem/[^/?#]+)/([0-9a-f]{8,})'
    }
  };
})();
