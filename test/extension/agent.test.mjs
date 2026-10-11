import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts, plain } from './_load.mjs';

const ctx = loadScripts(['content/protocol.js', 'content/agent.js']);
const { DSG } = ctx;
const P = DSG.protocol;

// ------------------------------------------------------------------ fakes
function makeWorld(o = {}) {
  const w = {
    site: o.site || 'gemini',
    convId: o.convId === undefined ? 'abc123' : o.convId,
    path: o.path || '/app',
    turns: [],
    generating: false,
    input: '',
    sendMode: 'ok', // ok | dead (click does nothing) | deadOnce
    sendCalls: 0,
    sent: [],
    seq: 0,
  };
  w.addTurn = (role, text, blocks, extra = {}) => {
    const el = { n: ++w.seq };
    w.turns.push({ el, role, text, blocks: blocks || [], ...extra });
    return el;
  };
  w.model = (...callObjs) =>
    w.addTurn(
      'model',
      'Sure.',
      callObjs.map((c) => ({ text: typeof c === 'string' ? c : JSON.stringify(c), lang: 'devspace' }))
    );
  const find = (el) => w.turns.find((t) => t.el === el);
  w.adapter = {
    site: w.site,
    getTurns: () => w.turns.map((t, i) => ({ el: t.el, role: t.role, key: t.key || 'idx:' + i })),
    getModelBlocks: (el) => find(el).blocks,
    turnText: (el) => find(el).text + '\n' + find(el).blocks.map((b) => b.text).join('\n'),
    isGenerating: () => w.generating,
    isTurnComplete: () => true,
    getInputText: () => w.input,
    setInput: async (t) => {
      w.input = t;
      return true;
    },
    send: async () => {
      w.sendCalls++;
      if (w.sendMode === 'dead') return true;
      if (w.sendMode === 'deadOnce') {
        w.sendMode = 'ok';
        return true;
      }
      w.sent.push(w.input);
      w.addTurn('user', w.input);
      w.input = '';
      return true;
    },
    conversationKey: () => w.site + ':' + (w.convId || w.path),
    isNewChat: () => !w.convId,
    setSystemInstructions: async (t) => {
      w.system = t;
      return true;
    },
  };
  return w;
}

function makeClock() {
  const c = { t: 1000 };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.t += ms;
  };
  return c;
}

function makeRpc(handler) {
  const r = { calls: [], cancels: [], primers: [], n: 0 };
  r.newId = () => 'id' + ++r.n;
  r.call = async (tool, args, workspace, opts) => {
    r.calls.push({ tool, args: plain(args), workspace, id: opts && opts.id });
    if (handler) return handler(tool, args, opts);
    return { ok: true, output: `${tool} output`, durationMs: 5 };
  };
  r.cancel = async (id) => {
    r.cancels.push(id);
    return { cancelled: true };
  };
  r.primer = async (site, mode, workspace) => {
    r.primers.push({ site, mode, workspace });
    return { text: `[GemInWeb protocol v1] (${mode})`, marker: '[GemInWeb protocol v1]' };
  };
  return r;
}

function makeUi(decisions = []) {
  const u = { logs: [], notes: [], approvals: [], states: [] };
  u.onState = (s) => u.states.push(s);
  u.log = (e) => {
    u.logs.push({ ...e });
    return u.logs.length;
  };
  u.updateLog = (id, p) => Object.assign(u.logs[id - 1], p);
  u.notify = (t, l) => u.notes.push({ t, l });
  u.requestApproval = async (info) => {
    u.approvals.push(info.tool);
    return decisions.length ? decisions.shift() : 'approve';
  };
  u.cancelApprovals = () => {};
  return u;
}

async function setup(o = {}) {
  const world = makeWorld(o);
  const clock = makeClock();
  const rpc = makeRpc(o.handler);
  const ui = o.ui || makeUi(o.decisions);
  const storage = o.storage || DSG.memoryStorage();
  if (o.history) o.history(world);
  const agent = DSG.createAgent({
    adapter: world.adapter,
    rpc,
    protocol: P,
    clock,
    storage,
    ui,
    settings: { approval: 'auto', ...(o.settings || {}) },
  });
  await agent.init();
  if (o.on !== false) await agent.setOn(true);
  return { world, clock, rpc, ui, storage, agent };
}

/** Let the latest turn become stable and get processed. */
async function settle(t, ms = 1600) {
  await t.agent.tick();
  t.clock.t += ms;
  await t.agent.tick();
  await t.agent.whenIdle();
}

/** A real exchange starts with a user message (that is what ends the arming baseline). */
function userAsks(t, text = 'please do it') {
  const last = t.world.turns[t.world.turns.length - 1];
  if (!last || last.role !== 'user') t.world.addTurn('user', text);
}

/** Simulate the user (or our result message) asking, and the model generating and finishing a reply. */
async function modelReplies(t, ...calls) {
  userAsks(t);
  t.world.generating = true;
  await t.agent.tick();
  t.world.generating = false;
  t.world.model(...calls);
  await settle(t);
}

const READ = { tool: 'read_file', args: { path: 'a.txt' } };

// ------------------------------------------------------------------ tests
test('arming baselines historic turns: old tool calls never run', async () => {
  const t = await setup({ history: (w) => (w.addTurn('user', 'hi'), w.model(READ)) });
  await settle(t);
  await settle(t);
  assert.equal(t.rpc.calls.length, 0);
  assert.equal(t.world.sent.length, 0);
});

test('turns rendered after arming (before any generation) are still baseline', async () => {
  const t = await setup();
  t.world.addTurn('user', 'old question');
  t.world.model(READ); // late render of history, no generation observed
  await settle(t);
  assert.equal(t.rpc.calls.length, 0);
});

test('new model turn runs once after generation ends and text is stable ≥ 1.5 s', async () => {
  const t = await setup();
  userAsks(t);
  t.world.generating = true;
  await t.agent.tick();
  t.world.model(READ);
  await t.agent.tick();
  assert.equal(t.rpc.calls.length, 0, 'not while generating');
  t.world.generating = false;
  await t.agent.tick(); // first stable observation
  t.clock.t += 1000;
  await t.agent.tick();
  assert.equal(t.rpc.calls.length, 0, 'not before 1.5 s');
  t.clock.t += 600;
  await t.agent.tick();
  await t.agent.whenIdle();
  assert.equal(t.rpc.calls.length, 1);
  assert.deepEqual(t.rpc.calls[0].args, { path: 'a.txt' });
  assert.equal(t.world.sent.length, 1);
  assert.match(t.world.sent[0], /^\[DevSpace result 1\/1\] read_file path=a\.txt — ok \(5 ms\)\n```text\nread_file output\n```\nContinue the task/);
  assert.equal(t.agent.getState().steps, 1);
  // processed only once even though it stays the latest model turn after more ticks
  t.world.turns.pop(); // pretend our result message is not there
  await settle(t);
  await settle(t);
  assert.equal(t.rpc.calls.length, 1);
});

test('changing text resets the stability timer', async () => {
  const t = await setup();
  userAsks(t);
  t.world.generating = true;
  await t.agent.tick();
  t.world.generating = false;
  const el = t.world.model(READ);
  await t.agent.tick();
  t.clock.t += 1000;
  t.world.turns.find((x) => x.el === el).text = 'Sure. (more)';
  await t.agent.tick();
  t.clock.t += 1000;
  await t.agent.tick();
  assert.equal(t.rpc.calls.length, 0);
  t.clock.t += 600;
  await t.agent.tick();
  await t.agent.whenIdle();
  assert.equal(t.rpc.calls.length, 1);
});

test('only the latest model turn is processed; a trailing user turn blocks processing', async () => {
  const t = await setup();
  userAsks(t);
  t.world.generating = true;
  await t.agent.tick();
  t.world.generating = false;
  t.world.model(READ);
  t.world.addTurn('user', 'actually, wait');
  await settle(t);
  assert.equal(t.rpc.calls.length, 0);
});

test('turns without tool calls just go idle', async () => {
  const t = await setup();
  userAsks(t);
  t.world.generating = true;
  await t.agent.tick();
  t.world.generating = false;
  t.world.addTurn('model', 'All done! The tests pass.', []);
  await settle(t);
  assert.equal(t.rpc.calls.length, 0);
  assert.equal(t.world.sent.length, 0);
  assert.equal(t.agent.getState().status, 'idle');
});

test('sequential execution stops at the first failure and tells the model', async () => {
  const t = await setup({
    handler: (tool, args) =>
      args.path === 'missing' ? { ok: false, output: 'ENOENT: missing', durationMs: 2 } : { ok: true, output: 'fine', durationMs: 1 },
  });
  await modelReplies(t, READ, { tool: 'read_file', args: { path: 'missing' } }, { tool: 'write_file', args: { path: 'x', content: 'y' } });
  assert.deepEqual(t.rpc.calls.map((c) => c.args.path), ['a.txt', 'missing']);
  const msg = t.world.sent[0];
  assert.match(msg, /\[DevSpace result 1\/2\] read_file path=a\.txt — ok/);
  assert.match(msg, /\[DevSpace result 2\/2\] read_file path=missing — error/);
  assert.match(msg, /1 more call\(s\) in your message were not run because call 2 did not succeed/);
});

test('maxCallsPerTurn caps execution and notes the rest', async () => {
  const t = await setup({ settings: { maxCallsPerTurn: 2 } });
  await modelReplies(t, READ, READ, READ, READ);
  assert.equal(t.rpc.calls.length, 2);
  assert.match(t.world.sent[0], /Only the first 2 calls .* 2 call\(s\) were ignored/);
});

test('invalid devspace blocks produce feedback even without valid calls', async () => {
  const t = await setup();
  await modelReplies(t, '{"tool": "teleport", "args": {}}');
  assert.equal(t.rpc.calls.length, 0);
  assert.match(t.world.sent[0], /^\[DevSpace note\] A devspace block could not be used \(unknown tool "teleport"\)/);
});

test('maxSteps pauses automatic round trips; 계속 resumes', async () => {
  const t = await setup({ settings: { maxSteps: 2 } });
  t.world.addTurn('user', 'do the task'); // real user input → steps reset
  await modelReplies(t, READ);
  await modelReplies(t, READ);
  assert.equal(t.agent.getState().steps, 2);
  await modelReplies(t, READ);
  assert.equal(t.rpc.calls.length, 2, 'third round trip paused');
  const st = t.agent.getState();
  assert.equal(st.status, 'paused');
  assert.equal(st.canResume, true);
  await t.agent.resume();
  await t.agent.whenIdle();
  assert.equal(t.rpc.calls.length, 3);
  assert.equal(t.agent.getState().steps, 1);
});

test('a real user message resets the step counter', async () => {
  const t = await setup({ settings: { maxSteps: 1 } });
  await modelReplies(t, READ);
  assert.equal(t.agent.getState().steps, 1);
  t.world.addTurn('user', 'please continue with the next file');
  await modelReplies(t, READ);
  assert.equal(t.rpc.calls.length, 2);
});

test('same calls in consecutive turns both run (no global signature set)', async () => {
  const t = await setup({ handler: () => ({ ok: true, output: 'same', durationMs: 1 }) });
  const npm = { tool: 'run_shell', args: { command: 'npm test' } };
  await modelReplies(t, npm);
  await modelReplies(t, npm);
  assert.equal(t.rpc.calls.length, 2);
});

test('a re-generated turn with different calls counts as new; identical calls do not', async () => {
  const t = await setup();
  userAsks(t);
  t.world.generating = true;
  await t.agent.tick();
  t.world.generating = false;
  const el = t.world.model(READ);
  await settle(t);
  assert.equal(t.rpc.calls.length, 1);
  // user deletes our result and reruns the model turn in place
  t.world.turns.pop();
  const turn = t.world.turns.find((x) => x.el === el);
  turn.blocks = [{ text: JSON.stringify({ tool: 'read_file', args: { path: 'b.txt' } }), lang: 'devspace' }];
  await settle(t);
  assert.equal(t.rpc.calls.length, 2);
  t.world.turns.pop();
  turn.blocks = [{ text: JSON.stringify({ tool: 'read_file', args: { path: 'b.txt' } }), lang: 'devspace' }];
  turn.el = el;
  await settle(t);
  assert.equal(t.rpc.calls.length, 2);
});

test('approval ask_shell: run_shell asks, reads do not; deny is reported to the model', async () => {
  const t = await setup({ settings: { approval: 'ask_shell' }, decisions: ['deny'] });
  await modelReplies(t, READ, { tool: 'run_shell', args: { command: 'rm -rf build' } }, READ);
  assert.deepEqual(t.ui.approvals, ['run_shell']);
  assert.equal(t.rpc.calls.length, 1);
  assert.match(t.world.sent[0], /run_shell `rm -rf build` — denied\n```text\nThe user denied this call\.\n```/);
  assert.match(t.world.sent[0], /1 more call\(s\)/);
});

test('approval ask_mutating + "이 탭에서 모두 자동 승인"', async () => {
  const t = await setup({ settings: { approval: 'ask_mutating' }, decisions: ['approve_all'] });
  await modelReplies(t, { tool: 'write_file', args: { path: 'x', content: '1' } }, { tool: 'edit_file', args: { path: 'x', edits: [] } });
  assert.deepEqual(t.ui.approvals, ['write_file']);
  assert.equal(t.rpc.calls.length, 2);
  assert.equal(t.agent.getState().autoApprove, true);
  assert.equal(t.storage.getTabAutoApprove(), true);
  await modelReplies(t, { tool: 'run_shell', args: { command: 'ls' } });
  assert.deepEqual(t.ui.approvals, ['write_file']);
  await t.agent.stop();
  assert.equal(t.agent.getState().autoApprove, false, 'stop clears tab auto-approve');
});

test('read_only auto-denies mutating calls without asking', async () => {
  const t = await setup({ settings: { approval: 'read_only' } });
  await modelReplies(t, { tool: 'apply_patch', args: { patch: '*** Begin Patch\n*** End Patch' } });
  assert.equal(t.rpc.calls.length, 0);
  assert.deepEqual(t.ui.approvals, []);
  assert.match(t.world.sent[0], /— denied\n```text\nDenied: GemInWeb is in read-only mode/);
});

test('send verification retries once, then leaves the text and tells the user', async () => {
  const t = await setup();
  t.world.sendMode = 'deadOnce';
  await modelReplies(t, READ);
  assert.equal(t.world.sendCalls, 2);
  assert.equal(t.world.sent.length, 1);

  t.world.sendMode = 'dead';
  await modelReplies(t, READ);
  assert.equal(t.world.sendCalls, 4);
  assert.match(t.world.input, /^\[DevSpace result/);
  assert.ok(t.ui.notes.some((n) => /직접 전송/.test(n.t)));
  assert.equal(t.agent.getState().steps, 1, 'failed send does not count as a step');
});

test('autoSend off: result is typed, not sent', async () => {
  const t = await setup({ settings: { autoSend: false } });
  await modelReplies(t, READ);
  assert.equal(t.world.sendCalls, 0);
  assert.match(t.world.input, /^\[DevSpace result 1\/1\]/);
});

test('open_workspace result sets and persists the workspace; later calls carry it', async () => {
  const t = await setup({
    handler: (tool) =>
      tool === 'open_workspace' ? { ok: true, output: 'root', durationMs: 1, workspace: 'C:\\repo' } : { ok: true, output: 'x', durationMs: 1 },
  });
  await modelReplies(t, { tool: 'cd', args: { path: 'C:\\repo' } }, READ);
  assert.equal(t.rpc.calls[0].workspace, null);
  assert.equal(t.rpc.calls[1].workspace, 'C:\\repo');
  assert.equal(t.agent.getState().workspace, 'C:\\repo');
  const conv = await t.storage.getConv('gemini:abc123');
  assert.equal(conv.workspace, 'C:\\repo');
});

test('host/transport error pauses; 계속 reports the lost call as failed instead of re-running it', async () => {
  let fail = true;
  const t = await setup({
    handler: (tool, args) => {
      if (args.path === 'b' && fail) throw new Error('네이티브 호스트가 설치되지 않았습니다 — install\\install.ps1 실행');
      return { ok: true, output: 'ok ' + args.path, durationMs: 1 };
    },
  });
  await modelReplies(t, { tool: 'read', args: { path: 'a' } }, { tool: 'read', args: { path: 'b' } }, { tool: 'read', args: { path: 'c' } });
  let st = t.agent.getState();
  assert.equal(st.status, 'error');
  assert.equal(st.canResume, true);
  assert.equal(t.world.sent.length, 0);
  assert.ok(t.ui.notes.some((n) => /install\.ps1/.test(n.t)));
  fail = false;
  await t.agent.resume();
  await t.agent.whenIdle();
  assert.deepEqual(t.rpc.calls.map((c) => c.args.path), ['a', 'b'], 'the dispatched call is never re-run, the rest is skipped');
  const msg = t.world.sent[0];
  assert.match(msg, /result 1\/2\] read_file path=a — ok[\s\S]*result 2\/2\] read_file path=b — error/);
  assert.match(msg, /lost the result of this call[\s\S]*may or may not have run/);
  assert.match(msg, /1 more call\(s\) in your message were not run because call 2 did not succeed/);
});

// ------------------------------------------------------------------ review fixes
test('baseline: a generation flicker alone never ends it (late history + flicker does not execute)', async () => {
  const t = await setup();
  // history renders late, with a spurious "generating" signal around it
  t.world.generating = true;
  await t.agent.tick();
  t.world.addTurn('user', 'old question');
  t.world.model({ tool: 'write_file', args: { path: 'x', content: 'old' } });
  await t.agent.tick();
  t.world.generating = false;
  await settle(t);
  await settle(t);
  assert.equal(t.rpc.calls.length, 0);
  // a second history chunk with another flicker
  t.world.generating = true;
  await t.agent.tick();
  t.world.generating = false;
  t.world.addTurn('user', 'older? no — later history');
  t.world.model({ tool: 'write_file', args: { path: 'y', content: 'old' } });
  await settle(t);
  assert.equal(t.rpc.calls.length, 0);
  assert.equal(t.agent.getState().baseline, true);
  // a real new user message ends the baseline and its reply runs
  await modelReplies(t, READ);
  assert.equal(t.rpc.calls.length, 1);
});

test('baseline ends after our own verified send', async () => {
  const t = await setup({ history: (w) => (w.addTurn('user', 'old'), w.model(READ)) });
  await t.agent.startTask('new task');
  assert.equal(t.agent.getState().baseline, false);
  await modelReplies(t, { tool: 'read_file', args: { path: 'new.txt' } });
  assert.deepEqual(t.rpc.calls.map((c) => c.args.path), ['new.txt']);
});

test('carry-over: opening an EXISTING conversation right after 작업 시작 in a new chat re-baselines', async () => {
  const t = await setup({ convId: null, path: '/app', on: false });
  await t.agent.startTask('build it');
  // within the 60 s window the user opens another, existing conversation
  t.world.convId = 'oldconv1';
  t.world.turns = [];
  t.world.addTurn('user', 'some old question');
  t.world.model({ tool: 'run_shell', args: { command: 'rm -rf old' } });
  t.world.generating = true; // even with a generating flicker
  await t.agent.tick();
  t.world.generating = false;
  await settle(t);
  await settle(t);
  assert.equal(t.rpc.calls.length, 0, 'historic call of the other conversation never runs');
  assert.equal(t.agent.getState().convKey, 'gemini:oldconv1');
  assert.equal(t.agent.getState().baseline, true);
});

test('carry-over waits briefly for our message to render, then decides', async () => {
  const t = await setup({ site: 'aistudio', convId: null, path: '/prompts/new_chat', on: false });
  await t.agent.startTask('go');
  const sentTurns = t.world.turns.slice();
  t.world.turns = []; // id arrives before the page re-rendered the chat
  t.world.convId = 'Abc123xyz';
  await t.agent.tick();
  assert.equal(t.agent.getState().convKey, 'aistudio:/prompts/new_chat', 'waiting');
  t.world.turns = sentTurns;
  await t.agent.tick();
  assert.equal(t.agent.getState().convKey, 'aistudio:Abc123xyz');
  assert.equal(t.agent.getState().baseline, false, 'carried over');
  await modelReplies(t, READ);
  assert.equal(t.rpc.calls.length, 1);
});

test('carry-over gives up after the wait when our message never shows up', async () => {
  const t = await setup({ convId: null, path: '/app', on: false });
  await t.agent.startTask('go');
  t.world.turns = [];
  t.world.convId = 'beef0001';
  await t.agent.tick();
  t.clock.t += 5000;
  await t.agent.tick();
  assert.equal(t.agent.getState().convKey, 'gemini:beef0001');
  assert.equal(t.agent.getState().baseline, true);
});

test('startTask claims the loop before awaiting the primer (no tick race)', async () => {
  const t = await setup();
  let releasePrimer;
  t.rpc.primer = () => new Promise((r) => (releasePrimer = () => r({ text: 'P' })));
  // a reply-able model turn is pending when the user starts a task
  userAsks(t);
  t.world.generating = true;
  await t.agent.tick();
  t.world.generating = false;
  t.world.model(READ);
  await t.agent.tick();
  t.clock.t += 1600;
  const p = t.agent.startTask('task');
  await t.agent.tick(); // would start a run if busy were not set yet
  assert.equal(t.rpc.calls.length, 0);
  assert.equal(t.agent.getState().busy, true);
  releasePrimer();
  assert.equal(await p, true);
  assert.equal(t.agent.getState().busy, false);
});

test('approval policy: fetch_url and .git writes are treated like run_shell; read_only denies fetch_url', async () => {
  const t = await setup({ settings: { approval: 'ask_shell' }, decisions: ['approve', 'approve', 'approve', 'approve'] });
  await modelReplies(
    t,
    { tool: 'fetch_url', args: { url: 'https://example.com' } },
    { tool: 'write_file', args: { path: 'src/.git/hooks/pre-commit', content: 'x' } },
    { tool: 'write_file', args: { path: 'src/ok.txt', content: 'x' } },
    { tool: 'apply_patch', args: { patch: '*** Begin Patch\n*** Add File: .GIT/config\n+x\n*** End Patch' } },
    { tool: 'edit_file', args: { path: 'a\\.git\\config', edits: [{ old_text: 'a', new_text: 'b' }] } }
  );
  assert.deepEqual(t.ui.approvals, ['fetch_url', 'write_file', 'apply_patch', 'edit_file']);
  assert.equal(t.rpc.calls.length, 5);

  const r = await setup({ settings: { approval: 'read_only' } });
  await modelReplies(r, { tool: 'fetch_url', args: { url: 'https://example.com' } });
  assert.equal(r.rpc.calls.length, 0);
  assert.match(r.world.sent[0], /— denied[\s\S]*read-only mode/);

  const a = await setup({ settings: { approval: 'auto' } });
  await modelReplies(a, { tool: 'fetch_url', args: { url: 'https://example.com' } });
  assert.deepEqual(a.ui.approvals, []);
});

test('중지 cancels the in-flight call via RPC cancel and nothing is sent', async () => {
  let release;
  const t = await setup({
    handler: () =>
      new Promise((r) => {
        release = () => r({ ok: false, cancelled: true, output: 'cancelled', durationMs: 1 });
      }),
  });
  userAsks(t);
  t.world.generating = true;
  await t.agent.tick();
  t.world.generating = false;
  t.world.model({ tool: 'run_shell', args: { command: 'sleep 100' } });
  await t.agent.tick();
  t.clock.t += 1600;
  await t.agent.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.rpc.calls.length, 1);
  const id = t.rpc.calls[0].id;
  await t.agent.stop();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.rpc.cancels, [id]);
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.world.sent.length, 0);
  const st = t.agent.getState();
  assert.equal(st.on, false);
  assert.equal(st.status, 'off');
  assert.equal(t.storage.getTabOn(), false);
  // disarmed: new turns are ignored
  await modelReplies(t, READ);
  assert.equal(t.rpc.calls.length, 1);
});

test('작업 시작 sends primer + task, arms, and marks the conversation primed', async () => {
  const t = await setup({ on: false });
  assert.equal(t.agent.getState().on, false);
  const ok = await t.agent.startTask('테스트를 실행해 줘');
  assert.equal(ok, true);
  assert.deepEqual(plain(t.rpc.primers), [{ site: 'gemini', mode: 'full', workspace: null }]);
  assert.equal(t.world.sent[0], '[GemInWeb protocol v1] (full)\n\n테스트를 실행해 줘');
  assert.equal(t.agent.getState().on, true);
  const conv = await t.storage.getConv('gemini:abc123');
  assert.equal(conv.primed, true);
  assert.equal(conv.armed, true);
  // second task in the same chat only sends the short context block
  await t.agent.startTask('next');
  assert.equal(t.rpc.primers[1].mode, 'context');
  // the reply to our task is processed (send ended the baseline)
  await modelReplies(t, READ);
  assert.equal(t.rpc.calls.length, 1);
});

test('new chat: id assigned after the first send carries state over (no re-baseline)', async () => {
  const t = await setup({ convId: null, path: '/app', on: false });
  await t.agent.startTask('build it');
  assert.equal(t.agent.getState().convKey, 'gemini:/app');
  // Gemini assigns the id while the model is generating; the reply then appears
  t.world.generating = true;
  t.world.convId = 'f00dbabe';
  await t.agent.tick();
  t.world.generating = false;
  t.world.model(READ);
  await settle(t);
  assert.equal(t.agent.getState().convKey, 'gemini:f00dbabe');
  assert.equal(t.rpc.calls.length, 1);
  const conv = await t.storage.getConv('gemini:f00dbabe');
  assert.equal(conv.primed, true);
  assert.equal(conv.armed, true);
  assert.equal(await t.storage.getConv('gemini:/app'), null);
});

test('conversation switch re-baselines; switching to an armed conversation turns the tab ON', async () => {
  const storage = DSG.memoryStorage();
  await storage.setConv('gemini:other', { armed: true, workspace: 'D:\\w' });
  const t = await setup({ on: false, storage });
  assert.equal(t.agent.getState().on, false);
  // SPA navigation to an armed conversation whose history renders afterwards
  t.world.convId = 'other';
  t.world.turns = [];
  await t.agent.tick();
  let st = t.agent.getState();
  assert.equal(st.on, true);
  assert.equal(st.workspace, 'D:\\w');
  assert.equal(t.storage.getTabOn(), true);
  t.world.addTurn('user', 'old');
  t.world.model(READ);
  await settle(t);
  assert.equal(t.rpc.calls.length, 0, 'historic turn of the switched-to conversation is not executed');
  // and new work there still runs
  await modelReplies(t, READ);
  assert.equal(t.rpc.calls.length, 1);
});

test('switching away mid-run aborts it (nothing is typed into the other chat)', async () => {
  let release;
  const t = await setup({
    handler: () => new Promise((r) => (release = () => r({ ok: true, output: 'x', durationMs: 1 }))),
  });
  userAsks(t);
  t.world.generating = true;
  await t.agent.tick();
  t.world.generating = false;
  t.world.model(READ);
  await t.agent.tick();
  t.clock.t += 1600;
  await t.agent.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.rpc.calls.length, 1);
  t.world.convId = 'zzz999';
  await t.agent.tick();
  assert.equal(t.rpc.cancels.length, 1);
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.world.sent.length, 0);
  assert.equal(t.agent.getState().on, true, 'tab stays ON across navigation');
});

test('tab ON state survives a reload (init re-arms with a fresh baseline)', async () => {
  const storage = DSG.memoryStorage();
  storage.setTabOn(true);
  const t = await setup({ on: false, storage, history: (w) => w.model(READ) });
  assert.equal(t.agent.getState().on, true);
  await settle(t);
  assert.equal(t.rpc.calls.length, 0);
});

test('pushSystemInstructions (AI Studio) marks the chat as primed via system', async () => {
  const t = await setup({ site: 'aistudio' });
  assert.equal(await t.agent.pushSystemInstructions(), true);
  assert.match(t.world.system, /protocol v1/);
  await t.agent.startTask('go');
  assert.equal(t.rpc.primers.at(-1).mode, 'context');
  assert.equal(t.rpc.primers.at(-1).site, 'aistudio');
});

test('setWorkspace validates through open_workspace', async () => {
  const t = await setup({
    handler: (tool, args) =>
      args.path === 'nope' ? { ok: false, output: 'outside allowedRoots' } : { ok: true, output: 'ok', workspace: 'C:\\abs\\' + args.path },
  });
  assert.equal((await t.agent.setWorkspace('proj')).ok, true);
  assert.equal(t.agent.getState().workspace, 'C:\\abs\\proj');
  const bad = await t.agent.setWorkspace('nope');
  assert.equal(bad.ok, false);
  assert.equal(t.agent.getState().workspace, 'C:\\abs\\proj');
  await t.agent.setWorkspace('');
  assert.equal(t.agent.getState().workspace, null);
});

test('result message respects the per-site cap', async () => {
  const t = await setup({ settings: { maxMessageChars: { gemini: 3000 } }, handler: () => ({ ok: true, output: 'z'.repeat(20000), durationMs: 1 }) });
  await modelReplies(t, READ);
  assert.ok(t.world.sent[0].length <= 3000);
  assert.match(t.world.sent[0], /chars truncated/);
});

test('identical calls with identical results keep looping (generation marks novelty)', async () => {
  const t = await setup({ handler: () => ({ ok: true, output: 'same', durationMs: 1 }) });
  await modelReplies(t, READ);
  await modelReplies(t, READ);
  await modelReplies(t, READ);
  assert.equal(t.rpc.calls.length, 3);
});

test('a re-rendered (new element, same content) turn without generation is not re-run', async () => {
  const t = await setup();
  t.world.sendMode = 'dead'; // result could not be sent → the handled turn stays the latest
  await modelReplies(t, READ);
  assert.equal(t.rpc.calls.length, 1);
  // framework re-creates every element (e.g. virtual scroll) — same content, no generation
  t.world.turns = t.world.turns.map((x) => ({ ...x, el: { n: ++t.world.seq } }));
  await settle(t);
  await settle(t);
  assert.equal(t.rpc.calls.length, 1);
});

test('new chat id arriving while a call is running does not abort the run', async () => {
  let release;
  const t = await setup({
    site: 'aistudio',
    convId: null,
    path: '/prompts/new_chat',
    handler: () => new Promise((r) => (release = () => r({ ok: true, output: 'x', durationMs: 1 }))),
  });
  await t.agent.startTask('go');
  t.world.generating = true;
  await t.agent.tick();
  t.world.generating = false;
  t.world.model(READ);
  await t.agent.tick();
  t.clock.t += 120000; // long reply → outside the time window, but a run is active
  await t.agent.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.rpc.calls.length, 1);
  t.world.convId = 'Xyz123abc';
  await t.agent.tick();
  assert.equal(t.rpc.cancels.length, 0);
  release();
  await t.agent.whenIdle();
  assert.equal(t.world.sent.length, 2, 'task + result');
  assert.equal(t.agent.getState().convKey, 'aistudio:Xyz123abc');
});
