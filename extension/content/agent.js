/* GemInWeb — agent loop state machine.
 * Pure logic: every side effect goes through injected deps so tests can drive it
 * with a fake adapter / rpc / clock / storage / ui.
 *
 *   DSG.createAgent({ adapter, rpc, protocol, clock?, storage?, ui?, settings? })
 */
(function (g) {
  'use strict';
  const DSG = (g.DSG = g.DSG || {});

  const STABLE_MS = 1500;
  const SEND_VERIFY_MS = 8000;
  const CARRY_WINDOW_MS = 60000;
  const CARRY_WAIT_MS = 4000; // new chat got its id but our message is not rendered yet
  const POLL_MS = 250;

  const AUTO_RE = /\[DevSpace (?:result|note)\b/;

  const DEFAULTS = {
    approval: 'ask_shell',
    maxSteps: 25,
    maxCallsPerTurn: 6,
    maxMessageChars: { gemini: 24000, aistudio: 80000 },
    primerMode: 'full',
    autoSend: true,
  };

  function realClock() {
    return {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
  }

  function memoryStorage() {
    const conv = new Map();
    let on = false;
    let auto = false;
    return {
      conv,
      async getConv(k) {
        return conv.has(k) ? Object.assign({}, conv.get(k)) : null;
      },
      async setConv(k, patch) {
        conv.set(k, Object.assign({}, conv.get(k) || {}, patch, { updatedAt: Date.now() }));
      },
      async deleteConv(k) {
        conv.delete(k);
      },
      getTabOn: () => on,
      setTabOn: (v) => void (on = !!v),
      getTabAutoApprove: () => auto,
      setTabAutoApprove: (v) => void (auto = !!v),
    };
  }

  const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

  function createAgent(deps) {
    const adapter = deps.adapter;
    const rpc = deps.rpc;
    const protocol = deps.protocol || DSG.protocol;
    const clock = deps.clock || realClock();
    const storage = deps.storage || memoryStorage();
    const noop = () => {};
    const ui = Object.assign(
      {
        onState: noop,
        log: () => null,
        updateLog: noop,
        requestApproval: async () => 'deny',
        cancelApprovals: noop,
        notify: noop,
      },
      deps.ui || {}
    );
    let settings = mergeSettings(deps.settings);
    const site = adapter.site || deps.site || 'generic';

    const S = {
      on: false,
      status: 'off', // off | idle | waiting | running | approval | sending | paused | error
      message: '',
      steps: 0,
      workspace: null,
      primed: false,
      convKey: null,
      convIsNew: false,
      baseline: false,
      handledCount: 0,
      elSig: new WeakMap(), // turn element → calls signature it was handled with
      // Novelty gate: a turn is only processed when a generation was observed (or our send was
      // verified) since the last handled turn. Re-rendered / virtualised / lazily loaded old
      // turns therefore never execute, while identical calls in consecutive turns still do.
      genSinceMark: false,
      stable: null,
      busy: false,
      run: null, // pending/active run: { sig, calls, index, results, capped, invalid }
      current: null, // promise of the active execution
      token: 0,
      inflight: null,
      autoApprove: !!(storage.getTabAutoApprove && storage.getTabAutoApprove()),
      lastActivityKey: null,
      lastActivityAt: -Infinity,
      ticking: false,
      baseUsers: 0, // user-turn count absorbed into the baseline
      lastSentText: '', // text of our last send (carry-over check)
      sentInConv: 0, // verified sends in the current conversation
      carryWaitSince: 0,
    };

    function mergeSettings(s) {
      const m = Object.assign({}, DEFAULTS, s || {});
      m.maxMessageChars = Object.assign({}, DEFAULTS.maxMessageChars, (s && s.maxMessageChars) || {});
      return m;
    }

    // ---------------------------------------------------------- state / ui
    function getState() {
      return {
        site,
        on: S.on,
        status: S.status,
        message: S.message,
        steps: S.steps,
        maxSteps: settings.maxSteps,
        workspace: S.workspace,
        primed: S.primed,
        convKey: S.convKey,
        autoApprove: S.autoApprove,
        approval: settings.approval,
        baseline: S.baseline,
        busy: S.busy,
        canResume: !!S.run && (S.status === 'paused' || S.status === 'error'),
        handledCount: S.handledCount,
      };
    }
    function emit() {
      try {
        ui.onState(getState());
      } catch (_) {
        /* ui errors never break the loop */
      }
    }
    function setStatus(status, message) {
      const msg = message || '';
      if (S.status === status && S.message === msg) return;
      S.status = status;
      S.message = msg;
      emit();
    }
    function notify(text, level) {
      try {
        ui.notify(text, level || 'info');
      } catch (_) {
        /* ignore */
      }
    }

    function persistConv(patch) {
      if (!S.convKey) return Promise.resolve();
      return Promise.resolve(storage.setConv(S.convKey, patch)).catch(noop);
    }
    function persistAll() {
      return persistConv({ workspace: S.workspace, primed: S.primed, armed: S.on });
    }

    // ---------------------------------------------------------- turn signatures
    function prevUserIndex(turns, i) {
      for (let j = i - 1; j >= 0; j--) if (turns[j].role === 'user') return j;
      return -1;
    }
    function extractTurn(t) {
      const blocks = adapter.getModelBlocks(t.el) || [];
      const text = adapter.turnText(t.el) || '';
      return { blocks, text, ex: protocol.extractCalls(blocks, text) };
    }
    /** Content signature of a turn's calls (+ invalid devspace blocks). */
    function signature(ex) {
      const inv = ex.invalid && ex.invalid.length ? protocol.hashString(JSON.stringify(ex.invalid)) : '';
      return protocol.hashCalls(ex.calls) + '|' + inv;
    }
    function markSeen(turns, limit) {
      let n = 0;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].role !== 'model') continue;
        try {
          markHandled(turns[i].el, signature(extractTurn(turns[i]).ex));
        } catch (_) {
          /* ignore broken turn */
        }
        if (limit && ++n >= limit) break;
      }
    }

    function markHandled(el, sig) {
      S.handledCount++;
      if (el && typeof el === 'object') S.elSig.set(el, sig);
      S.genSinceMark = false;
    }

    function baseline() {
      S.baseline = true;
      S.stable = null;
      try {
        const turns = adapter.getTurns() || [];
        markSeen(turns, 0);
        S.baseUsers = countUsers(turns);
      } catch (_) {
        S.baseUsers = 0;
      }
    }

    function countUsers(turns) {
      let n = 0;
      for (const t of turns) if (t.role === 'user') n++;
      return n;
    }

    /** Baseline ends only after our own verified send (see sendVerified) or when a NEW user
     * message shows up as the latest turn (the user typed something; the reply is not there
     * yet). "Generating" signals are ignored here: they flicker while history renders, and
     * history rendering late (user+model pairs) just gets marked seen. */
    function maybeLeaveBaseline(turns) {
      markSeen(turns, 3);
      const users = countUsers(turns);
      const last = turns[turns.length - 1];
      if (users > S.baseUsers && last && last.role === 'user') {
        S.baseline = false;
        return true;
      }
      S.baseUsers = users;
      return false;
    }

    function noteActivity(newTurnExpected) {
      if (newTurnExpected) S.genSinceMark = true;
      S.lastActivityAt = clock.now();
      S.lastActivityKey = S.convKey;
    }

    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[`*_#>~\\]/g, '');

    /** A new chat just got its id: 'carry' only when the page now shows the message we sent
     * (so it is the same chat), 'wait' while that message is not rendered yet, else 'switch'. */
    function carryDecision(oldKey) {
      const nowNew = !!adapter.isNewChat();
      const recent =
        oldKey != null &&
        S.convIsNew &&
        !nowNew &&
        (S.busy || (S.lastActivityKey === oldKey && clock.now() - S.lastActivityAt < CARRY_WINDOW_MS));
      if (!recent || !S.lastSentText) {
        S.carryWaitSince = 0;
        return 'switch';
      }
      const users = (adapter.getTurns() || []).filter((t) => t.role === 'user');
      const lastUser = users[users.length - 1];
      if (!lastUser) {
        if (!S.carryWaitSince) S.carryWaitSince = clock.now();
        if (clock.now() - S.carryWaitSince < CARRY_WAIT_MS) return 'wait';
        S.carryWaitSince = 0;
        return 'switch';
      }
      S.carryWaitSince = 0;
      const sent = norm(S.lastSentText).slice(0, 60);
      let text = '';
      try {
        text = norm(adapter.turnText(lastUser.el));
      } catch (_) {
        text = '';
      }
      return users.length <= Math.max(1, S.sentInConv) && text.includes(sent) ? 'carry' : 'switch';
    }

    // ---------------------------------------------------------- lifecycle
    async function init() {
      S.convKey = adapter.conversationKey();
      S.convIsNew = !!adapter.isNewChat();
      const conv = await storage.getConv(S.convKey);
      S.workspace = (conv && conv.workspace) || null;
      S.primed = (conv && conv.primed) || false;
      const on = !!storage.getTabOn() || !!(conv && conv.armed);
      if (on) await setOn(true);
      else setStatus('off');
      emit();
    }

    async function setOn(on) {
      if (on) {
        const was = S.on;
        S.on = true;
        storage.setTabOn(true);
        if (!was || S.status === 'off') baseline();
        await persistConv({ armed: true, workspace: S.workspace, primed: S.primed });
        setStatus('idle', '대기 중 — 모델 응답을 감시합니다');
      } else {
        await stop();
      }
    }

    function abortRun() {
      S.token++;
      const id = S.inflight;
      S.inflight = null;
      if (id) Promise.resolve().then(() => rpc.cancel(id)).catch(noop);
      try {
        ui.cancelApprovals();
      } catch (_) {
        /* ignore */
      }
      S.run = null;
      S.busy = false;
      S.current = null;
    }

    /** 중지: cancel the in-flight call, drop pending approvals, disarm the tab. */
    async function stop() {
      abortRun();
      S.on = false;
      S.autoApprove = false;
      storage.setTabOn(false);
      if (storage.setTabAutoApprove) storage.setTabAutoApprove(false);
      await persistConv({ armed: false });
      setStatus('off', '중지됨');
    }

    async function onConversationChange(oldKey, newKey, carry) {
      const nowNew = !!adapter.isNewChat();
      S.convKey = newKey;
      S.convIsNew = nowNew;
      if (carry) {
        // New chat just received its id: same conversation, keep everything.
        S.lastActivityKey = newKey;
        await persistAll();
        Promise.resolve(storage.deleteConv(oldKey)).catch(noop);
        emit();
        return;
      }
      if (S.busy || S.run) abortRun();
      S.steps = 0;
      S.stable = null;
      S.sentInConv = 0;
      S.lastSentText = '';
      const conv = await storage.getConv(newKey);
      S.workspace = (conv && conv.workspace) || null;
      S.primed = (conv && conv.primed) || false;
      if (conv && conv.armed && !S.on) {
        S.on = true;
        storage.setTabOn(true);
      }
      if (S.on) {
        baseline();
        setStatus('idle', '대화 전환 — 기존 응답은 실행하지 않습니다');
      }
      emit();
    }

    // ---------------------------------------------------------- the tick
    async function tick() {
      if (S.ticking) return;
      S.ticking = true;
      try {
        await tickInner();
      } catch (e) {
        notify('에이전트 오류: ' + ((e && e.message) || e), 'error');
      } finally {
        S.ticking = false;
      }
    }

    async function tickInner() {
      const key = adapter.conversationKey();
      if (key !== S.convKey) {
        const d = carryDecision(S.convKey);
        if (d === 'wait') return;
        await onConversationChange(S.convKey, key, d === 'carry');
      }
      if (!S.on || S.busy) return;

      const generating = !!adapter.isGenerating();
      if (S.baseline) {
        if (!maybeLeaveBaseline(adapter.getTurns() || [])) {
          S.stable = null;
          return;
        }
      }
      if (generating) {
        noteActivity(true);
        S.stable = null;
        if (S.run && (S.status === 'paused' || S.status === 'error')) {
          // The user took over (sent something themselves): drop the paused run.
          S.run = null;
        }
        setStatus('waiting', '모델 응답 생성 중…');
        return;
      }
      if (S.status === 'paused' || S.status === 'error') return;

      const turns = adapter.getTurns() || [];
      const idx = turns.length - 1;
      const last = turns[idx];
      if (!last || last.role !== 'model') {
        S.stable = null;
        return;
      }
      if (!adapter.isTurnComplete(last.el)) {
        S.stable = null;
        return;
      }
      const { blocks, text, ex } = extractTurn(last);
      const fp = text + '\u0000' + blocks.map((b) => (b.lang || '') + ':' + b.text).join('\u0000');
      const now = clock.now();
      if (!S.stable || S.stable.el !== last.el || S.stable.fp !== fp) {
        S.stable = { el: last.el, fp, since: now };
        return;
      }
      if (now - S.stable.since < STABLE_MS) return;

      const sig = signature(ex);
      // Same element already handled with these calls → done (an in-place regeneration with
      // different calls is new). Nothing generated since the last handled turn → this is a
      // re-render of history, not a new reply → just remember it.
      if (S.elSig.get(last.el) === sig || !S.genSinceMark) {
        if (S.elSig.get(last.el) !== sig) markHandled(last.el, sig);
        if (S.status === 'waiting' || S.status === 'sending') setStatus('idle', '대기 중');
        return;
      }
      markHandled(last.el, sig);

      if (!ex.calls.length && !ex.invalid.length) {
        setStatus('idle', '모델 응답 완료 (도구 호출 없음)');
        return;
      }

      const pu = prevUserIndex(turns, idx);
      const auto = pu >= 0 && AUTO_RE.test(String(adapter.turnText(turns[pu].el) || '').slice(0, 600));
      if (!auto) S.steps = 0;

      const max = Math.max(1, settings.maxCallsPerTurn | 0);
      const run = {
        sig,
        calls: ex.calls.slice(0, max),
        capped: Math.max(0, ex.calls.length - max),
        invalid: ex.invalid || [],
        index: 0,
        results: [],
        stoppedAfter: null,
      };
      if (S.steps >= settings.maxSteps) {
        S.run = run;
        setStatus('paused', `자동 단계 한도(${settings.maxSteps})에 도달했습니다 — 계속을 누르면 진행합니다`);
        notify(`자동 단계 한도(${settings.maxSteps})에 도달해 일시 정지했습니다.`, 'warn');
        return;
      }
      startRun(run);
    }

    function startRun(run) {
      S.run = run;
      S.busy = true;
      const token = S.token;
      const p = execute(run, token)
        .catch((e) => {
          if (token === S.token) {
            setStatus('error', '실행 오류: ' + ((e && e.message) || e));
            notify('실행 오류: ' + ((e && e.message) || e), 'error');
          }
        })
        .finally(() => {
          if (token === S.token) {
            S.busy = false;
            S.current = null;
          }
        });
      S.current = p;
      return p;
    }

    // ---------------------------------------------------------- execution
    /** Paths a file tool would write (incl. every file named in an apply_patch). */
    function writtenPaths(call) {
      const a = call.args || {};
      const out = [];
      for (const k of ['path', 'file_path', 'filePath', 'file']) if (typeof a[k] === 'string') out.push(a[k]);
      if (typeof a.patch === 'string') {
        const re = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm;
        let m;
        while ((m = re.exec(a.patch))) out.push(m[1]);
      }
      return out;
    }
    const FILE_WRITERS = new Set(['write_file', 'edit_file', 'apply_patch']);
    /** run_shell, fetch_url (outbound network = exfiltration path) and file writes inside a
     * .git folder (hooks, config) are approved like shell commands. */
    function shellLike(call) {
      if (call.tool === 'run_shell' || call.tool === 'fetch_url') return true;
      if (!FILE_WRITERS.has(call.tool)) return false;
      return writtenPaths(call).some((p) => String(p).split(/[\\/]+/).some((seg) => seg.trim().toLowerCase() === '.git'));
    }

    function needsApproval(call, def) {
      if (S.autoApprove) return false;
      const mode = settings.approval;
      if (mode === 'ask_shell') return shellLike(call);
      if (mode === 'ask_mutating') return !!(def && def.mutating) || shellLike(call);
      return false;
    }

    async function runOne(call, token) {
      const def = protocol.toolDef(call.tool) || { mutating: false };
      const summary = protocol.callSummary(call);
      if (settings.approval === 'read_only' && (def.mutating || call.tool === 'fetch_url')) {
        const output =
          'Denied: GemInWeb is in read-only mode — mutating and network tools (run_shell, write_file, edit_file, apply_patch, fetch_url) are disabled.';
        safeLog({ tool: call.tool, summary, status: 'denied', output });
        return { call, ok: false, denied: true, output };
      }
      if (needsApproval(call, def)) {
        setStatus('approval', '승인 대기: ' + summary);
        let decision;
        try {
          decision = await ui.requestApproval({ call, tool: call.tool, args: call.args, summary });
        } catch (_) {
          decision = 'deny';
        }
        if (token !== S.token) return null;
        if (decision === 'approve_all') {
          S.autoApprove = true;
          if (storage.setTabAutoApprove) storage.setTabAutoApprove(true);
          emit();
        } else if (decision !== 'approve') {
          const output = 'The user denied this call.';
          safeLog({ tool: call.tool, summary, status: 'denied', output });
          return { call, ok: false, denied: true, output };
        }
      }
      setStatus('running', summary);
      noteActivity(false);
      const id = rpc.newId ? rpc.newId() : 'a' + Math.random().toString(36).slice(2);
      S.inflight = id;
      const logId = safeLog({ tool: call.tool, summary, status: 'running' });
      const t0 = clock.now();
      let result;
      try {
        result = await rpc.call(call.tool, call.args, S.workspace, { id });
      } catch (e) {
        if (S.inflight === id) S.inflight = null;
        if (token !== S.token) return null;
        const msg = (e && e.message) || String(e);
        safeUpdate(logId, { status: 'error', output: msg });
        return { transportError: msg };
      }
      if (S.inflight === id) S.inflight = null;
      if (token !== S.token) return null;
      result = result || {};
      const r = {
        call,
        ok: !!result.ok,
        output: result.output,
        durationMs: typeof result.durationMs === 'number' ? result.durationMs : clock.now() - t0,
        truncated: !!result.truncated,
        cancelled: !!result.cancelled,
      };
      if (result.workspace && typeof result.workspace === 'string') {
        S.workspace = result.workspace;
        persistConv({ workspace: S.workspace });
        emit();
      }
      safeUpdate(logId, { status: r.ok ? 'ok' : r.cancelled ? 'cancelled' : 'error', durationMs: r.durationMs, output: r.output });
      return r;
    }

    function safeLog(entry) {
      try {
        return ui.log(entry);
      } catch (_) {
        return null;
      }
    }
    function safeUpdate(id, patch) {
      try {
        if (id != null) ui.updateLog(id, patch);
      } catch (_) {
        /* ignore */
      }
    }

    async function execute(run, token) {
      setStatus('running');
      while (run.index < run.calls.length && run.stoppedAfter == null) {
        const call = run.calls[run.index];
        const res = await runOne(call, token);
        if (token !== S.token || res === null) return;
        if (res.transportError) {
          // The call may already have run on the host: never re-run it. 계속 reports it as failed.
          run.results.push({
            call,
            ok: false,
            output: `GemInWeb lost the result of this call (bridge error: ${res.transportError}). It may or may not have run — check the current state before retrying it.`,
          });
          run.index++;
          run.stoppedAfter = run.index;
          setStatus('error', '호스트 오류: ' + res.transportError + ' — 계속을 누르면 모델에 실패로 알립니다');
          notify(res.transportError, 'error');
          return; // run stays pending; 계속 delivers the results
        }
        run.results.push(res);
        run.index++;
        if (!res.ok) {
          run.stoppedAfter = run.index;
          break;
        }
      }
      const notes = [];
      const skipped = run.calls.length - run.results.length;
      if (run.stoppedAfter != null && skipped > 0) {
        notes.push(
          `[DevSpace note] ${skipped} more call(s) in your message were not run because call ${run.stoppedAfter} did not succeed. Fix the problem, then send them again.`
        );
      }
      if (run.capped > 0) {
        notes.push(
          `[DevSpace note] Only the first ${run.calls.length} calls of your message were considered (limit per message); ${run.capped} call(s) were ignored — send them again in your next message.`
        );
      }
      for (const inv of run.invalid) {
        notes.push(`[DevSpace note] A devspace block could not be used (${inv.error}): ${inv.snippet}`);
      }
      let maxChars = (settings.maxMessageChars && settings.maxMessageChars[site]) || 24000;
      // Hard input limit of the site (Gemini silently drops text beyond 32,000 chars).
      if (adapter.maxInputChars > 0) maxChars = Math.min(maxChars, adapter.maxInputChars - 500);
      const text = protocol.formatResults(run.results, { maxChars, notes });
      S.run = null;
      await deliver(text, token, true);
    }

    function userCount() {
      try {
        return (adapter.getTurns() || []).filter((t) => t.role === 'user').length;
      } catch (_) {
        return 0;
      }
    }

    async function waitFor(pred, ms, token) {
      const deadline = clock.now() + ms;
      for (;;) {
        if (token !== S.token) return false;
        let ok = false;
        try {
          ok = !!pred();
        } catch (_) {
          ok = false;
        }
        if (ok) return true;
        if (clock.now() >= deadline) return false;
        await clock.sleep(POLL_MS);
      }
    }

    /** Type text, press send, verify (input cleared / new user turn / generation) within 8 s; retry once. */
    async function sendVerified(text, token) {
      const before = userCount();
      S.lastSentText = text;
      const typed = await adapter.setInput(text);
      if (token !== S.token) return false;
      if (!typed) {
        notify('입력창에 텍스트를 넣지 못했습니다 — 선택자(selectors.js)를 확인하세요', 'error');
        return false;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        await adapter.send();
        if (token !== S.token) return false;
        noteActivity();
        const ok = await waitFor(
          () => squash(adapter.getInputText()) === '' || userCount() > before || adapter.isGenerating(),
          SEND_VERIFY_MS,
          token
        );
        if (ok) {
          noteActivity(true);
          S.sentInConv++;
          S.baseline = false; // our own message: the reply to it is new work
          return true;
        }
        if (token !== S.token) return false;
        if (attempt === 0 && squash(adapter.getInputText()) !== squash(text)) {
          await adapter.setInput(text);
        }
      }
      notify('자동 전송을 확인하지 못했습니다 — 입력창의 텍스트를 직접 전송하세요', 'warn');
      return false;
    }

    async function deliver(text, token, isAuto) {
      if (!settings.autoSend) {
        const typed = await adapter.setInput(text);
        if (token !== S.token) return false;
        if (isAuto) S.steps++;
        noteActivity();
        setStatus('idle', typed ? '결과를 입력창에 넣었습니다 — 직접 전송하세요' : '입력창에 넣지 못했습니다');
        notify(typed ? '결과를 입력창에 넣었습니다 (자동 전송 꺼짐).' : '입력창에 텍스트를 넣지 못했습니다.', typed ? 'info' : 'error');
        return typed;
      }
      setStatus('sending', '결과 전송 중…');
      const ok = await sendVerified(text, token);
      if (token !== S.token) return false;
      if (ok) {
        if (isAuto) S.steps++;
        setStatus('waiting', '모델 응답 대기 중…');
      } else {
        setStatus('idle', '전송 실패 — 입력창의 텍스트를 직접 보내세요');
      }
      return ok;
    }

    // ---------------------------------------------------------- user actions
    /** 계속: resume a run paused by maxSteps or a host error. */
    async function resume() {
      if (!S.on) await setOn(true);
      if (S.busy) return;
      if (S.run) {
        S.steps = 0;
        return startRun(S.run);
      }
      setStatus('idle', '대기 중');
    }

    /** 작업 시작: primer (or short context when already primed) + task, then arm. */
    async function startTask(task) {
      task = String(task || '').trim();
      if (!task) {
        notify('작업 내용을 입력하세요.', 'warn');
        return false;
      }
      if (S.busy) {
        notify('도구 실행 중입니다 — 끝난 뒤 다시 시도하세요.', 'warn');
        return false;
      }
      // Claim the loop before any await so a tick cannot start a run in between.
      S.busy = true;
      const token = S.token;
      const release = () => {
        if (token === S.token) S.busy = false;
      };
      if (!S.on) {
        S.on = true;
        storage.setTabOn(true);
        baseline();
      }
      const mode = S.primed || settings.primerMode === 'context' ? 'context' : 'full';
      let primer;
      try {
        primer = await rpc.primer(site, mode, S.workspace);
      } catch (e) {
        release();
        const msg = (e && e.message) || String(e);
        setStatus('error', '호스트 오류: ' + msg);
        notify(msg, 'error');
        return false;
      }
      if (token !== S.token) return false; // 중지 / conversation switch while fetching the primer
      const text = (primer && primer.text ? String(primer.text).trim() + '\n\n' : '') + task;
      if (adapter.maxInputChars > 0 && text.length > adapter.maxInputChars) {
        release();
        notify(`작업 내용이 너무 깁니다 (${text.length}자 > 입력 한도 ${adapter.maxInputChars}자).`, 'error');
        return false;
      }
      S.steps = 0;
      S.run = null;
      let ok = false;
      try {
        setStatus('sending', '작업 전송 중…');
        ok = await sendVerified(text, token);
      } finally {
        if (token === S.token) S.busy = false;
      }
      if (token !== S.token) return false;
      if (ok) {
        S.primed = S.primed || true;
        await persistAll();
        setStatus('waiting', '모델 응답 대기 중…');
      } else {
        await persistConv({ armed: true });
        setStatus('idle', '작업 전송 실패 — 입력창을 확인하세요');
      }
      return ok;
    }

    async function getPrimer(mode) {
      const p = await rpc.primer(site, mode || 'full', S.workspace);
      return (p && p.text) || '';
    }

    /** AI Studio: put the full primer into the system instructions. */
    async function pushSystemInstructions() {
      if (typeof adapter.setSystemInstructions !== 'function') {
        notify('이 사이트는 시스템 지침을 지원하지 않습니다.', 'warn');
        return false;
      }
      let text;
      try {
        text = await getPrimer('full');
      } catch (e) {
        notify((e && e.message) || String(e), 'error');
        return false;
      }
      const ok = await adapter.setSystemInstructions(text);
      if (ok) {
        S.primed = 'system';
        await persistConv({ primed: 'system', workspace: S.workspace });
        notify('시스템 지침에 프로토콜을 넣었습니다. 이제 작업 시작은 짧은 컨텍스트만 보냅니다.', 'info');
        emit();
      } else notify('시스템 지침 입력란을 찾지 못했습니다 — 지침 복사 후 직접 붙여 넣으세요.', 'error');
      return ok;
    }

    /** 변경: validate via open_workspace; empty path = host default workspace. */
    async function setWorkspace(path) {
      path = String(path || '').trim();
      if (!path) {
        S.workspace = null;
        await persistConv({ workspace: null });
        emit();
        return { ok: true, workspace: null };
      }
      let r;
      try {
        r = await rpc.call('open_workspace', { path }, null, { id: rpc.newId ? rpc.newId() : undefined });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        notify(msg, 'error');
        return { ok: false, error: msg };
      }
      if (r && r.ok && r.workspace) {
        S.workspace = r.workspace;
        await persistConv({ workspace: S.workspace });
        safeLog({ tool: 'open_workspace', summary: 'open_workspace path=' + path, status: 'ok', durationMs: r.durationMs, output: r.output });
        emit();
        return { ok: true, workspace: S.workspace };
      }
      const msg = (r && r.output) || '작업 폴더를 열 수 없습니다';
      notify(msg, 'error');
      return { ok: false, error: msg };
    }

    function updateSettings(s) {
      settings = mergeSettings(s);
      emit();
    }

    function setApprovalMode(mode) {
      settings.approval = mode;
      emit();
    }

    function resetAutoApprove() {
      S.autoApprove = false;
      if (storage.setTabAutoApprove) storage.setTabAutoApprove(false);
      emit();
    }

    return {
      init,
      tick,
      setOn,
      stop,
      resume,
      startTask,
      getPrimer,
      pushSystemInstructions,
      setWorkspace,
      updateSettings,
      setApprovalMode,
      resetAutoApprove,
      getState,
      /** Resolves when the active execution (if any) finished — for tests. */
      whenIdle: () => S.current || Promise.resolve(),
      _S: S,
    };
  }

  DSG.createAgent = createAgent;
  DSG.agentConstants = { STABLE_MS, SEND_VERIFY_MS, CARRY_WINDOW_MS };
  DSG.memoryStorage = memoryStorage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
