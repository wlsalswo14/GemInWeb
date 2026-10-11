import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts, plain } from './_load.mjs';

const ctx = loadScripts(['defaults.js', 'background.js']);
const BG = ctx.DSG_BG;

function fakeEnv({ settings, onPost, fetchImpl } = {}) {
  const ports = [];
  const timers = [];
  const chrome = {
    runtime: {
      id: 'ekplpihmkdcielcfideebgocdkajifcc',
      lastError: null,
      connectNative(name) {
        assert.equal(name, 'com.devspace.gem');
        const l = {};
        const port = {
          posted: [],
          onMessage: { addListener: (f) => (l.msg = f) },
          onDisconnect: { addListener: (f) => (l.disc = f) },
          postMessage(m) {
            if (port.dead) throw new Error('Attempting to use a disconnected port object');
            port.posted.push(m);
            if (onPost) queueMicrotask(() => onPost(m, port));
          },
          reply: (m) => l.msg(m),
          die(message) {
            port.dead = true;
            chrome.runtime.lastError = { message };
            l.disc();
            chrome.runtime.lastError = null;
          },
        };
        ports.push(port);
        return port;
      },
      getPlatformInfo: (cb) => cb && cb({}),
      openOptionsPage() {
        chrome.opened = (chrome.opened || 0) + 1;
      },
    },
    storage: {
      local: { get: (k, cb) => cb({ [k]: settings || undefined }) },
      onChanged: { addListener() {} },
    },
  };
  const bridge = BG.createBridge({
    chrome,
    fetch: fetchImpl,
    setTimeout: (f, ms) => {
      timers.push({ f, ms });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
  });
  return { chrome, ports, timers, bridge };
}

const tab = { tab: { id: 7 }, id: 'ekplpihmkdcielcfideebgocdkajifcc' };

test('timeouts: call = requested timeout + 30 s (default 120 s), others 15 s', () => {
  assert.equal(BG.timeoutFor({ type: 'call', tool: 'run_shell', args: { timeout: 600 } }), 630000);
  assert.equal(BG.timeoutFor({ type: 'call', tool: 'read_file', args: {} }), 150000);
  assert.equal(BG.timeoutFor({ type: 'status' }), 15000);
  assert.equal(BG.timeoutFor({ type: 'primer' }), 15000);
});

test('timeouts: every timeout spelling core accepts; capped by the host max; host default used', () => {
  for (const k of ['timeout', 'timeout_sec', 'timeoutSec', 'timeout_seconds']) {
    assert.equal(BG.timeoutFor({ type: 'call', tool: 'run_shell', args: { [k]: 300 } }), 330000, k);
  }
  assert.equal(BG.timeoutFor({ type: 'call', tool: 'run_shell', args: { timeout: 5000 } }), 1830000, 'default cap 1800 s');
  assert.equal(BG.timeoutFor({ type: 'call', tool: 'run_shell', args: { timeout: 5000 } }, 120, 3600), 3630000, 'host max 3600 s');
  assert.equal(BG.timeoutFor({ type: 'call', tool: 'run_shell', args: { timeout: 900 } }, 120, 600), 630000, 'host max 600 s');
  assert.equal(BG.timeoutFor({ type: 'call', tool: 'run_shell', args: {} }, 300, 1800), 330000, 'host default');
});

test('native: request ids are namespaced per tab and mapped back', async () => {
  const env = fakeEnv({ onPost: (m, port) => port.reply({ id: m.id, ok: true, result: { pong: true } }) });
  const r = await env.bridge.handleRpc({ id: 'abc', type: 'ping' }, tab);
  assert.deepEqual(plain(r), { id: 'abc', ok: true, result: { pong: true } });
  assert.equal(env.ports[0].posted[0].id, 't7:abc');
  // cancel target gets the same namespace
  await env.bridge.handleRpc({ id: 'c1', type: 'cancel', target: 'abc' }, tab);
  assert.equal(env.ports[0].posted[1].target, 't7:abc');
  assert.equal(env.ports.length, 1, 'port reused');
});

test('native: host not installed → friendly Korean error, lazy reconnect next time', async () => {
  let first = true;
  const env = fakeEnv({
    onPost: (m, port) => {
      if (first) {
        first = false;
        port.die('Specified native messaging host not found.');
      } else port.reply({ id: m.id, ok: true, result: {} });
    },
  });
  const r = await env.bridge.handleRpc({ id: 'x', type: 'status' }, tab);
  assert.equal(r.ok, false);
  assert.equal(r.error, '네이티브 호스트가 설치되지 않았습니다 — install\\install.ps1 실행');
  assert.equal(r.id, 'x');
  const r2 = await env.bridge.handleRpc({ id: 'y', type: 'status' }, tab);
  assert.equal(r2.ok, true);
  assert.equal(env.ports.length, 2);
});

test('native: host exit rejects all pending requests', async () => {
  const env = fakeEnv();
  const p1 = env.bridge.handleRpc({ id: 'a', type: 'call', tool: 'run_shell', args: { command: 'x' } }, tab);
  const p2 = env.bridge.handleRpc({ id: 'b', type: 'ping' }, tab);
  await new Promise((r) => setImmediate(r));
  env.ports[0].die('Native host has exited.');
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.match(r1.error, /종료/);
  assert.match(r2.error, /종료/);
  assert.equal(env.bridge._pending.size, 0);
});

test('native: timeout resolves with an error and cancels the call on the host', async () => {
  const env = fakeEnv();
  const p = env.bridge.handleRpc({ id: 'slow', type: 'call', tool: 'run_shell', args: { command: 'sleep 9', timeout: 5 } }, tab);
  await new Promise((r) => setImmediate(r));
  const t = env.timers.find((x) => !x.cleared);
  assert.equal(t.ms, 35000);
  t.f();
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /시간 초과/);
  const cancel = env.ports[0].posted.find((m) => m.type === 'cancel');
  assert.equal(cancel.target, 't7:slow');
  // a late response is ignored
  env.ports[0].reply({ id: 't7:slow', ok: true, result: {} });
});

test('http transport: POST {httpUrl}/rpc with Bearer token', async () => {
  const seen = [];
  const env = fakeEnv({
    settings: { transport: 'http', httpUrl: 'http://127.0.0.1:7679/', httpToken: 'tok123' },
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      const body = JSON.parse(init.body);
      return { status: 200, json: async () => ({ id: body.id, ok: true, result: { version: '1' } }) };
    },
  });
  const r = await env.bridge.handleRpc({ id: 'h1', type: 'status' }, tab);
  assert.deepEqual(plain(r), { id: 'h1', ok: true, result: { version: '1' } });
  assert.equal(seen[0].url, 'http://127.0.0.1:7679/rpc');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer tok123');
  assert.equal(JSON.parse(seen[0].init.body).id, 't7:h1');
  assert.equal(env.ports.length, 0, 'no native port used');
});

test('http transport: auth failure and unreachable server', async () => {
  const env401 = fakeEnv({ settings: { transport: 'http' }, fetchImpl: async () => ({ status: 401, json: async () => ({}) }) });
  assert.match((await env401.bridge.handleRpc({ id: 'a', type: 'status' }, tab)).error, /인증 실패/);
  const envDown = fakeEnv({
    settings: { transport: 'http' },
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.match((await envDown.bridge.handleRpc({ id: 'b', type: 'status' }, tab)).error, /연결할 수 없습니다/);
});

test('onMessage: dsg.rpc responds asynchronously; dsg.openOptions opens the options page', async () => {
  const env = fakeEnv({ onPost: (m, port) => port.reply({ id: m.id, ok: true, result: 1 }) });
  const resp = await new Promise((resolve) => {
    const keep = env.bridge.onMessage({ type: 'dsg.rpc', request: { id: 'q', type: 'ping' } }, tab, resolve);
    assert.equal(keep, true);
  });
  assert.equal(resp.ok, true);
  env.bridge.onMessage({ type: 'dsg.openOptions' }, tab, () => {});
  assert.equal(env.chrome.opened, 1);
  assert.equal(env.bridge.onMessage({ type: 'dsg.rpc', request: {} }, { id: 'other-extension' }, () => {}), false);
});

test('tab flags live in chrome.storage.session per tab + site (not page-writable sessionStorage)', async () => {
  const env = fakeEnv();
  const store = {};
  env.chrome.storage.session = {
    get: (k, cb) => cb({ [k]: store[k] }),
    set: (o, cb) => (Object.assign(store, JSON.parse(JSON.stringify(o))), cb && cb()),
  };
  const ask = (msg, sender = tab) => new Promise((resolve) => assert.equal(env.bridge.onMessage(msg, sender, resolve), true));
  assert.deepEqual(plain(await ask({ type: 'dsg.tabState', op: 'get', site: 'gemini' })), { ok: true, state: { agentOn: false, autoApprove: false } });
  await ask({ type: 'dsg.tabState', op: 'set', site: 'gemini', patch: { agentOn: true, bogus: 1 } });
  assert.deepEqual(plain(store), { 'dsg.tab.7.gemini': { agentOn: true } });
  assert.equal((await ask({ type: 'dsg.tabState', op: 'get', site: 'gemini' })).state.agentOn, true);
  assert.equal((await ask({ type: 'dsg.tabState', op: 'get', site: 'aistudio' })).state.agentOn, false, 'per site');
  assert.equal((await ask({ type: 'dsg.tabState', op: 'get', site: 'gemini' }, { tab: { id: 8 }, id: tab.id })).state.agentOn, false, 'per tab');
  assert.equal((await ask({ type: 'dsg.tabState', op: 'get', site: 'gemini' }, { id: tab.id })).ok, false, 'needs a tab');
});

test('bad requests are rejected without touching the transport', async () => {
  const env = fakeEnv();
  const r = await env.bridge.handleRpc({ id: 'z' }, tab);
  assert.equal(r.ok, false);
  assert.equal(env.ports.length, 0);
});
