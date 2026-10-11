/* Minimal Chrome DevTools Protocol client (zero deps; Node >= 22 global WebSocket).
 *
 *   import { launchChrome, connectBrowser } from './cdp.mjs';
 *   const chrome = await launchChrome({ exe, userDataDir, port, extensionDir, args });
 *   const b = await connectBrowser(port);
 *   const page = await b.attach(targetId);            // flattened session
 *   await page.send('Runtime.evaluate', {...});
 *   page.on('Fetch.requestPaused', (p) => ...);
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PLAYWRIGHT_CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM || join(homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');

export async function getJson(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return r.json();
}

export async function waitForPort(port, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await getJson(port, '/json/version');
    } catch (e) {
      if (Date.now() > end) throw new Error('DevTools port did not open: ' + e.message);
      await sleep(250);
    }
  }
}

/** Spawn a Chromium with a throwaway profile and the unpacked extension. */
export async function launchChrome(o) {
  fs.mkdirSync(o.userDataDir, { recursive: true });
  const args = [
    `--user-data-dir=${o.userDataDir}`,
    `--remote-debugging-port=${o.port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    `--load-extension=${o.extensionDir}`,
    `--disable-extensions-except=${o.extensionDir}`,
    ...(o.args || []),
    'about:blank',
  ];
  const child = spawn(o.exe || PLAYWRIGHT_CHROMIUM, args, { stdio: 'ignore', detached: !!o.detached });
  await waitForPort(o.port);
  return {
    child,
    async close(browser) {
      try {
        if (browser) await browser.send('Browser.close');
      } catch (_) {
        /* ignore */
      }
      await sleep(500);
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
    },
  };
}

class Session {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.handlers = new Map();
  }
  send(method, params) {
    return this.conn._send(method, params, this.sessionId);
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method).delete(fn);
  }
  _emit(method, params) {
    for (const fn of this.handlers.get(method) || []) {
      try {
        fn(params);
      } catch (e) {
        console.error('[cdp handler]', method, e);
      }
    }
  }
  /** Evaluate an expression in the page main world; returns the value (awaitPromise). */
  async eval(expression, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(opts.contextId ? { contextId: opts.contextId } : {}),
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval failed: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

export async function connectBrowser(port) {
  const v = await getJson(port, '/json/version');
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error('ws error ' + (e && e.message)));
  });
  let id = 0;
  const pending = new Map();
  const sessions = new Map();
  const conn = {
    _send(method, params, sessionId) {
      const msg = { id: ++id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
      return new Promise((resolve, reject) => pending.set(msg.id, { resolve, reject, method }));
    },
  };
  const root = new Session(conn, null);
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    if (m.id != null) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
      return;
    }
    const s = m.sessionId ? sessions.get(m.sessionId) : root;
    if (s) s._emit(m.method, m.params);
  };
  root.ws = ws;
  root.attach = async (targetId) => {
    const { sessionId } = await conn._send('Target.attachToTarget', { targetId, flatten: true });
    const s = new Session(conn, sessionId);
    s.targetId = targetId;
    sessions.set(sessionId, s);
    return s;
  };
  root.targets = async () => (await conn._send('Target.getTargets')).targetInfos;
  root.disconnect = () => ws.close();
  return root;
}

/** Track execution contexts so we can evaluate inside the extension's isolated world. */
export async function trackContexts(page) {
  const ctx = new Map();
  page.on('Runtime.executionContextCreated', ({ context }) => ctx.set(context.id, context));
  page.on('Runtime.executionContextDestroyed', ({ executionContextId }) => ctx.delete(executionContextId));
  page.on('Runtime.executionContextsCleared', () => ctx.clear());
  await page.send('Runtime.enable');
  return {
    isolated(extId) {
      let best = null;
      for (const c of ctx.values()) {
        if (c.auxData && c.auxData.type === 'isolated' && String(c.origin || '').includes(extId)) best = c;
        else if (c.auxData && c.auxData.type === 'isolated' && /DevSpace/i.test(c.name)) best = c;
      }
      return best ? best.id : null;
    },
    all: () => Array.from(ctx.values()),
  };
}

export { sleep };
