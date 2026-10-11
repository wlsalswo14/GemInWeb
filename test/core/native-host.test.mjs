import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createFrameDecoder, encodeFrame, fitResponse, MAX_RESPONSE_BYTES } from '../../host/native-host.mjs';
import { findBash } from '../../core/shell.mjs';
import { REPO_ROOT, sandbox } from './helpers.mjs';

const HOST = join(REPO_ROOT, 'host', 'native-host.mjs');

/** Spawn the host like Chrome does and talk framed JSON to it. */
function startHost(home) {
  const child = spawn(process.execPath, [HOST, 'chrome-extension://ekplpihmkdcielcfideebgocdkajifcc/'], {
    env: { ...process.env, DEVSPACE_GEM_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const decoder = createFrameDecoder();
  const waiting = new Map();
  const rawStdout = [];
  child.stdout.on('data', (chunk) => {
    rawStdout.push(chunk);
    for (const msg of decoder.push(chunk)) {
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w(msg);
      }
    }
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return {
    child,
    exited,
    rawStdout,
    request(msg) {
      return new Promise((resolve) => {
        waiting.set(msg.id, resolve);
        child.stdin.write(encodeFrame(msg));
      });
    },
  };
}

describe('native host framing helpers', () => {
  it('encodes 4-byte little-endian length + UTF-8 JSON and decodes split chunks', () => {
    const frame = encodeFrame({ id: '1', text: '한글' });
    const len = frame.readUInt32LE(0);
    assert.equal(len, frame.length - 4);
    assert.deepEqual(JSON.parse(frame.subarray(4).toString('utf8')), { id: '1', text: '한글' });
    const d = createFrameDecoder();
    const two = Buffer.concat([frame, encodeFrame({ id: '2' })]);
    assert.deepEqual(d.push(two.subarray(0, 3)), []);
    assert.deepEqual(d.push(two.subarray(3, 10)), []);
    assert.deepEqual(d.push(two.subarray(10)), [{ id: '1', text: '한글' }, { id: '2' }]);
  });

  it('fitResponse shrinks result.output under 900 000 bytes and marks truncated', () => {
    for (const ch of ['x', '한', '"']) {
      const big = { id: 'b', ok: true, result: { ok: true, output: ch.repeat(1_200_000), durationMs: 1 } };
      const fitted = fitResponse(big);
      const size = Buffer.byteLength(JSON.stringify(fitted));
      assert.ok(size <= MAX_RESPONSE_BYTES, `${ch}: ${size}`);
      assert.ok(size > MAX_RESPONSE_BYTES * 0.5, `${ch}: kept too little (${size})`);
      assert.equal(fitted.ok, true);
      assert.equal(fitted.result.truncated, true);
      assert.match(fitted.result.output, /truncated by the native host/);
    }
    const small = { id: 's', ok: true, result: { ok: true, output: 'hi' } };
    assert.equal(fitResponse(small), small);
  });
});

describe('native host process', () => {
  let sb;
  let host;
  before(() => {
    sb = sandbox();
    writeFileSync(
      join(sb.home, 'config.json'),
      JSON.stringify({ allowedRoots: [sb.ws], defaultWorkspace: sb.ws, maxOutputChars: 3_000_000, readMaxLines: 100000 }),
    );
    sb.write('hello.txt', 'hello from host\n');
    host = startHost(sb.home);
  });
  after(async () => {
    if (host.child.exitCode === null) host.child.kill();
    sb.cleanup();
  });

  it('round-trips ping and status', async () => {
    const pong = await host.request({ id: 'p1', type: 'ping' });
    assert.deepEqual(pong, { id: 'p1', ok: true, result: { pong: true, version: '0.1.0' } });
    const st = await host.request({ id: 's1', type: 'status' });
    assert.equal(st.ok, true);
    assert.deepEqual(st.result.allowedRoots, [sb.ws]);
  });

  it('round-trips a tool call and handles requests concurrently', async () => {
    const [a, b, c] = await Promise.all([
      host.request({ id: 'c1', type: 'call', tool: 'read_file', args: { path: 'hello.txt' } }),
      host.request({ id: 'c2', type: 'call', tool: 'ls', args: {} }),
      host.request({ id: 'c3', type: 'ping' }),
    ]);
    assert.equal(a.result.ok, true);
    assert.match(a.result.output, /hello from host/);
    assert.match(b.result.output, /hello\.txt/);
    assert.equal(c.result.pong, true);
  });

  it('answers in completion order (a slow call does not block a fast one)', { skip: !findBash() }, async () => {
    const order = [];
    const slow = host.request({ id: 'slow', type: 'call', tool: 'run_shell', args: { command: 'sleep 1; echo slow' } }).then((m) => order.push(m.id));
    const fast = host.request({ id: 'fast', type: 'ping' }).then((m) => order.push(m.id));
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ['fast', 'slow']);
  });

  it('keeps responses under 900 000 bytes', async () => {
    const line = `${'y'.repeat(99)}\n`;
    sb.write('big.txt', line.repeat(20000)); // ~2 MB
    const r = await host.request({ id: 'big', type: 'call', tool: 'read_file', args: { path: 'big.txt', limit: 100000 } });
    assert.equal(r.ok, true);
    assert.equal(r.result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 900_000);
    assert.match(r.result.output, /truncated by the native host/);
  });

  it('answers bad JSON frames with an error envelope', async () => {
    const got = new Promise((resolve) => {
      const d = createFrameDecoder();
      const onData = (chunk) => {
        for (const m of d.push(chunk)) {
          if (m.id === null) {
            host.child.stdout.off('data', onData);
            resolve(m);
          }
        }
      };
      host.child.stdout.on('data', onData);
    });
    const body = Buffer.from('{oops', 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(body.length, 0);
    host.child.stdin.write(Buffer.concat([hdr, body]));
    const m = await got;
    assert.equal(m.ok, false);
    assert.match(m.error, /invalid JSON/);
  });

  it('writes nothing but frames to stdout, logs to logs/host.log, exits when stdin closes', async () => {
    host.child.stdin.end();
    const code = await host.exited;
    assert.equal(code, 0);
    // every byte of stdout must belong to a well-formed frame
    const all = Buffer.concat(host.rawStdout);
    let off = 0;
    while (off < all.length) {
      const len = all.readUInt32LE(off);
      JSON.parse(all.subarray(off + 4, off + 4 + len).toString('utf8'));
      off += 4 + len;
    }
    assert.equal(off, all.length);
    const log = readFileSync(join(sb.home, 'logs', 'host.log'), 'utf8');
    assert.match(log, /native host started/);
    assert.match(log, /stdin closed/);
  });
});

describe('native host --selftest', () => {
  let sb;
  before(() => {
    sb = sandbox();
  });
  after(() => sb.cleanup());

  it('prints the status JSON, creates config.json and exits 0', () => {
    const r = spawnSync(process.execPath, [HOST, '--selftest'], {
      env: { ...process.env, DEVSPACE_GEM_HOME: sb.home },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    const status = JSON.parse(r.stdout);
    assert.equal(status.version, '0.1.0');
    assert.equal(status.configPath, join(sb.home, 'config.json'));
    assert.ok(existsSync(join(sb.home, 'config.json')));
  });
});
