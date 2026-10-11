/* GemInWeb — content-side RPC client, settings and per-conversation memory.
 * All host traffic goes through the background service worker (dsg.rpc). */
(function (g) {
  'use strict';
  const DSG = (g.DSG = g.DSG || {});

  // Keep in sync with extension/defaults.js (a test asserts equality).
  const DEFAULT_SETTINGS = {
    transport: 'native',
    httpUrl: 'http://127.0.0.1:7679',
    httpToken: '',
    approval: 'ask_shell',
    maxSteps: 25,
    maxCallsPerTurn: 6,
    maxMessageChars: { gemini: 24000, aistudio: 80000 },
    primerMode: 'full',
    autoSend: true,
  };
  const SETTINGS_KEY = 'dsg.settings';
  const CONV_KEY = 'dsg.conv';
  const CONV_LIMIT = 200;

  function mergeSettings(stored) {
    const s = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    s.maxMessageChars = Object.assign({}, DEFAULT_SETTINGS.maxMessageChars, (stored && stored.maxMessageChars) || {});
    return s;
  }

  function chromeApi() {
    return g.chrome && g.chrome.runtime && g.chrome.runtime.id ? g.chrome : null;
  }

  function friendly(err) {
    const m = String((err && err.message) || err || '');
    if (/context invalidated/i.test(m)) return '확장 프로그램이 다시 로드되었습니다 — 페이지를 새로고침하세요';
    if (/message port closed|receiving end does not exist/i.test(m)) return '백그라운드와 연결이 끊어졌습니다 — 다시 시도하세요';
    return m || '알 수 없는 오류';
  }

  class RpcError extends Error {
    constructor(message, envelope) {
      super(message);
      this.name = 'RpcError';
      this.envelope = envelope || null;
    }
  }

  let seq = 0;
  function newId() {
    seq = (seq + 1) % 1e6;
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + seq.toString(36);
  }

  /** Low-level: send an envelope through the background; resolves with the response envelope. */
  function request(type, fields, opts) {
    const id = (opts && opts.id) || newId();
    const req = Object.assign({ id, type }, fields || {});
    return new Promise((resolve) => {
      const c = chromeApi();
      if (!c) return resolve({ id, ok: false, error: friendly('Extension context invalidated.'), transport: true });
      try {
        c.runtime.sendMessage({ type: 'dsg.rpc', request: req }, (resp) => {
          const le = c.runtime.lastError;
          if (le) return resolve({ id, ok: false, error: friendly(le), transport: true });
          if (!resp || typeof resp !== 'object') return resolve({ id, ok: false, error: '백그라운드 응답 없음', transport: true });
          resolve(resp);
        });
      } catch (e) {
        resolve({ id, ok: false, error: friendly(e), transport: true });
      }
    });
  }

  async function unwrap(p) {
    const env = await p;
    if (!env.ok) throw new RpcError(env.error || 'RPC 실패', env);
    return env.result;
  }

  const rpc = {
    newId,
    request,
    RpcError,
    ping: () => unwrap(request('ping')),
    status: () => unwrap(request('status')),
    tools: () => unwrap(request('tools')),
    primer: (site, mode, workspace) => unwrap(request('primer', { site, mode, workspace: workspace || undefined })),
    /** → result {ok, output, durationMs, ...}; throws RpcError on protocol/transport failure. */
    call: (tool, args, workspace, opts) =>
      unwrap(request('call', { tool, args: args || {}, workspace: workspace || null }, { id: opts && opts.id })),
    cancel: (target) => unwrap(request('cancel', { target })),
  };

  // ------------------------------------------------------------ storage helpers
  function storageGet(key) {
    return new Promise((resolve) => {
      const c = chromeApi();
      if (!c || !c.storage) return resolve(undefined);
      try {
        c.storage.local.get(key, (o) => resolve(o ? o[key] : undefined));
      } catch (_) {
        resolve(undefined);
      }
    });
  }
  function storageSet(key, value) {
    return new Promise((resolve) => {
      const c = chromeApi();
      if (!c || !c.storage) return resolve(false);
      try {
        c.storage.local.set({ [key]: value }, () => resolve(true));
      } catch (_) {
        resolve(false);
      }
    });
  }

  const settings = {
    DEFAULTS: DEFAULT_SETTINGS,
    merge: mergeSettings,
    async load() {
      return mergeSettings(await storageGet(SETTINGS_KEY));
    },
    async save(patch) {
      const cur = await settings.load();
      const next = mergeSettings(Object.assign({}, cur, patch || {}));
      await storageSet(SETTINGS_KEY, next);
      return next;
    },
    onChange(cb) {
      const c = chromeApi();
      if (!c || !c.storage || !c.storage.onChanged) return;
      c.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[SETTINGS_KEY]) cb(mergeSettings(changes[SETTINGS_KEY].newValue));
      });
    },
  };

  // Serialize read-modify-write cycles on the conversation map.
  let convChain = Promise.resolve();
  function pruneConv(map) {
    const keys = Object.keys(map);
    if (keys.length <= CONV_LIMIT) return map;
    keys.sort((a, b) => (map[b].updatedAt || 0) - (map[a].updatedAt || 0));
    const out = {};
    for (const k of keys.slice(0, CONV_LIMIT)) out[k] = map[k];
    return out;
  }

  const tabCache = { agentOn: false, autoApprove: false };
  function tabStateMsg(fields) {
    return new Promise((resolve) => {
      const c = chromeApi();
      if (!c) return resolve(null);
      const site = DSG.detectSite ? DSG.detectSite(g.location) : null;
      try {
        c.runtime.sendMessage(Object.assign({ type: 'dsg.tabState', site }, fields), (resp) => {
          void c.runtime.lastError;
          resolve(resp || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  /** Storage interface consumed by agent.js */
  const agentStorage = {
    async getConv(key) {
      const map = (await storageGet(CONV_KEY)) || {};
      return map[key] || null;
    },
    setConv(key, patch) {
      convChain = convChain.then(async () => {
        const map = (await storageGet(CONV_KEY)) || {};
        map[key] = Object.assign({}, map[key] || {}, patch || {}, { updatedAt: Date.now() });
        await storageSet(CONV_KEY, pruneConv(map));
        return map[key];
      });
      return convChain;
    },
    deleteConv(key) {
      convChain = convChain.then(async () => {
        const map = (await storageGet(CONV_KEY)) || {};
        delete map[key];
        await storageSet(CONV_KEY, map);
      });
      return convChain;
    },
    // Tab flags live in the background (chrome.storage.session, per tab + site) — NOT in the
    // page's sessionStorage, which page scripts could write to arm the agent / auto-approve.
    // loadTab() fills the cache once at boot; getters stay synchronous for agent.js.
    async loadTab() {
      const r = await tabStateMsg({ op: 'get' });
      if (r && r.ok && r.state) Object.assign(tabCache, { agentOn: !!r.state.agentOn, autoApprove: !!r.state.autoApprove });
      return Object.assign({}, tabCache);
    },
    getTabOn() {
      return tabCache.agentOn;
    },
    setTabOn(on) {
      tabCache.agentOn = !!on;
      tabStateMsg({ op: 'set', patch: { agentOn: !!on } });
    },
    getTabAutoApprove() {
      return tabCache.autoApprove;
    },
    setTabAutoApprove(on) {
      tabCache.autoApprove = !!on;
      tabStateMsg({ op: 'set', patch: { autoApprove: !!on } });
    },
  };

  function openOptions() {
    const c = chromeApi();
    if (!c) return;
    try {
      c.runtime.sendMessage({ type: 'dsg.openOptions' }, () => void (c.runtime && c.runtime.lastError));
    } catch (_) {
      /* ignore */
    }
  }

  async function copyText(text) {
    try {
      if (g.navigator && g.navigator.clipboard && g.navigator.clipboard.writeText) {
        await g.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      /* fall back */
    }
    try {
      const d = g.document;
      const ta = d.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      d.body.appendChild(ta);
      ta.select();
      const ok = d.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  DSG.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  DSG.rpc = rpc;
  DSG.settings = settings;
  DSG.agentStorage = agentStorage;
  DSG.openOptions = openOptions;
  DSG.copyText = copyText;
  DSG.friendlyError = friendly;
})(typeof globalThis !== 'undefined' ? globalThis : this);
