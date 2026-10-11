/* GemInWeb E2E — fake AI Studio "model" injected into test/fixtures/aistudio-chat.html
 * by test/e2e/run-mock.mjs. Runs in the page main world (not the extension).
 *
 * Behaviour (mirrors the AI Studio DOM described in docs/dom-research.md):
 * - Run button (ms-run-button button[type=submit]) is disabled while the textarea is empty;
 *   clicking it or Ctrl+Enter in the textarea "sends": a user turn is appended (markdown fences
 *   rendered as ms-code-block, like AI Studio does), the textarea is cleared, ms-run-button turns
 *   into the Stop/spinner state, the model turn streams in (partial → full) and after ~1.2 s the
 *   Run button comes back.
 * - /prompts/new_chat gets an id (history.replaceState) shortly after the first send (autosave).
 * - Conversations are saved in localStorage so a reload re-renders history (baseline test).
 * - /prompts/seeded_* keeps the fixture's historic turns, with a mutating decoy call in the last
 *   model turn that must never run.
 * - System instructions card opens the fixture's panel template; its textarea value is recorded.
 * Query: ?scenario=basic|simple|sys  &mock=ctrlenter (Run button never enables → keyboard path)
 * State for the test driver: window.__mock = { received[], replies[], errors[], systemInstructions, done }
 */
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const M = (window.__mock = {
    received: [],
    replies: [],
    errors: [],
    systemInstructions: '',
    done: false,
    scenario: q.get('scenario') || 'basic',
    ctrlEnterOnly: q.get('mock') === 'ctrlenter',
    noAutosave: q.get('autosave') === 'off',
    keyboardSends: 0,
    clickSends: 0,
  });
  const PROTO = '[GemInWeb protocol v1]';
  const CTX = '[DevSpace context]';
  const F = '```';

  const m = /\/prompts\/([A-Za-z0-9_-]+)/.exec(location.pathname);
  let convId = m ? m[1] : 'new_chat';
  const content = document.querySelector('.chat-session-content');
  const fixtureTurns = Array.from(content.children).map((n) => n.cloneNode(true));
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => (timers.delete(id), fn()), ms);
    timers.add(id);
  };
  const DECOY = '{"tool":"write_file","args":{"path":"HISTORIC_MUST_NOT_EXIST.txt","content":"x"}}';
  const seedDecoy = () => {
    const code = content.querySelector('ms-chat-turn:last-of-type .turn-content > ms-prompt-chunk:last-of-type ms-code-block pre code');
    if (code) code.textContent = DECOY;
  };
  let conv = { scenario: M.scenario, step: 0, turns: [] };
  const save = () => {
    if (!/^new_/.test(convId)) localStorage.setItem('mock.conv.' + convId, JSON.stringify(conv));
  };

  // ------------------------------------------------------------------ DOM builders
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }
  const icon = (name) => h('span', { class: 'material-symbols-outlined notranslate', 'aria-hidden': 'true', text: name });
  function codeBlock(lang, code) {
    const label = lang ? lang[0].toUpperCase() + lang.slice(1) : 'Code';
    return h(
      'ms-code-block',
      { 'data-test-language': lang || '' },
      h(
        'mat-expansion-panel',
        { class: 'mat-expansion-panel mat-expanded' },
        h(
          'mat-expansion-panel-header',
          { class: 'mat-expansion-panel-header', role: 'button', 'aria-expanded': 'true' },
          h('span', { class: 'mat-content' }, h('mat-panel-title', { class: 'mat-expansion-panel-header-title' }, icon('code'), h('span', { text: label }))),
          h('div', { class: 'actions' }, h('button', { 'aria-label': 'Download' }, icon('download')), h('button', { 'aria-label': 'Copy to clipboard' }, icon('content_copy')), icon('expand_less'))
        ),
        h('div', { class: 'mat-expansion-panel-content', role: 'region' }, h('div', { class: 'mat-expansion-panel-body' }, h('pre', {}, h('code', { class: 'hljs', text: code }))))
      )
    );
  }
  function thought(text, code) {
    return h(
      'ms-prompt-chunk',
      {},
      h(
        'ms-thought-chunk',
        {},
        h(
          'mat-accordion',
          { class: 'mat-accordion' },
          h(
            'mat-expansion-panel',
            { class: 'mat-expansion-panel thought-panel' },
            h('mat-expansion-panel-header', { class: 'mat-expansion-panel-header' }, h('mat-panel-title', {}, h('span', { text: 'Thoughts' }))),
            h('div', { class: 'mat-expansion-panel-content' }, h('ms-text-chunk', {}, h('ms-cmark-node', { class: 'cmark-node' }, h('p', { text }), h('pre', {}, h('code', { text: code })))))
          )
        )
      )
    );
  }
  const katex = () =>
    h('div', {}, 'Inline: ', h('ms-katex', { class: 'inline' }, h('pre', {}, h('code', { class: 'rendered', text: '{"tool":"run_shell","args":{"command":"KATEX_DECOY_MUST_NOT_RUN"}}' }))));

  /** Minimal markdown: paragraphs + fenced code blocks (any fence length). */
  function renderMarkdown(text) {
    const out = [];
    const lines = String(text).split('\n');
    let para = [];
    const flush = () => {
      if (para.join('').trim()) out.push(h('p', {}, h('ms-cmark-node', {}, h('span', { text: para.join('\n') }))));
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const f = /^(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(lines[i]);
      if (!f) {
        para.push(lines[i]);
        continue;
      }
      flush();
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const c = /^(`{3,}|~{3,})\s*$/.exec(lines[j]);
        if (c && c[1][0] === f[1][0] && c[1].length >= f[1].length) break;
        body.push(lines[j]);
      }
      out.push(codeBlock(f[2], body.join('\n')));
      i = j;
    }
    flush();
    return out;
  }

  function turnShell(role) {
    const id = 'turn-' + crypto.randomUUID();
    const tc = h('div', { class: 'turn-content' }, h('div', { role: 'heading', 'aria-level': '3', class: 'author-label' }, role === 'model' ? 'Model ' : 'User ', h('span', { class: 'timestamp', text: '00:00' })));
    const el = h(
      'ms-chat-turn',
      { id },
      h(
        'div',
        { class: 'chat-turn-container render ' + role },
        h('div', { class: `virtual-scroll-container ${role}-prompt-container`, 'data-turn-role': role === 'model' ? 'Model' : 'User' }, tc),
        h('div', { class: 'actions-container' }, h('button', { class: 'toggle-edit-button', 'aria-label': 'Edit' }, icon('edit')))
      )
    );
    content.appendChild(el);
    return { el, tc };
  }
  function fillModel(tc, parts) {
    while (tc.childNodes.length > 1) tc.lastChild.remove();
    const chunk = h('ms-cmark-node', { class: 'cmark-node v3-font-body' });
    for (const p of parts) {
      if (p.thought) tc.appendChild(thought(p.thought, p.code || ''));
      else if (p.katex) chunk.appendChild(katex());
      else if (p.code != null) chunk.appendChild(codeBlock(p.lang || '', p.code));
      else if (p.text) chunk.appendChild(h('p', {}, h('ms-cmark-node', {}, h('span', { text: p.text }))));
    }
    tc.appendChild(h('ms-prompt-chunk', {}, h('ms-text-chunk', {}, chunk)));
  }
  function renderTurn(t) {
    const { tc } = turnShell(t.role);
    if (t.role === 'user') tc.appendChild(h('ms-prompt-chunk', {}, h('ms-text-chunk', {}, h('ms-cmark-node', { class: 'cmark-node' }, renderMarkdown(t.text)))));
    else fillModel(tc, t.parts);
  }

  // ------------------------------------------------------------------ history
  if (/^seeded/.test(convId)) {
    // Keep the fixture's historic turns; turn the old list_dir into a mutating decoy.
    seedDecoy();
    conv.scenario = M.scenario = q.get('scenario') || 'simple';
  } else {
    content.textContent = '';
    const saved = !/^new_/.test(convId) && localStorage.getItem('mock.conv.' + convId);
    if (saved) {
      conv = JSON.parse(saved);
      M.scenario = conv.scenario;
      for (const t of conv.turns) renderTurn(t);
    }
  }

  // ------------------------------------------------------------------ input / run button
  const ta = () => document.querySelector('ms-autosize-textarea textarea');
  const runSlot = () => document.querySelector('ms-run-button');
  const idleRunButton = runSlot().innerHTML; // fixture markup, captured once
  const generatingRunButton = document.getElementById('tpl-run-button-generating').content.querySelector('ms-run-button').innerHTML;
  let generating = false;
  function refreshRun() {
    if (generating) return;
    const b = runSlot().querySelector('button');
    if (b) b.disabled = M.ctrlEnterOnly || !ta().value.trim();
  }
  function setGenerating(on) {
    generating = on;
    runSlot().innerHTML = on ? generatingRunButton : idleRunButton;
    refreshRun();
  }
  document.addEventListener('input', (e) => {
    if (e.target === ta()) {
      e.target.parentElement.setAttribute('data-value', e.target.value);
      refreshRun();
    }
    if (e.target.matches && e.target.matches('textarea[aria-label="System instructions"]')) M.systemInstructions = e.target.value;
  });
  document.addEventListener('click', (e) => {
    const run = e.target.closest && e.target.closest('ms-run-button button[type="submit"]');
    if (run && !run.disabled) {
      M.clickSends++;
      send();
    }
    if (e.target.closest && e.target.closest('[data-test-system-instructions-card]')) openSystemInstructions();
    if (e.target.closest && e.target.closest('[data-test-close-button]')) {
      document.querySelector('.cdk-overlay-container')?.remove();
      M.systemPanelClosed = true;
    }
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.target === ta() && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        M.keyboardSends++;
        send();
      }
    },
    true
  );
  refreshRun();

  function openSystemInstructions() {
    if (document.querySelector('.cdk-overlay-container')) return;
    setTimeout(() => {
      // AI Studio animates the panel in; emulate a short delay.
      document.body.appendChild(document.getElementById('tpl-system-instructions-open').content.cloneNode(true));
      const t = document.querySelector('textarea[aria-label="System instructions"]');
      t.value = M.systemInstructions;
    }, 300);
  }

  function send() {
    const box = ta();
    const text = box.value;
    if (!text.trim() || generating) return;
    M.received.push(text);
    conv.turns.push({ role: 'user', text });
    renderTurn({ role: 'user', text });
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, '');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    if (/^new_/.test(convId) && !M.noAutosave) {
      later(() => {
        convId = 'mock' + Math.random().toString(36).slice(2, 12);
        history.replaceState(null, '', '/prompts/' + convId + location.search);
        save();
      }, 400);
    }
    save();
    respond(text);
  }

  // ------------------------------------------------------------------ scripted model
  const isTask = (t) => t.includes(PROTO) || t.includes(CTX);
  const ok = (t, re) => re.test(t);
  const SCENARIOS = {
    basic: [
      (t) =>
        isTask(t) && t.includes(PROTO)
          ? [{ text: '알겠습니다. 파일을 만들겠습니다.' }, { lang: 'devspace', code: 'tool: write_file\npath: mock-hello.txt\n---\n안녕 AI Studio' }]
          : null,
      (t) =>
        ok(t, /^\[DevSpace result 1\/1\] write_file path=mock-hello\.txt .*— ok/)
          ? [
              { thought: '생각 중…', code: '{"tool":"run_shell","args":{"command":"THOUGHT_DECOY_MUST_NOT_RUN"}}' },
              { text: '읽고 node 버전을 확인합니다.' },
              { lang: 'devspace', code: '{"tool": "read_file", "args": {"path": "mock-hello.txt"}}' },
              { lang: 'json', code: '{"tool": "run_shell", "args": {"command": "node -v"}}' },
            ]
          : null,
      (t) =>
        ok(t, /\[DevSpace result 1\/2\] read_file[\s\S]*안녕 AI Studio[\s\S]*\[DevSpace result 2\/2\] run_shell `node -v` — ok[\s\S]*v\d+\./)
          ? [{ text: '수정합니다.' }, { lang: 'devspace', code: 'tool: edit_file\npath: mock-hello.txt\n---\n<<<<<<< SEARCH\n안녕 AI Studio\n=======\n안녕 AI Studio Mock\n>>>>>>> REPLACE' }]
          : null,
      (t) => (ok(t, /^\[DevSpace result 1\/1\] edit_file path=mock-hello\.txt .*— ok/) ? [{ text: '완료했습니다. mock-hello.txt 를 만들고 수정했습니다.' }, { katex: true }] : null),
    ],
    simple: [
      (t) => (isTask(t) ? [{ lang: 'devspace', code: 'tool: list_dir\npath: .' }] : null),
      (t) => (ok(t, /^\[DevSpace result 1\/1\] list_dir .*— ok/) ? [{ text: '목록을 확인했습니다.' }] : null),
    ],
    long: [
      (t) => (isTask(t) ? [{ lang: 'devspace', code: 'tool: run_shell\n---\n: ' + 'x'.repeat(7000) + '; echo LONG_OK' }] : null),
      (t) => (ok(t, /^\[DevSpace result 1\/1\] run_shell[\s\S]*LONG_OK/) ? [{ text: '긴 명령을 실행했습니다.' }] : null),
    ],
    sys: [
      (t) => (t.includes(CTX) && !t.includes(PROTO) ? [{ lang: 'devspace', code: 'tool: list_dir\npath: .' }] : null),
      (t) => (ok(t, /^\[DevSpace result 1\/1\] list_dir .*— ok/) ? [{ text: '시스템 지침 모드로 목록을 확인했습니다.' }] : null),
    ],
  };

  /** SPA navigation to an existing conversation (history renders with a "generating" flicker). */
  M.spaOpenSeeded = (id = 'seeded_spa') => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    content.textContent = '';
    setGenerating(true);
    history.pushState(null, '', '/prompts/' + id);
    convId = id;
    conv = { scenario: 'simple', step: 0, turns: [] };
    M.received = [];
    M.done = false;
    setTimeout(() => {
      for (const n of fixtureTurns) content.appendChild(n.cloneNode(true));
      seedDecoy();
      setTimeout(() => setGenerating(false), 400);
    }, 300);
  };

  function respond(text) {
    const steps = SCENARIOS[conv.scenario] || SCENARIOS.basic;
    const fn = steps[conv.step];
    let parts = fn ? fn(text) : null;
    if (!parts) {
      M.errors.push(`step ${conv.step}: unexpected message: ${text.slice(0, 200)}`);
      parts = [{ text: 'MOCK_UNEXPECTED step ' + conv.step }];
    } else conv.step++;
    if (conv.step >= steps.length) M.done = true;
    M.replies.push(parts);
    setGenerating(true);
    later(() => {
      const { tc } = turnShell('model');
      // stream: first a partial version (code cut in half), then the full turn
      fillModel(tc, parts.map((p) => (p.code != null && !p.thought ? Object.assign({}, p, { code: p.code.slice(0, Math.ceil(p.code.length / 2)) }) : p)));
      later(() => {
        fillModel(tc, parts);
        later(() => {
          conv.turns.push({ role: 'model', parts });
          save();
          setGenerating(false);
        }, 300);
      }, 700);
    }, 300);
  }
})();
