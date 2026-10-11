import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EXT, loadScripts, plain } from './_load.mjs';

const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const keyFile = JSON.parse(readFileSync(join(EXT, '..', 'install', 'extension-key.json'), 'utf8'));

test('manifest key pins the extension id', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.key, keyFile.key);
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(id, 'ekplpihmkdcielcfideebgocdkajifcc');
});

test('manifest permissions, hosts, content script order', () => {
  assert.deepEqual(manifest.permissions.sort(), ['clipboardWrite', 'nativeMessaging', 'storage']);
  assert.deepEqual(manifest.host_permissions, [
    'https://aistudio.google.com/*',
    'https://gemini.google.com/*',
    'http://127.0.0.1:7679/*',
    'http://localhost:7679/*',
  ]);
  const cs = manifest.content_scripts[0];
  assert.deepEqual(cs.matches, ['https://aistudio.google.com/*', 'https://gemini.google.com/*']);
  assert.equal(cs.run_at, 'document_idle');
  assert.equal(cs.all_frames, false);
  assert.deepEqual(cs.js, [
    'content/selectors.js',
    'content/protocol.js',
    'content/sites.js',
    'content/rpc.js',
    'content/panel.js',
    'content/agent.js',
    'content/main.js',
  ]);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(existsSync(join(EXT, manifest.options_page)));
  for (const p of Object.values(manifest.icons)) {
    const buf = readFileSync(join(EXT, p));
    assert.equal(buf.subarray(1, 4).toString(), 'PNG', p);
  }
});

test('settings defaults are identical in defaults.js and content/rpc.js', () => {
  const a = loadScripts(['defaults.js']).DSG_DEFAULT_SETTINGS;
  const b = loadScripts(['content/rpc.js']).DSG.DEFAULT_SETTINGS;
  assert.deepEqual(plain(a), plain(b));
  assert.deepEqual(plain(a), {
    transport: 'native',
    httpUrl: 'http://127.0.0.1:7679',
    httpToken: '',
    approval: 'ask_shell',
    maxSteps: 25,
    maxCallsPerTurn: 6,
    maxMessageChars: { gemini: 24000, aistudio: 80000 },
    primerMode: 'full',
    autoSend: true,
  });
});

test('settings merge keeps nested defaults', () => {
  const m = loadScripts(['defaults.js']).DSG_mergeSettings({ maxMessageChars: { gemini: 1000 }, approval: 'auto' });
  assert.deepEqual(plain(m.maxMessageChars), { gemini: 1000, aistudio: 80000 });
  assert.equal(m.approval, 'auto');
  assert.equal(m.transport, 'native');
});

test('content scripts load in manifest order without a DOM (selectors.js stubbed)', () => {
  // main.js must bail out quietly when there is no supported location.
  const files = manifest.content_scripts[0].js.filter((f) => f !== 'content/selectors.js');
  const ctx = loadScripts(files, { location: { hostname: 'example.com' } });
  for (const k of ['protocol', 'createSiteAdapter', 'rpc', 'createPanel', 'createAgent', 'settings', 'agentStorage']) {
    assert.ok(ctx.DSG[k], k);
  }
});
