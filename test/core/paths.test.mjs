import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isInside, normalizeInputPath, PathPolicy, realpathNearest } from '../../core/paths.mjs';
import { call, IS_WIN, sandbox, sandboxEngine } from './helpers.mjs';

describe('path policy', () => {
  let sb;
  let policy;
  before(() => {
    sb = sandbox();
    sb.write('inside.txt', 'x');
    mkdirSync(join(sb.root, 'outside'), { recursive: true });
    writeFileSync(join(sb.root, 'outside', 'secret.txt'), 'secret');
    policy = new PathPolicy([sb.ws]);
  });
  after(() => sb.cleanup());

  it('resolves relative paths against the workspace', async () => {
    assert.equal(await policy.resolve('inside.txt', sb.ws), join(sb.ws, 'inside.txt'));
    assert.equal(await policy.resolve('new/dir/file.txt', sb.ws), join(sb.ws, 'new', 'dir', 'file.txt'));
  });

  it('allows absolute paths inside a root and rejects outside', async () => {
    assert.equal(await policy.resolve(join(sb.ws, 'inside.txt'), null), join(sb.ws, 'inside.txt'));
    await assert.rejects(policy.resolve(join(sb.root, 'outside', 'secret.txt'), sb.ws), /Access denied/);
  });

  it('blocks .. escapes', async () => {
    await assert.rejects(policy.resolve('../outside/secret.txt', sb.ws), /Access denied/);
    await assert.rejects(policy.resolve('sub/../../outside', sb.ws), /Access denied/);
  });

  it('rejects relative paths with no workspace and empty paths', async () => {
    await assert.rejects(policy.resolve('x.txt', null), /open_workspace/);
    await assert.rejects(policy.resolve('', sb.ws), /Missing path/);
  });

  it('does not treat a sibling with a shared prefix as inside', () => {
    assert.equal(isInside(sb.ws, `${sb.ws}-evil`), false);
    assert.equal(isInside(sb.ws, join(sb.ws, 'a', 'b')), true);
    assert.equal(isInside(sb.ws, sb.ws), true);
  });

  it('expands ~ and converts Git Bash style paths', () => {
    assert.equal(normalizeInputPath('~'), homedir());
    assert.equal(normalizeInputPath('~/x'), join(homedir(), 'x'));
    if (IS_WIN) {
      assert.equal(normalizeInputPath('/c/Users/x'), 'C:\\Users\\x');
      assert.equal(normalizeInputPath('/d'), 'D:\\');
    }
  });

  it('compares case-insensitively on Windows', { skip: !IS_WIN }, async () => {
    const upper = sb.ws.toUpperCase();
    assert.equal(isInside(sb.ws, join(upper, 'inside.txt')), true);
    await policy.resolve(join(upper, 'inside.txt'), null);
  });

  it('blocks symlink/junction escapes via realpath of the nearest existing ancestor', async () => {
    const link = join(sb.ws, 'link-out');
    try {
      symlinkSync(join(sb.root, 'outside'), link, IS_WIN ? 'junction' : 'dir');
    } catch (err) {
      return; // cannot create links here
    }
    await assert.rejects(policy.resolve('link-out/secret.txt', sb.ws), /symlink\/junction/);
    await assert.rejects(policy.resolve('link-out/not-yet/new.txt', sb.ws), /Access denied/);
    const engine = sandboxEngine(sb);
    const r = await call(engine, 'read_file', { path: 'link-out/secret.txt' });
    assert.equal(r.ok, false);
    assert.match(r.output, /Access denied/);
    const w = await call(engine, 'write_file', { path: 'link-out/evil.txt', content: 'x' });
    assert.equal(w.ok, false);
  });

  it('realpathNearest keeps the missing tail', async () => {
    const p = await realpathNearest(join(sb.ws, 'missing', 'a.txt'));
    assert.match(p, /missing[\\/]a\.txt$/);
  });

  it('engine refuses tools outside allowed roots', async () => {
    const engine = sandboxEngine(sb);
    const r = await call(engine, 'read_file', { path: join(sb.root, 'outside', 'secret.txt') });
    assert.equal(r.ok, false);
    assert.match(r.output, /Access denied/);
    const o = await call(engine, 'open_workspace', { path: join(sb.root, 'outside') });
    assert.equal(o.ok, false);
  });
});
