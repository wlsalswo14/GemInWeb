import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_CONFIG, loadConfig, resolveDataDir } from '../../core/config.mjs';
import { createEngine, VERSION } from '../../core/engine.mjs';
import { findBash } from '../../core/shell.mjs';
import { sandbox, sandboxEngine } from './helpers.mjs';

describe('config', () => {
  let sb;
  before(() => {
    sb = sandbox();
  });
  after(() => sb.cleanup());

  it('honors DEVSPACE_GEM_HOME', () => {
    assert.equal(resolveDataDir({ DEVSPACE_GEM_HOME: sb.home }), sb.home);
    assert.equal(process.env.DEVSPACE_GEM_HOME, sb.home);
  });

  it('creates config.json with defaults and the logs dir', () => {
    const engine = createEngine();
    assert.equal(engine.home, sb.home);
    assert.ok(existsSync(join(sb.home, 'config.json')));
    assert.ok(existsSync(join(sb.home, 'logs')));
    assert.deepEqual(JSON.parse(readFileSync(join(sb.home, 'config.json'), 'utf8')), DEFAULT_CONFIG);
  });

  it('tolerates comments/trailing commas and reloads on change', async () => {
    writeFileSync(join(sb.home, 'config.json'), `{\n // c\n "allowedRoots": ["${sb.ws.replace(/\\/g, '\\\\')}"],\n "readMaxLines": 7,\n}`);
    const { config, error } = loadConfig(sb.home);
    assert.equal(error, null);
    assert.equal(config.readMaxLines, 7);
    assert.equal(config.maxOutputChars, DEFAULT_CONFIG.maxOutputChars);
    const engine = createEngine();
    assert.equal(engine.config.readMaxLines, 7);
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ readMaxLines: 9 }));
    assert.equal(engine.config.readMaxLines, 9);
  });

  it('reports an invalid config.json instead of overwriting it', async () => {
    writeFileSync(join(sb.home, 'config.json'), '{ not json');
    const engine = createEngine();
    const s = await engine.handle({ id: '1', type: 'status' });
    assert.match(s.result.configError, /invalid/);
    assert.equal(readFileSync(join(sb.home, 'config.json'), 'utf8'), '{ not json');
    writeFileSync(join(sb.home, 'config.json'), JSON.stringify(DEFAULT_CONFIG));
  });
});

describe('engine envelopes', () => {
  let sb;
  let engine;
  before(() => {
    sb = sandbox();
    engine = sandboxEngine(sb);
  });
  after(() => sb.cleanup());

  it('ping', async () => {
    assert.deepEqual(await engine.handle({ id: 'a', type: 'ping' }), { id: 'a', ok: true, result: { pong: true, version: VERSION } });
  });

  it('status', async () => {
    const r = await engine.handle({ id: 's', type: 'status' });
    assert.equal(r.ok, true);
    const s = r.result;
    assert.equal(s.version, VERSION);
    assert.equal(s.platform, process.platform);
    assert.equal(s.configPath, join(sb.home, 'config.json'));
    assert.deepEqual(s.allowedRoots, [sb.ws]);
    assert.equal(s.defaultWorkspace, sb.ws);
    assert.ok(['bash', 'powershell'].includes(s.shell.kind));
    if (findBash()) assert.equal(s.shell.kind, 'bash');
    assert.ok(s.homeDir);
    assert.equal(s.commandTimeoutSec, 120);
    assert.equal(s.maxCommandTimeoutSec, 1800);
  });

  it('echoes arbitrary string ids byte-for-byte (extension format)', async () => {
    const id = 't123:abc-한/"x"';
    assert.equal((await engine.handle({ id, type: 'ping' })).id, id);
    const pending = engine.handle({ id: 't9:call-1', type: 'call', tool: 'ls' });
    const c = await engine.handle({ id: 't9:call-1:timeout-cancel', type: 'cancel', target: 't9:call-1' });
    assert.equal(c.id, 't9:call-1:timeout-cancel');
    assert.equal((await pending).id, 't9:call-1');
  });

  it('tools lists the 11 tools with params and bodyParam', async () => {
    const r = await engine.handle({ id: 't', type: 'tools' });
    const tools = r.result.tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ['open_workspace', 'list_dir', 'find_files', 'read_file', 'write_file', 'edit_file', 'apply_patch', 'run_shell', 'search', 'show_changes', 'fetch_url'],
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.write_file.bodyParam, 'content');
    assert.equal(byName.edit_file.bodyParam, 'edits');
    assert.equal(byName.apply_patch.bodyParam, 'patch');
    assert.equal(byName.run_shell.bodyParam, 'command');
    assert.equal(byName.read_file.bodyParam, undefined);
    for (const name of ['write_file', 'edit_file', 'apply_patch', 'run_shell']) assert.equal(byName[name].mutating, true);
    for (const name of ['open_workspace', 'list_dir', 'find_files', 'read_file', 'search', 'show_changes', 'fetch_url']) assert.equal(byName[name].mutating, false);
    for (const t of tools) {
      assert.ok(t.description);
      for (const p of t.params) assert.deepEqual(Object.keys(p).sort(), ['description', 'name', 'required', 'type']);
    }
  });

  it('primer full and context', async () => {
    const full = await engine.handle({ id: 'p', type: 'primer', site: 'aistudio', mode: 'full' });
    assert.equal(full.result.marker, '[GemInWeb protocol v1]');
    assert.ok(full.result.text.startsWith('[GemInWeb protocol v1]\n'));
    assert.ok(full.result.text.length <= 6000);
    const ctx = await engine.handle({ id: 'c', type: 'primer', site: 'gemini', mode: 'context', workspace: sb.ws });
    assert.ok(ctx.result.text.startsWith('[DevSpace context]'));
    assert.ok(ctx.result.text.includes(`Workspace: ${sb.ws}`));
  });

  it('call returns the result shape; workspace only for open_workspace', async () => {
    const r = await engine.handle({ id: 'c1', type: 'call', tool: 'write_file', args: { path: 'a.txt', content: 'hi' }, workspace: sb.ws });
    assert.equal(r.id, 'c1');
    assert.equal(r.ok, true);
    assert.equal(r.result.ok, true);
    assert.equal(typeof r.result.output, 'string');
    assert.equal(typeof r.result.durationMs, 'number');
    assert.equal(r.result.workspace, undefined);
    const o = await engine.handle({ id: 'c2', type: 'call', tool: 'open_workspace', args: { path: '.' }, workspace: null });
    assert.equal(o.result.ok, true, o.result.output);
    assert.ok(o.result.workspace);
  });

  it('call accepts args as a JSON string and missing args', async () => {
    const r = await engine.handle({ id: 'c3', type: 'call', tool: 'read', args: '{"path":"a.txt"}' });
    assert.equal(r.result.ok, true);
    const ls = await engine.handle({ id: 'c4', type: 'call', tool: 'ls' });
    assert.equal(ls.result.ok, true);
  });

  it('tool failures are ok:true with result.ok:false; unknown tool too', async () => {
    const r = await engine.handle({ id: 'f1', type: 'call', tool: 'read_file', args: { path: 'missing.txt' } });
    assert.equal(r.ok, true);
    assert.equal(r.result.ok, false);
    const u = await engine.handle({ id: 'f2', type: 'call', tool: 'teleport', args: {} });
    assert.equal(u.ok, true);
    assert.equal(u.result.ok, false);
    assert.match(u.result.output, /Unknown tool "teleport"/);
  });

  it('protocol failures are ok:false', async () => {
    assert.deepEqual(await engine.handle({ id: 'x', type: 'nope' }), { id: 'x', ok: false, error: 'Unknown request type: nope' });
    assert.equal((await engine.handle({ type: 'ping' })).ok, false);
    assert.equal((await engine.handle(null)).ok, false);
    assert.equal((await engine.handle({ id: 'y', type: 'call' })).ok, false);
    assert.equal((await engine.handle({ id: 'z', type: 'call', tool: 'ls', args: [1] })).ok, false);
    assert.equal((await engine.handle({ id: 'w', type: 'call', tool: 'ls', args: '{bad' })).ok, false);
    assert.equal((await engine.handle({ id: 'v', type: 'cancel' })).ok, false);
  });

  it('cancel of an unknown id reports cancelled:false', async () => {
    assert.deepEqual(await engine.handle({ id: 'k', type: 'cancel', target: 'ghost' }), { id: 'k', ok: true, result: { cancelled: false } });
  });

  it('cancel aborts an in-flight call which resolves with cancelled:true', { skip: !findBash() }, async () => {
    const pending = engine.handle({ id: 'run-1', type: 'call', tool: 'run_shell', args: { command: 'sleep 20' } });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(engine.inflightCount(), 1);
    const dup = await engine.handle({ id: 'run-1', type: 'call', tool: 'ls' });
    assert.equal(dup.ok, false);
    const c = await engine.handle({ id: 'cancel-1', type: 'cancel', target: 'run-1' });
    assert.equal(c.result.cancelled, true);
    const res = await pending;
    assert.equal(res.id, 'run-1');
    assert.equal(res.ok, true);
    assert.equal(res.result.ok, false);
    assert.equal(res.result.cancelled, true);
    assert.equal(engine.inflightCount(), 0);
  });

  it('concurrent calls are independent', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => engine.handle({ id: `cc${i}`, type: 'call', tool: 'write_file', args: { path: `c${i}.txt`, content: String(i) } })),
    );
    results.forEach((r, i) => {
      assert.equal(r.id, `cc${i}`);
      assert.equal(r.result.ok, true);
    });
  });

  it('a bad workspace gives a helpful tool error', async () => {
    const r = await engine.handle({ id: 'bw', type: 'call', tool: 'ls', args: {}, workspace: join(sb.root, 'nope') });
    assert.equal(r.result.ok, false);
    assert.match(r.result.output, /open_workspace/);
  });
});
