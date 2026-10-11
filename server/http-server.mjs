#!/usr/bin/env node
// GemInWeb HTTP fallback transport: 127.0.0.1 only, bearer token, Host/Origin checks, no CORS.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDataDir, resolveDataDir } from '../core/config.mjs';
import { createEngine, VERSION } from '../core/engine.mjs';

const MAX_BODY = 16 * 1024 * 1024;
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

/** Read `<home>/http-token`, creating it (32 random bytes, hex) when missing. */
export function loadOrCreateToken(home) {
  ensureDataDir(home);
  const file = join(home, 'http-token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/i.test(t)) return t;
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const i = h.lastIndexOf(':');
  return i === -1 ? h : h.slice(0, i);
}

function tokenMatches(header, token) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

/** Build the request handler (exported for tests). */
export function createRequestHandler({ engine, token }) {
  return (req, res) => {
    const hostname = hostnameOf(req.headers.host);
    if (!hostname || !ALLOWED_HOSTNAMES.has(hostname)) {
      send(res, 403, { ok: false, error: 'forbidden host' });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !String(origin).startsWith('chrome-extension://')) {
      send(res, 403, { ok: false, error: 'forbidden origin' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      send(res, 200, { ok: true, name: 'devspace-gem', version: VERSION });
      return;
    }
    if (url.pathname !== '/rpc') {
      send(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      send(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        send(res, 413, { ok: false, error: 'request too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (aborted) return;
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        send(res, 400, { id: null, ok: false, error: 'Bad request: invalid JSON' });
        return;
      }
      // client went away before we answered → cancel the in-flight call
      const onClose = () => {
        if (!res.writableEnded && msg && msg.type === 'call' && msg.id !== undefined) {
          engine.handle({ id: `abort-${msg.id}`, type: 'cancel', target: String(msg.id) });
        }
      };
      res.on('close', onClose);
      const reply = await engine.handle(msg);
      res.off('close', onClose);
      if (!res.destroyed) send(res, 200, reply);
    });
  };
}

/**
 * Start the server. options: { home, port, host='127.0.0.1', engine, quiet }.
 * Resolves { server, port, token, url, engine, close() }.
 */
export async function startHttpServer(options = {}) {
  const home = resolve(options.home ?? resolveDataDir());
  const engine = options.engine ?? createEngine({ home });
  const token = loadOrCreateToken(home);
  const envPort = process.env.DEVSPACE_GEM_PORT ? Number(process.env.DEVSPACE_GEM_PORT) : undefined;
  const port = options.port ?? (Number.isInteger(envPort) ? envPort : engine.config.http.port);
  const server = createServer(createRequestHandler({ engine, token }));
  server.requestTimeout = 0; // long run_shell calls
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const actual = server.address().port;
  return {
    server,
    port: actual,
    token,
    url: `http://127.0.0.1:${actual}`,
    engine,
    close: () =>
      new Promise((r) => {
        engine.close();
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const norm = (p) => {
      const r = realpathSync.native(resolve(p));
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  startHttpServer()
    .then(({ url, token, engine }) => {
      console.log(`GemInWeb HTTP server ${VERSION} listening on ${url}`);
      console.log(`Data dir: ${engine.home}`);
      console.log(`Token (Authorization: Bearer …): ${token}`);
      console.log('Press Ctrl+C to stop.');
    })
    .catch((err) => {
      console.error(`Failed to start: ${err.message}`);
      process.exit(1);
    });
}
