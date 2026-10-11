#!/usr/bin/env node
// GemInWeb native messaging host (com.devspace.gem).
// Framing: 4-byte little-endian length + UTF-8 JSON, both directions.
// stdout carries ONLY frames; console output goes to <data dir>/logs/host.log.
import { appendFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { createEngine } from '../core/engine.mjs';
import { ensureDataDir, resolveDataDir } from '../core/config.mjs';

export const MAX_RESPONSE_BYTES = 900_000;
const MAX_INBOUND_BYTES = 64 * 1024 * 1024;

/** Encode one native-messaging frame. */
export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental frame decoder: push(chunk) → array of parsed messages (or { __error }). */
export function createFrameDecoder() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      const out = [];
      while (buffer.length >= 4) {
        const len = buffer.readUInt32LE(0);
        if (len > MAX_INBOUND_BYTES) {
          out.push({ __fatal: `inbound frame too large (${len} bytes)` });
          buffer = Buffer.alloc(0);
          break;
        }
        if (buffer.length < 4 + len) break;
        const body = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        try {
          out.push(JSON.parse(body.toString('utf8')));
        } catch (err) {
          out.push({ __error: `invalid JSON frame: ${err.message}` });
        }
      }
      return out;
    },
  };
}

/** Shrink `result.output` until the serialized response fits under `limit` bytes. */
export function fitResponse(response, limit = MAX_RESPONSE_BYTES) {
  let size = Buffer.byteLength(JSON.stringify(response), 'utf8');
  if (size <= limit) return response;
  const output = response?.result?.output;
  if (typeof output === 'string') {
    const outBytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
    const overhead = size - outBytes;
    let ratio = Math.max(0, (limit - overhead - 2000) / outBytes);
    for (let attempt = 0; attempt < 10 && size > limit; attempt++) {
      const keep = Math.floor(output.length * ratio);
      const head = Math.floor(keep * 0.4);
      const marker = `\n[… output truncated by the native host to stay under 1 MB (${output.length - keep} chars removed) …]\n`;
      const text = output.slice(0, head) + marker + output.slice(output.length - (keep - head));
      response = { ...response, result: { ...response.result, output: text, truncated: true } };
      size = Buffer.byteLength(JSON.stringify(response), 'utf8');
      ratio *= 0.85;
    }
    if (size <= limit) return response;
  }
  return { id: response?.id ?? null, ok: false, error: `response too large for native messaging (${size} bytes)` };
}

function setupLogging(home) {
  ensureDataDir(home);
  const logFile = join(home, 'logs', 'host.log');
  const write = (level, args) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${level} ${format(...args)}\n`);
    } catch {
      // never fall back to stdout
    }
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    console[level] = (...args) => write(level.toUpperCase(), args);
  }
  return write;
}

async function selftest() {
  const engine = createEngine();
  const res = await engine.handle({ id: 'selftest', type: 'status' });
  if (!res.ok) {
    process.stderr.write(`selftest failed: ${res.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`, () => process.exit(0));
}

function runHost() {
  const home = resolveDataDir();
  const log = setupLogging(home);
  // Keep stdout for frames only: anything else writing to it is diverted to the log.
  const rawWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, cb) => {
    log('STDOUT', [typeof chunk === 'string' ? chunk : `<${chunk?.length ?? 0} bytes>`]);
    const done = typeof encoding === 'function' ? encoding : cb;
    if (typeof done === 'function') done();
    return true;
  };
  const send = (message) => {
    const fitted = fitResponse(message);
    rawWrite(encodeFrame(fitted));
  };

  process.on('uncaughtException', (err) => console.error('uncaughtException', err));
  process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

  const engine = createEngine({ home });
  console.info(`native host started (node ${process.version}, args ${JSON.stringify(process.argv.slice(2))})`);
  const decoder = createFrameDecoder();
  const pending = new Set();

  process.stdin.on('data', (chunk) => {
    for (const msg of decoder.push(chunk)) {
      if (msg && msg.__fatal) {
        console.error(msg.__fatal);
        send({ id: null, ok: false, error: msg.__fatal });
        continue;
      }
      if (msg && msg.__error) {
        send({ id: null, ok: false, error: msg.__error });
        continue;
      }
      const started = Date.now();
      const p = engine
        .handle(msg)
        .then((res) => {
          if (msg?.type === 'call') {
            console.info(`call ${msg.tool} id=${msg.id} ok=${res.ok && res.result?.ok} ${Date.now() - started}ms`);
          }
          send(res);
        })
        .catch((err) => send({ id: msg?.id ?? null, ok: false, error: `Internal error: ${err?.message ?? err}` }))
        .finally(() => pending.delete(p));
      pending.add(p);
    }
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.info('stdin closed; exiting');
    engine.close();
    // let cancelled calls flush (they kill their process trees) but don't linger
    Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 1500))]).then(() => {
      rawWrite(Buffer.alloc(0), () => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    });
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.resume();
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
  if (process.argv.includes('--selftest')) selftest();
  else runHost();
}
