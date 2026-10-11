/* GemInWeb — floating control panel (Shadow DOM, Korean UI). */
(function (g) {
  'use strict';
  const DSG = (g.DSG = g.DSG || {});

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --card: #f6f8fa;
  --accent: #1a73e8; --accent-fg: #fff; --ok: #1a7f37; --err: #cf222e; --warn: #9a6700;
  --shadow: 0 8px 28px rgba(0,0,0,.18);
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  font: 13px/1.45 "Segoe UI", "Malgun Gothic", system-ui, sans-serif; color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .root { --bg: #1f2124; --fg: #e6e6e6; --muted: #9aa0a6; --line: #3c4043; --card: #2a2c2f;
    --accent: #8ab4f8; --accent-fg: #202124; --ok: #81c995; --err: #f28b82; --warn: #fdd663; }
}
.pill { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px;
  background: var(--bg); border: 1px solid var(--line); box-shadow: var(--shadow); cursor: pointer;
  user-select: none; font-weight: 600; }
.pill .sub { font-weight: 400; color: var(--muted); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel { width: 370px; max-height: min(78vh, 760px); display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }
.hidden { display: none !important; }
.hdr { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.hdr .title { font-weight: 700; }
.hdr .conn { color: var(--muted); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #9aa0a6; flex: none; }
.dot.ok { background: #1e8e3e; } .dot.err { background: #d93025; } .dot.busy { background: #f9ab00; }
.body { overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.label { color: var(--muted); font-size: 12px; min-width: 52px; }
.grow { flex: 1; min-width: 0; }
.mono { font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; word-break: break-all; }
button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--card); color: var(--fg); cursor: pointer; }
button:hover { filter: brightness(0.96); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
button.danger { color: var(--err); border-color: var(--err); background: transparent; }
button.icon { padding: 2px 7px; background: transparent; border-color: transparent; color: var(--muted); }
textarea, input[type=text], select { font: inherit; color: var(--fg); background: var(--bg);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; width: 100%; }
textarea { resize: vertical; min-height: 64px; }
.switch { position: relative; width: 40px; height: 22px; border-radius: 11px; background: var(--line); cursor: pointer; flex: none; border: none; padding: 0; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
.switch.on { background: #1e8e3e; } .switch.on::after { left: 21px; }
.status { color: var(--muted); font-size: 12px; }
.notice { font-size: 12px; padding: 6px 8px; border-radius: 6px; background: var(--card); border-left: 3px solid var(--accent); white-space: pre-wrap; }
.notice.error { border-left-color: var(--err); } .notice.warn { border-left-color: var(--warn); }
.card { border: 1px solid var(--warn); border-radius: 8px; padding: 8px; background: var(--card); display: flex; flex-direction: column; gap: 6px; }
.card pre { margin: 0; max-height: 160px; overflow: auto; white-space: pre-wrap; background: var(--bg); padding: 6px; border-radius: 4px; }
.log { display: flex; flex-direction: column; gap: 4px; }
.entry { border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
.entry .top { display: flex; gap: 6px; align-items: baseline; }
.entry .sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry .st { font-size: 11px; font-weight: 600; flex: none; }
.st.ok { color: var(--ok); } .st.error, .st.denied, .st.cancelled { color: var(--err); } .st.running { color: var(--warn); }
.entry pre { margin: 4px 0 0; max-height: 220px; overflow: auto; white-space: pre-wrap; font-size: 11.5px; }
.section-title { font-size: 12px; font-weight: 600; color: var(--muted); }
.small { font-size: 11.5px; color: var(--muted); }
`;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat()) if (kid != null) el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return el;
  }

  const STATUS_KO = {
    off: '꺼짐',
    idle: '대기',
    waiting: '응답 대기',
    running: '실행 중',
    approval: '승인 대기',
    sending: '전송 중',
    paused: '일시 정지',
    error: '오류',
  };
  const APPROVAL_OPTIONS = [
    ['auto', '자동 (모두 실행)'],
    ['ask_shell', '셸 명령만 확인'],
    ['ask_mutating', '변경 작업 모두 확인'],
    ['read_only', '읽기 전용 (변경 거부)'],
  ];

  function lsGet(k) {
    try {
      return g.localStorage.getItem(k);
    } catch (_) {
      return null;
    }
  }
  function lsSet(k, v) {
    try {
      g.localStorage.setItem(k, v);
    } catch (_) {
      /* ignore */
    }
  }

  function createPanel(opts) {
    opts = opts || {};
    const cb = (name, ...a) => {
      try {
        const f = opts[name];
        if (typeof f === 'function') return f(...a);
      } catch (e) {
        notify(String((e && e.message) || e), 'error');
      }
      return undefined;
    };

    const host = h('div', { id: 'devspace-gem-panel' });
    // Closed: page scripts cannot reach into the panel (approve buttons, toggles, inputs).
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.appendChild(h('style', { text: CSS }));
    const root = h('div', { class: 'root' });
    shadow.appendChild(root);
    // Only real user input may drive the panel: synthetic events (el.click(), dispatchEvent from
    // page scripts or other extensions) are swallowed in the capture phase before any handler.
    for (const t of ['click', 'dblclick', 'auxclick', 'change', 'input', 'keydown', 'keyup', 'keypress', 'submit']) {
      root.addEventListener(
        t,
        (e) => {
          if (e.isTrusted !== true) {
            e.stopImmediatePropagation();
            e.preventDefault();
          }
        },
        true
      );
    }
    // Keep the page's global keyboard shortcuts away from our inputs.
    for (const t of ['keydown', 'keyup', 'keypress', 'input', 'paste', 'copy', 'cut']) {
      root.addEventListener(t, (e) => e.stopPropagation());
    }

    // ---- pill
    const pillDot = h('span', { class: 'dot' });
    const pillSub = h('span', { class: 'sub', text: '꺼짐' });
    const pill = h('div', { class: 'pill', title: 'GemInWeb 패널 열기' }, pillDot, h('span', { text: '◆ DevSpace' }), pillSub);

    // ---- header
    const dot = h('span', { class: 'dot' });
    const conn = h('span', { class: 'conn', text: '호스트 확인 중…' });
    const btnOpts = h('button', { class: 'icon', title: '옵션', text: '⚙' });
    const btnRefresh = h('button', { class: 'icon', title: '연결 다시 확인', text: '↻' });
    const btnCollapse = h('button', { class: 'icon', title: '접기', text: '—' });
    const hdr = h('div', { class: 'hdr' }, dot, h('span', { class: 'title', text: 'GemInWeb' }), conn, btnRefresh, btnOpts, btnCollapse);

    // ---- agent row
    const sw = h('button', { class: 'switch', title: '에이전트 켜기/끄기', 'aria-label': '에이전트' });
    const statusEl = h('span', { class: 'status grow', text: '꺼짐' });
    const stepsEl = h('span', { class: 'small', text: '' });
    const agentRow = h('div', { class: 'row' }, h('span', { class: 'label', text: '에이전트' }), sw, statusEl, stepsEl);

    // ---- workspace
    const wsText = h('span', { class: 'mono grow', text: '(기본 폴더)' });
    const btnWs = h('button', { text: '변경' });
    const wsInput = h('input', { type: 'text', placeholder: '예: C:\\Users\\me\\project  (비우면 기본 폴더)' });
    const wsOk = h('button', { class: 'primary', text: '확인' });
    const wsCancel = h('button', { text: '취소' });
    const wsEdit = h('div', { class: 'row hidden' }, h('div', { class: 'grow' }, wsInput), wsOk, wsCancel);
    const wsRow = h('div', { class: 'row' }, h('span', { class: 'label', text: '작업 폴더' }), wsText, btnWs);

    // ---- task
    const task = h('textarea', { placeholder: '작업 내용을 입력하세요 (Ctrl+Enter로 시작)\n예: 이 저장소의 테스트를 실행하고 실패를 고쳐 줘' });
    const btnStart = h('button', { class: 'primary', text: '작업 시작' });
    const btnCopy = h('button', { text: '지침 복사' });
    const btnSys = h('button', { text: '시스템 지침에 넣기', class: opts.site === 'aistudio' ? '' : 'hidden' });
    const taskRow = h('div', { class: 'row' }, btnStart, btnCopy, btnSys);

    // ---- approval mode
    const sel = h('select', {}, APPROVAL_OPTIONS.map(([v, t]) => h('option', { value: v, text: t })));
    const autoNote = h('span', { class: 'small hidden' }, '이 탭: 모두 자동 승인 중 ');
    const autoReset = h('button', { class: 'icon', text: '해제' });
    autoNote.appendChild(autoReset);
    const apprRow = h('div', { class: 'row' }, h('span', { class: 'label', text: '승인' }), h('div', { class: 'grow' }, sel), autoNote);

    // ---- approvals, notices, controls, log
    const approvals = h('div', { class: 'log' });
    const notice = h('div', { class: 'notice hidden' });
    const btnResume = h('button', { class: 'primary hidden', text: '계속' });
    const btnStop = h('button', { class: 'danger', text: '중지' });
    const ctrlRow = h('div', { class: 'row' }, btnResume, btnStop, h('span', { class: 'grow' }));
    const logTitle = h('div', { class: 'section-title', text: '활동 기록' });
    const btnClear = h('button', { class: 'icon', text: '지우기' });
    const log = h('div', { class: 'log' });
    const warnSel = h('div', { class: 'notice warn hidden' });

    const body = h(
      'div',
      { class: 'body' },
      warnSel,
      agentRow,
      wsRow,
      wsEdit,
      task,
      taskRow,
      apprRow,
      approvals,
      notice,
      ctrlRow,
      h('div', { class: 'row' }, logTitle, h('span', { class: 'grow' }), btnClear),
      log
    );
    const panel = h('div', { class: 'panel' }, hdr, body);
    root.appendChild(pill);
    root.appendChild(panel);

    // ---- collapse state
    function setCollapsed(c) {
      pill.classList.toggle('hidden', !c);
      panel.classList.toggle('hidden', c);
      lsSet('dsg.panel.collapsed', c ? '1' : '0');
    }
    setCollapsed(lsGet('dsg.panel.collapsed') === '1');
    pill.addEventListener('click', () => setCollapsed(false));
    btnCollapse.addEventListener('click', () => setCollapsed(true));

    // ---- wiring
    let state = { on: false };
    sw.addEventListener('click', () => cb('onToggle', !state.on));
    btnOpts.addEventListener('click', () => cb('onOptions'));
    btnRefresh.addEventListener('click', () => cb('onRefreshStatus'));
    btnWs.addEventListener('click', () => {
      wsInput.value = state.workspace || '';
      wsEdit.classList.remove('hidden');
      wsInput.focus();
    });
    const submitWs = async () => {
      wsOk.disabled = true;
      try {
        const r = await cb('onWorkspace', wsInput.value);
        if (!r || r.ok !== false) wsEdit.classList.add('hidden');
      } finally {
        wsOk.disabled = false;
      }
    };
    wsOk.addEventListener('click', submitWs);
    wsCancel.addEventListener('click', () => wsEdit.classList.add('hidden'));
    wsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitWs();
      if (e.key === 'Escape') wsEdit.classList.add('hidden');
    });
    const start = async () => {
      btnStart.disabled = true;
      try {
        const ok = await cb('onStart', task.value);
        if (ok) task.value = '';
      } finally {
        btnStart.disabled = false;
      }
    };
    btnStart.addEventListener('click', start);
    task.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        start();
      }
    });
    btnCopy.addEventListener('click', () => cb('onCopyPrimer'));
    btnSys.addEventListener('click', () => cb('onSystemInstructions'));
    sel.addEventListener('change', () => cb('onApproval', sel.value));
    autoReset.addEventListener('click', () => cb('onResetAutoApprove'));
    btnResume.addEventListener('click', () => cb('onResume'));
    btnStop.addEventListener('click', () => cb('onStop'));
    btnClear.addEventListener('click', () => {
      log.textContent = '';
      entries.clear();
    });

    // ---- api
    function setConnection(kind, text) {
      for (const d of [dot, pillDot]) {
        d.classList.remove('ok', 'err', 'busy');
        if (kind) d.classList.add(kind);
      }
      conn.textContent = text || '';
      conn.title = text || '';
    }

    let defaultWs = null;
    function setDefaultWorkspace(p) {
      defaultWs = p || null;
      renderWs();
    }
    function renderWs() {
      if (state.workspace) {
        wsText.textContent = state.workspace;
      } else {
        wsText.textContent = defaultWs ? `${defaultWs} (기본)` : '(기본 폴더)';
      }
      wsText.title = wsText.textContent;
    }

    function onState(s) {
      state = Object.assign({}, state, s);
      sw.classList.toggle('on', !!state.on);
      const label = STATUS_KO[state.status] || state.status || '';
      statusEl.textContent = state.message ? `${label} · ${state.message}` : label;
      statusEl.title = statusEl.textContent;
      stepsEl.textContent = state.on ? `단계 ${state.steps || 0}/${state.maxSteps || '-'}` : '';
      pillSub.textContent = state.on ? label : '꺼짐';
      if (state.approval && sel.value !== state.approval) sel.value = state.approval;
      autoNote.classList.toggle('hidden', !state.autoApprove);
      btnResume.classList.toggle('hidden', !state.canResume);
      btnStop.disabled = !state.on;
      renderWs();
    }

    let noticeTimer = null;
    function notify(text, level) {
      notice.textContent = text;
      notice.className = 'notice' + (level === 'error' ? ' error' : level === 'warn' ? ' warn' : '');
      clearTimeout(noticeTimer);
      if (level !== 'error') noticeTimer = setTimeout(() => notice.classList.add('hidden'), 12000);
    }

    function setSelectorWarning(text) {
      warnSel.textContent = text || '';
      warnSel.classList.toggle('hidden', !text);
    }

    const entries = new Map();
    let logSeq = 0;
    const ST_KO = { running: '실행 중', ok: '성공', error: '오류', denied: '거부됨', cancelled: '취소됨' };
    function fmtMs(ms) {
      if (typeof ms !== 'number') return '';
      return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
    }
    function renderEntry(e) {
      e.st.className = 'st ' + (e.data.status || '');
      e.st.textContent = (ST_KO[e.data.status] || e.data.status || '') + (e.data.durationMs != null ? ' · ' + fmtMs(e.data.durationMs) : '');
      e.sum.textContent = e.data.summary || e.data.tool || '';
      e.sum.title = e.data.summary || '';
      e.pre.textContent = e.data.output == null ? '(출력 없음)' : String(e.data.output);
    }
    function addLog(data) {
      const id = ++logSeq;
      const st = h('span', { class: 'st' });
      const sum = h('span', { class: 'sum mono' });
      const pre = h('pre', { class: 'mono hidden' });
      const el = h('div', { class: 'entry' }, h('div', { class: 'top' }, sum, st), pre);
      el.addEventListener('click', (ev) => {
        if (ev.target === pre || pre.contains(ev.target)) return;
        pre.classList.toggle('hidden');
      });
      const e = { el, st, sum, pre, data: Object.assign({}, data) };
      entries.set(id, e);
      renderEntry(e);
      log.insertBefore(el, log.firstChild);
      while (log.childElementCount > 60) {
        const lastEl = log.lastElementChild;
        for (const [k, v] of entries) if (v.el === lastEl) entries.delete(k);
        lastEl.remove();
      }
      return id;
    }
    function updateLog(id, patch) {
      const e = entries.get(id);
      if (!e) return;
      Object.assign(e.data, patch);
      renderEntry(e);
    }

    const pending = new Set();
    function requestApproval(info) {
      setCollapsed(false);
      return new Promise((resolve) => {
        let argsText;
        try {
          const a = Object.assign({}, info.args || {});
          argsText = info.tool === 'run_shell' && typeof a.command === 'string' ? a.command : JSON.stringify(a, null, 2);
          if (info.tool === 'run_shell') {
            const extra = Object.keys(a).filter((k) => k !== 'command');
            if (extra.length) argsText += '\n\n' + extra.map((k) => `${k}: ${JSON.stringify(a[k])}`).join('\n');
          }
        } catch (_) {
          argsText = String(info.summary || '');
        }
        // Long commands are shown cut, but approving requires viewing all of it first:
        // the hidden tail would run too.
        const PREVIEW = 6000;
        const cut = argsText.length > PREVIEW;
        const done = (d) => {
          pending.delete(entry);
          card.remove();
          resolve(d);
        };
        const pre = h('pre', { class: 'mono', text: cut ? argsText.slice(0, PREVIEW) + '\n…' : argsText });
        const btnApprove = h('button', { class: 'primary', text: '승인', onclick: () => done('approve') });
        const btnAll = h('button', { text: '이 탭에서 모두 자동 승인', onclick: () => done('approve_all') });
        let expander = null;
        if (cut) {
          btnApprove.disabled = true;
          btnAll.disabled = true;
          expander = h('button', {
            text: `명령이 잘림 (${argsText.length.toLocaleString()}자) — 전체 보기 후 승인 가능`,
            onclick: () => {
              pre.textContent = argsText;
              pre.style.maxHeight = '50vh';
              btnApprove.disabled = false;
              btnAll.disabled = false;
              expander.remove();
            },
          });
        }
        const card = h(
          'div',
          { class: 'card' },
          h('div', { class: 'section-title', text: '승인 필요: ' + info.tool }),
          pre,
          expander,
          h('div', { class: 'row' }, btnApprove, h('button', { class: 'danger', text: '거부', onclick: () => done('deny') }), btnAll)
        );
        const entry = { done };
        pending.add(entry);
        approvals.appendChild(card);
      });
    }
    function cancelApprovals() {
      for (const p of Array.from(pending)) p.done('cancel');
    }

    function mount() {
      const attach = () => {
        if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
      };
      attach();
      return attach;
    }

    return {
      host,
      shadow, // closed root: reachable only from the extension's isolated world (E2E driver)
      mount,
      onState,
      notify,
      log: addLog,
      updateLog,
      requestApproval,
      cancelApprovals,
      setConnection,
      setDefaultWorkspace,
      setSelectorWarning,
      setCollapsed,
      getTaskText: () => task.value,
    };
  }

  DSG.createPanel = createPanel;
})(typeof globalThis !== 'undefined' ? globalThis : this);
