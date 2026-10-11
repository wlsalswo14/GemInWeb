import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createEngine } from '../../core/engine.mjs';
import { startHttpServer } from '../../server/http-server.mjs';
import { sandbox } from './helpers.mjs';

function req(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers, setHost: !('Host' in headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not json
        }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

describe('HTTP server', () => {
  let sb;
  let srv;
  let auth;
  before(async () => {
    sb = sandbox();
    const engine = createEngine({ home: sb.home, config: { allowedRoots: [sb.ws], defaultWorkspace: sb.ws } });
    srv = await startHttpServer({ home: sb.home, engine, port: 0 });
    auth = { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' };
  });
  after(async () => {
    await srv.close();
    sb.cleanup();
  });

  it('binds 127.0.0.1 and stores a 32-byte hex token in http-token', () => {
    assert.equal(srv.server.address().address, '127.0.0.1');
    assert.match(srv.token, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(sb.home, 'http-token'), 'utf8').trim(), srv.token);
  });

  it('GET /health needs no auth', async () => {
    const r = await req(srv.port, { path: '/health' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, name: 'devspace-gem', version: '0.1.0' });
  });

  it('POST /rpc requires the bearer token', async () => {
    const none = await req(srv.port, { method: 'POST', path: '/rpc', body: { id: '1', type: 'ping' } });
    assert.equal(none.status, 401);
    const wrong = await req(srv.port, { method: 'POST', path: '/rpc', headers: { Authorization: 'Bearer deadbeef' }, body: { id: '1', type: 'ping' } });
    assert.equal(wrong.status, 401);
    const ok = await req(srv.port, { method: 'POST', path: '/rpc', headers: auth, body: { id: '1', type: 'ping' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { id: '1', ok: true, result: { pong: true, version: '0.1.0' } });
  });

  it('runs tool calls with the same envelope', async () => {
    const r = await req(srv.port, { method: 'POST', path: '/rpc', headers: auth, body: { id: 'w', type: 'call', tool: 'write_file', args: { path: 'h.txt', content: 'via http' } } });
    assert.equal(r.json.result.ok, true);
    const bad = await req(srv.port, { method: 'POST', path: '/rpc', headers: auth, body: { id: 'u', type: 'frob' } });
    assert.equal(bad.json.ok, false);
    const garbage = await req(srv.port, { method: 'POST', path: '/rpc', headers: auth, body: '{nope' });
    assert.equal(garbage.status, 400);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const r = await req(srv.port, { path: '/health', headers: { Host: 'evil.example.com' } });
    assert.equal(r.status, 403);
    const r2 = await req(srv.port, { method: 'POST', path: '/rpc', headers: { ...auth, Host: `attacker.test:${srv.port}` }, body: { id: '1', type: 'ping' } });
    assert.equal(r2.status, 403);
    const local = await req(srv.port, { path: '/health', headers: { Host: `localhost:${srv.port}` } });
    assert.equal(local.status, 200);
  });

  it('rejects web-page Origins but accepts chrome-extension://', async () => {
    const web = await req(srv.port, { method: 'POST', path: '/rpc', headers: { ...auth, Origin: 'https://evil.example.com' }, body: { id: '1', type: 'ping' } });
    assert.equal(web.status, 403);
    const nul = await req(srv.port, { method: 'POST', path: '/rpc', headers: { ...auth, Origin: 'null' }, body: { id: '1', type: 'ping' } });
    assert.equal(nul.status, 403);
    const ext = await req(srv.port, {
      method: 'POST',
      path: '/rpc',
      headers: { ...auth, Origin: 'chrome-extension://ekplpihmkdcielcfideebgocdkajifcc' },
      body: { id: '1', type: 'ping' },
    });
    assert.equal(ext.status, 200);
  });

  it('sends no CORS headers, even to preflights', async () => {
    const pre = await req(srv.port, {
      method: 'OPTIONS',
      path: '/rpc',
      headers: { Origin: 'chrome-extension://abc', 'Access-Control-Request-Method': 'POST' },
    });
    assert.notEqual(pre.status, 200);
    const ok = await req(srv.port, { method: 'POST', path: '/rpc', headers: auth, body: { id: '1', type: 'ping' } });
    for (const r of [pre, ok]) {
      for (const h of Object.keys(r.headers)) assert.ok(!h.startsWith('access-control-'), h);
    }
  });

  it('405 for wrong methods, 404 for unknown paths', async () => {
    assert.equal((await req(srv.port, { path: '/rpc' })).status, 405);
    assert.equal((await req(srv.port, { path: '/nope' })).status, 404);
  });
});
