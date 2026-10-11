/* GemInWeb — background service worker (classic).
 * Content scripts send {type:"dsg.rpc", request} and get the response envelope back.
 * Transports: native messaging (default, com.devspace.gem) or HTTP fallback (POST {httpUrl}/rpc). */
'use strict';
/* global importScripts */
if (typeof importScripts === 'function') {
  try {
    importScripts('defaults.js');
  } catch (_) {
    /* tests load defaults.js themselves */
  }
}

(function (g) {
  const HOST_NAME = 'com.devspace.gem';
  const DEFAULT_TIMEOUT_MS = 15000;
  const CALL_GRACE_MS = 30000;
  const DEFAULT_CALL_TIMEOUT_SEC = 120; // core's default commandTimeoutSec
  const MAX_CALL_TIMEOUT_SEC = 1800;

  const MSG_NOT_INSTALLED = '네이티브 호스트가 설치되지 않았습니다 — install\\install.ps1 실행';

  // Every spelling of the timeout argument core accepts.
  const TIMEOUT_KEYS = ['timeout', 'timeout_sec', 'timeoutSec', 'timeout_seconds'];

  /** Request timeout: call → requested timeout (or the host's default, 120 s) capped at the host's
   * maxCommandTimeoutSec (1800 s until learned) + 30 s; everything else 15 s. */
  function timeoutFor(req, defaultCallSec, maxCallSec) {
    if (req && req.type === 'call') {
      const a = (req.args && typeof req.args === 'object' && req.args) || {};
      let t = 0;
      for (const k of TIMEOUT_KEYS) {
        const v = Number(a[k]);
        if (v > 0) {
          t = v;
          break;
        }
      }
      const max = Number(maxCallSec) > 0 ? Number(maxCallSec) : MAX_CALL_TIMEOUT_SEC;
      const def = Number(defaultCallSec) > 0 ? Number(defaultCallSec) : DEFAULT_CALL_TIMEOUT_SEC;
      const sec = Math.min(t > 0 ? t : def, max);
      return sec * 1000 + CALL_GRACE_MS;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  function friendlyNative(message) {
    const m = String(message || '');
    if (/not found/i.test(m)) return MSG_NOT_INSTALLED;
    if (/forbidden/i.test(m)) return '네이티브 호스트가 이 확장 프로그램을 허용하지 않습니다 — install\\install.ps1 다시 실행 (확장 ID 확인)';
    if (/exited|has exited/i.test(m))
      return '네이티브 호스트가 종료되었습니다 — %USERPROFILE%\\.devspace-gem\\logs\\host.log 확인 (Node 설치 / install\\install.ps1 재실행)';
    if (/failed to start|error when communicating/i.test(m))
      return '네이티브 호스트를 시작하지 못했습니다 — install\\install.ps1 재실행 (' + m + ')';
    return m ? '네이티브 호스트 오류: ' + m : '네이티브 호스트 연결이 끊어졌습니다';
  }

  function createBridge(deps) {
    const chrome = deps.chrome;
    const fetchImpl = deps.fetch;
    const setTimeoutFn = deps.setTimeout || setTimeout;
    const clearTimeoutFn = deps.clearTimeout || clearTimeout;
    const mergeSettings = deps.mergeSettings || g.DSG_mergeSettings;
    const SETTINGS_KEY = g.DSG_SETTINGS_KEY || 'dsg.settings';

    let port = null;
    const pending = new Map(); // id → { resolve, timer, port }
    let inflightHttp = 0;
    let keepAlive = null;

    // ---------------------------------------------------------- settings
    let cached = null;
    function getSettings() {
      if (cached) return Promise.resolve(cached);
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(SETTINGS_KEY, (o) => {
            cached = mergeSettings(o && o[SETTINGS_KEY]);
            resolve(cached);
          });
        } catch (_) {
          resolve(mergeSettings(null));
        }
      });
    }
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[SETTINGS_KEY]) cached = mergeSettings(changes[SETTINGS_KEY].newValue);
      });
    }

    // ---------------------------------------------------------- keep-alive while work is pending
    function updateKeepAlive() {
      const busy = pending.size > 0 || inflightHttp > 0;
      if (busy && !keepAlive) {
        keepAlive = setInterval(() => {
          try {
            chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
          } catch (_) {
            /* ignore */
          }
        }, 20000);
      } else if (!busy && keepAlive) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    }

    // ---------------------------------------------------------- native transport
    function transportError(id, error) {
      return { id, ok: false, error, transport: true };
    }

    function ensurePort() {
      if (port) return port;
      const p = chrome.runtime.connectNative(HOST_NAME);
      port = p;
      p.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        const e = pending.get(msg.id);
        if (!e) return;
        pending.delete(msg.id);
        clearTimeoutFn(e.timer);
        updateKeepAlive();
        e.resolve(msg);
      });
      p.onDisconnect.addListener(() => {
        const le = chrome.runtime.lastError;
        const err = friendlyNative(le && le.message);
        if (port === p) port = null;
        for (const [id, e] of Array.from(pending)) {
          if (e.port !== p) continue;
          pending.delete(id);
          clearTimeoutFn(e.timer);
          e.resolve(transportError(id, err));
        }
        updateKeepAlive();
      });
      return p;
    }

    function sendNative(req, ms) {
      return new Promise((resolve) => {
        let p;
        try {
          p = ensurePort();
        } catch (e) {
          port = null;
          return resolve(transportError(req.id, friendlyNative(e && e.message)));
        }
        const timer = setTimeoutFn(() => {
          if (!pending.has(req.id)) return;
          pending.delete(req.id);
          updateKeepAlive();
          if (req.type === 'call') {
            try {
              p.postMessage({ id: req.id + ':timeout-cancel', type: 'cancel', target: req.id });
            } catch (_) {
              /* ignore */
            }
          }
          resolve(transportError(req.id, `호스트 응답 시간 초과 (${Math.round(ms / 1000)}초)`));
        }, ms);
        pending.set(req.id, { resolve, timer, port: p });
        updateKeepAlive();
        try {
          p.postMessage(req);
        } catch (e) {
          pending.delete(req.id);
          clearTimeoutFn(timer);
          if (port === p) port = null;
          updateKeepAlive();
          resolve(transportError(req.id, friendlyNative(e && e.message)));
        }
      });
    }

    // ---------------------------------------------------------- HTTP transport
    async function sendHttp(req, ms, s) {
      const base = String(s.httpUrl || 'http://127.0.0.1:7679').replace(/\/+$/, '');
      const url = base + '/rpc';
      inflightHttp++;
      updateKeepAlive();
      let ctrl = null;
      let timer = null;
      try {
        ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        let timedOut = false;
        timer = setTimeoutFn(() => {
          timedOut = true;
          if (ctrl) ctrl.abort();
        }, ms);
        let r;
        try {
          r = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s.httpToken || '') },
            body: JSON.stringify(req),
            signal: ctrl ? ctrl.signal : undefined,
          });
        } catch (e) {
          if (timedOut) {
            if (req.type === 'call') {
              fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s.httpToken || '') },
                body: JSON.stringify({ id: req.id + ':timeout-cancel', type: 'cancel', target: req.id }),
              }).catch(() => {});
            }
            return transportError(req.id, `HTTP 서버 응답 시간 초과 (${Math.round(ms / 1000)}초)`);
          }
          return transportError(req.id, `HTTP 서버에 연결할 수 없습니다 (${base}) — node server\\http-server.mjs 실행 여부 확인`);
        }
        if (r.status === 401 || r.status === 403) {
          return transportError(req.id, 'HTTP 인증 실패 — 옵션의 토큰을 확인하세요 (%USERPROFILE%\\.devspace-gem\\http-token)');
        }
        let body = null;
        try {
          body = await r.json();
        } catch (_) {
          body = null;
        }
        if (body && typeof body === 'object' && 'ok' in body) return Object.assign({}, body, { id: req.id });
        return transportError(req.id, `HTTP ${r.status} — 예상하지 못한 응답`);
      } finally {
        if (timer) clearTimeoutFn(timer);
        inflightHttp--;
        updateKeepAlive();
      }
    }

    // ---------------------------------------------------------- dispatch
    // The host's commandTimeoutSec, learned from status replies, so a run_shell without
    // an explicit timeout isn't cut off here before the host gives up on it.
    let hostCallSec = 0;
    let hostMaxSec = 0; // host's maxCommandTimeoutSec (it clamps longer requests to this)
    async function dispatch(req) {
      const s = await getSettings();
      const ms = timeoutFor(req, hostCallSec, hostMaxSec);
      const res = await (s.transport === 'http' ? sendHttp(req, ms, s) : sendNative(req, ms));
      if (req.type === 'status' && res && res.ok && res.result) {
        const sec = Number(res.result.commandTimeoutSec);
        if (sec > 0) hostCallSec = sec;
        const max = Number(res.result.maxCommandTimeoutSec);
        if (max > 0) hostMaxSec = max;
      }
      return res;
    }

    let seq = 0;
    /** Handle one content/options request; ids are namespaced per tab so tabs cannot collide. */
    async function handleRpc(request, sender) {
      if (!request || typeof request !== 'object' || typeof request.type !== 'string') {
        return { id: request && request.id, ok: false, error: 'bad request' };
      }
      const origId = request.id != null ? String(request.id) : 'r' + ++seq;
      const ns = sender && sender.tab && sender.tab.id != null ? 't' + sender.tab.id + ':' : 'x:';
      const req = Object.assign({}, request, { id: ns + origId });
      if (req.type === 'cancel' && req.target != null) req.target = ns + String(req.target);
      const resp = await dispatch(req);
      return Object.assign({}, resp, { id: origId });
    }

    // ---------------------------------------------------------- per-tab agent flags
    // { agentOn, autoApprove } per tab + site, in chrome.storage.session (default access level =
    // trusted extension contexts only, so neither the page nor the content script's world can
    // forge them; survives reloads of the tab, cleared when the browser closes).
    const memTabs = new Map();
    const TAB_FLAGS = ['agentOn', 'autoApprove'];
    function tabKey(sender, site) {
      if (!sender || !sender.tab || sender.tab.id == null) return null;
      return 'dsg.tab.' + sender.tab.id + '.' + String(site || '').replace(/[^a-z]/g, '');
    }
    function sessionArea() {
      return chrome.storage && chrome.storage.session ? chrome.storage.session : null;
    }
    function tabGet(key) {
      const area = sessionArea();
      if (!area) return Promise.resolve(memTabs.get(key) || {});
      return new Promise((resolve) => {
        try {
          area.get(key, (o) => resolve((o && o[key]) || {}));
        } catch (_) {
          resolve(memTabs.get(key) || {});
        }
      });
    }
    async function tabSet(key, patch) {
      const cur = await tabGet(key);
      const next = Object.assign({}, cur);
      for (const k of TAB_FLAGS) if (patch && k in patch) next[k] = !!patch[k];
      memTabs.set(key, next);
      const area = sessionArea();
      if (area) {
        await new Promise((resolve) => {
          try {
            area.set({ [key]: next }, () => resolve());
          } catch (_) {
            resolve();
          }
        });
      }
      return next;
    }
    async function handleTabState(msg, sender) {
      const key = tabKey(sender, msg.site);
      if (!key) return { ok: false, error: 'no tab' };
      const state = msg.op === 'set' ? await tabSet(key, msg.patch) : await tabGet(key);
      return { ok: true, state: { agentOn: !!state.agentOn, autoApprove: !!state.autoApprove } };
    }
    if (chrome.tabs && chrome.tabs.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId) => {
        const prefix = 'dsg.tab.' + tabId + '.';
        for (const k of Array.from(memTabs.keys())) if (k.startsWith(prefix)) memTabs.delete(k);
        const area = sessionArea();
        if (area && area.remove) {
          try {
            area.remove(['aistudio', 'gemini'].map((s) => prefix + s));
          } catch (_) {
            /* ignore */
          }
        }
      });
    }

    function onMessage(msg, sender, sendResponse) {
      if (!msg || typeof msg !== 'object') return false;
      if (sender && sender.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
      if (msg.type === 'dsg.tabState') {
        handleTabState(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true;
      }
      if (msg.type === 'dsg.rpc') {
        handleRpc(msg.request, sender).then(sendResponse, (e) =>
          sendResponse({ id: msg.request && msg.request.id, ok: false, error: String((e && e.message) || e), transport: true })
        );
        return true;
      }
      if (msg.type === 'dsg.openOptions') {
        try {
          chrome.runtime.openOptionsPage();
        } catch (_) {
          /* ignore */
        }
        sendResponse({ ok: true });
        return false;
      }
      return false;
    }

    return {
      handleRpc,
      onMessage,
      _pending: pending,
      _getPort: () => port,
      _resetSettingsCache: () => void (cached = null),
    };
  }

  g.DSG_BG = { createBridge, timeoutFor, friendlyNative, HOST_NAME, MSG_NOT_INSTALLED };

  // Install in the real service worker.
  const c = g.chrome;
  if (c && c.runtime && c.runtime.onMessage && typeof c.runtime.connectNative === 'function') {
    const bridge = createBridge({ chrome: c, fetch: (...a) => g.fetch(...a) });
    c.runtime.onMessage.addListener(bridge.onMessage);
    if (c.runtime.onInstalled) {
      c.runtime.onInstalled.addListener((d) => {
        if (d && d.reason === 'install') {
          try {
            c.runtime.openOptionsPage();
          } catch (_) {
            /* ignore */
          }
        }
      });
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
