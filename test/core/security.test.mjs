// Regression tests for the security review fixes: git config code execution, .git writes,
// protected paths, apply_patch case-only renames / EOF appends, symlink handling.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig, DEFAULT_CONFIG } from '../../core/config.mjs';
import { createEngine } from '../../core/engine.mjs';
import { hasGitSegment, INSTALL_DIR, PathPolicy, realpathNearest } from '../../core/paths.mjs';
import { findGit } from '../../core/shell.mjs';
import { call, IS_WIN, REPO_ROOT, sandbox, sandboxEngine } from './helpers.mjs';

const GIT = findGit();
const fwd = (p) => p.replace(/\\/g, '/');

function tryFileSymlink(target, link) {
  try {
    symlinkSync(target, link, 'file');
    return true;
  } catch {
    return false; // Windows without Developer Mode / admin
  }
}

function junction(target, link) {
  symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
}

describe('git invocations ignore repository-controlled commands', { skip: !GIT && 'git not installed' }, () => {
  let sb;
  let engine;
  let marker;
  before(() => {
    sb = sandbox();
    engine = sandboxEngine(sb);
    marker = join(sb.root, 'pwned.log');
    const git = (...args) => execFileSync(GIT, args, { cwd: sb.ws, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.autocrlf', 'false');
    sb.write('a.txt', 'one\n');
    sb.write('.gitattributes', '*.txt filter=evil diff=tc\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const m = fwd(marker);
    // what a malicious write (or a downloaded repo) could plant
    writeFileSync(
      join(sb.ws, '.git', 'config'),
      `${readFileSync(join(sb.ws, '.git', 'config'), 'utf8')}` +
        `[core]\n\tfsmonitor = "echo FSMON >> '${m}'; false"\n\tpager = "echo PAGER >> '${m}'; cat"\n` +
        `[filter "evil"]\n\tclean = "sh -c 'echo CLEAN >> \\"${m}\\"; cat'"\n\tsmudge = cat\n\trequired = true\n` +
        `[diff "tc"]\n\ttextconv = "sh -c 'echo TEXTCONV >> \\"${m}\\"; cat \\"$0\\"'"\n` +
        `[diff]\n\texternal = "sh -c 'echo EXTDIFF >> \\"${m}\\"'"\n`,
    );
    sb.write('a.txt', 'two\n');
  });
  after(() => sb.cleanup());

  it('the planted config really executes with plain git (control)', () => {
    rmSync(marker, { force: true });
    try {
      execFileSync(GIT, ['status', '--short'], { cwd: sb.ws, stdio: 'pipe' });
    } catch {
      // exit code irrelevant
    }
    assert.equal(existsSync(marker), true, 'control: fsmonitor should have run');
    rmSync(marker, { force: true });
  });

  it('show_changes and open_workspace do not run fsmonitor, filters, textconv, external diff or pager', async () => {
    rmSync(marker, { force: true });
    const r = await call(engine, 'show_changes');
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /M a\.txt/);
    assert.match(r.output, /-one\n\+two/);
    const o = await call(engine, 'open_workspace', { path: sb.ws });
    assert.equal(o.ok, true, o.output);
    assert.match(o.output, /Git: branch main/);
    const scoped = await call(engine, 'show_changes', { path: 'a.txt' });
    assert.equal(scoped.ok, true, scoped.output);
    assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, 'utf8') : '');
  });
});

describe('file tools refuse .git internals', () => {
  let sb;
  let engine;
  before(() => {
    sb = sandbox();
    engine = sandboxEngine(sb);
    sb.write('.git/config', '[core]\n');
    sb.write('sub/.git/HEAD', 'ref: refs/heads/main\n');
  });
  after(() => sb.cleanup());

  it('write_file / edit_file / apply_patch into .git are refused with guidance', async () => {
    const targets = ['.git/config', '.GIT/config', 'sub/.git/hooks/pre-commit', '.git', 'x/.Git/config'];
    if (IS_WIN) targets.push('.git./config', '.git /config', '.git::$INDEX_ALLOCATION/config');
    for (const path of targets) {
      const w = await call(engine, 'write_file', { path, content: '[core]\n\tfsmonitor = calc\n' });
      assert.equal(w.ok, false, path);
      assert.match(w.output, /\.git directory.*run_shell git/s, path);
    }
    const e = await call(engine, 'edit_file', { path: '.git/config', old_text: '[core]', new_text: '[core]\n\tfsmonitor = calc' });
    assert.equal(e.ok, false);
    assert.match(e.output, /run_shell git/);
    const p = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Update File: .git/config\n@@\n [core]\n+\tfsmonitor = calc\n*** End Patch' });
    assert.equal(p.ok, false);
    assert.match(p.output, /run_shell git/);
    const mv = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Add File: .git/hooks/post-checkout\n+evil\n*** End Patch' });
    assert.equal(mv.ok, false);
    assert.equal(readFileSync(join(sb.ws, '.git/config'), 'utf8'), '[core]\n');
    // reading git internals stays allowed, and look-alikes are writable
    assert.equal((await call(engine, 'read_file', { path: '.git/config' })).ok, true);
    assert.equal((await call(engine, 'write_file', { path: '.github/workflow.yml', content: 'x' })).ok, true);
    assert.equal((await call(engine, 'write_file', { path: 'docs/.gitignore', content: 'x' })).ok, true);
    assert.equal((await call(engine, 'write_file', { path: 'my.git/x', content: 'x' })).ok, true);
  });

  it('hasGitSegment', () => {
    assert.equal(hasGitSegment(join(sb.ws, '.git', 'config')), true);
    assert.equal(hasGitSegment(join(sb.ws, '.gitattributes')), false);
    assert.equal(hasGitSegment(join(sb.ws, '.github')), false);
  });
});

describe('protectedPaths / writeProtectedPaths', () => {
  let sb;
  let engine;
  before(() => {
    sb = sandbox();
    sb.write('secret/key.pem', 'PRIVATE needle\n');
    sb.write('secret/nested/more.txt', 'needle\n');
    sb.write('ro/file.txt', 'readonly needle\n');
    sb.write('open/ok.txt', 'needle\n');
    engine = sandboxEngine(sb, { protectedPaths: [join(sb.ws, 'secret')], writeProtectedPaths: [join(sb.ws, 'ro')] });
  });
  after(() => sb.cleanup());

  it('denies read and write of protected paths', async () => {
    for (const [tool, args] of [
      ['read_file', { path: 'secret/key.pem' }],
      ['read_file', { path: 'SECRET/key.pem' }],
      ['list_dir', { path: 'secret' }],
      ['find_files', { pattern: '*', path: 'secret' }],
      ['search', { query: 'needle', path: 'secret/key.pem' }],
      ['write_file', { path: 'secret/new.txt', content: 'x' }],
      ['edit_file', { path: 'secret/key.pem', old_text: 'PRIVATE', new_text: 'x' }],
      ['apply_patch', { patch: '*** Begin Patch\n*** Delete File: secret/key.pem\n*** End Patch' }],
      ['open_workspace', { path: 'secret' }],
      ['run_shell', { command: 'ls', cwd: 'secret' }],
      ['show_changes', { path: 'secret/key.pem' }],
    ]) {
      const r = await call(engine, tool, args);
      assert.equal(r.ok, false, `${tool} ${JSON.stringify(args)}: ${r.output}`);
      assert.match(r.output, /protected location.*"protectedPaths"/s, tool);
    }
    assert.equal(readFileSync(join(sb.ws, 'secret/key.pem'), 'utf8'), 'PRIVATE needle\n');
    const ws = await call(engine, 'read_file', { path: 'open/ok.txt' }, join(sb.ws, 'secret'));
    assert.equal(ws.ok, false, 'a protected workspace is not usable');
  });

  it('skips protected subtrees silently in listings and search', async () => {
    const ls = await call(engine, 'list_dir', { depth: 3 });
    assert.equal(ls.ok, true);
    assert.doesNotMatch(ls.output, /secret|key\.pem/);
    assert.match(ls.output, /ro\//);
    const found = await call(engine, 'find_files', { pattern: '**/*' });
    assert.doesNotMatch(found.output, /secret/);
    assert.match(found.output, /open\/ok\.txt/);
    const s = await call(engine, 'search', { query: 'needle' });
    assert.doesNotMatch(s.output, /secret|PRIVATE/);
    assert.match(s.output, /open\/ok\.txt:1/);
    assert.match(s.output, /ro\/file\.txt:1/);
    const o = await call(engine, 'open_workspace', { path: sb.ws });
    assert.doesNotMatch(o.output, /secret/);
  });

  it('writeProtectedPaths are readable but not writable', async () => {
    assert.equal((await call(engine, 'read_file', { path: 'ro/file.txt' })).ok, true);
    assert.equal((await call(engine, 'run_shell', { command: 'echo hi', cwd: 'ro' })).ok, true);
    for (const [tool, args] of [
      ['write_file', { path: 'ro/file.txt', content: 'x' }],
      ['write_file', { path: 'ro/new/deep.txt', content: 'x' }],
      ['edit_file', { path: 'ro/file.txt', old_text: 'readonly', new_text: 'x' }],
      ['apply_patch', { patch: '*** Begin Patch\n*** Add File: ro/added.txt\n+x\n*** End Patch' }],
      ['apply_patch', { patch: '*** Begin Patch\n*** Update File: open/ok.txt\n*** Move to: ro/moved.txt\n@@\n-needle\n+n\n*** End Patch' }],
    ]) {
      const r = await call(engine, tool, args);
      assert.equal(r.ok, false, `${tool}: ${r.output}`);
      assert.match(r.output, /write-protected location.*"writeProtectedPaths"/s, tool);
    }
    assert.equal(readFileSync(join(sb.ws, 'ro/file.txt'), 'utf8'), 'readonly needle\n');
    assert.equal(existsSync(join(sb.ws, 'open/ok.txt')), true);
  });

  it('a junction into a protected dir is denied and hidden', async () => {
    junction(join(sb.ws, 'secret'), join(sb.ws, 'alias'));
    const r = await call(engine, 'read_file', { path: 'alias/key.pem' });
    assert.equal(r.ok, false);
    assert.match(r.output, /protected/);
    const l = await call(engine, 'list_dir', { path: 'alias' });
    assert.equal(l.ok, false);
  });

  it('defaults protect the data dir (token, config) but keep background logs readable', async () => {
    const sb2 = sandbox();
    try {
      writeFileSync(join(sb2.home, 'http-token'), 'deadbeef');
      mkdirSync(join(sb2.home, 'logs'), { recursive: true });
      writeFileSync(join(sb2.home, 'logs', 'bg-1234.log'), 'background output\n');
      writeFileSync(join(sb2.home, 'logs', 'host.log'), 'host\n');
      const e = createEngine({ home: sb2.home, config: { allowedRoots: [sb2.root], defaultWorkspace: sb2.ws } });
      for (const f of ['http-token', 'config.json', 'logs/host.log']) {
        const r = await call(e, 'read_file', { path: join(sb2.home, f) });
        assert.equal(r.ok, false, f);
        assert.match(r.output, /protectedPaths/);
      }
      const w = await call(e, 'write_file', { path: join(sb2.home, 'config.json'), content: '{"allowedRoots":["C:\\\\"]}' });
      assert.equal(w.ok, false);
      const bg = await call(e, 'read_file', { path: join(sb2.home, 'logs', 'bg-1234.log') });
      assert.equal(bg.ok, true, bg.output);
      const wbg = await call(e, 'write_file', { path: join(sb2.home, 'logs', 'bg-1234.log'), content: 'x' });
      assert.equal(wbg.ok, false);
      const ls = await call(e, 'list_dir', { path: sb2.root });
      assert.doesNotMatch(ls.output, /home\//);
      const s = await call(e, 'search', { query: 'deadbeef', path: sb2.root });
      assert.match(s.output, /No matches/);
    } finally {
      sb2.cleanup();
    }
  });

  it('default writeProtectedPaths cover the install dir', async () => {
    assert.equal(INSTALL_DIR.toLowerCase(), REPO_ROOT.replace(/[\\/]+$/, '').toLowerCase());
    const sb3 = sandbox();
    try {
      const e = createEngine({ home: sb3.home, config: { allowedRoots: [REPO_ROOT, sb3.ws], defaultWorkspace: sb3.ws } });
      const r = await call(e, 'write_file', { path: join(REPO_ROOT, 'core', 'pwn.mjs'), content: 'x' });
      assert.equal(r.ok, false);
      assert.match(r.output, /writeProtectedPaths/);
      assert.equal(existsSync(join(REPO_ROOT, 'core', 'pwn.mjs')), false);
      assert.equal((await call(e, 'read_file', { path: join(REPO_ROOT, 'package.json') })).ok, true);
    } finally {
      sb3.cleanup();
    }
  });
});

describe('config.json gets new keys merged', () => {
  it('adds protectedPaths / writeProtectedPaths defaults and keeps user values', () => {
    const sb = sandbox();
    try {
      const user = { allowedRoots: ['D:\\work'], shell: 'powershell', commandTimeoutSec: 60, custom: 1 };
      writeFileSync(join(sb.home, 'config.json'), JSON.stringify(user));
      const { config } = loadConfig(sb.home);
      assert.deepEqual(config.protectedPaths, [...DEFAULT_CONFIG.protectedPaths]);
      const onDisk = JSON.parse(readFileSync(join(sb.home, 'config.json'), 'utf8'));
      assert.deepEqual(onDisk, { ...user, protectedPaths: [...DEFAULT_CONFIG.protectedPaths], writeProtectedPaths: [...DEFAULT_CONFIG.writeProtectedPaths] });
      // user overrides are respected (and not re-added)
      writeFileSync(join(sb.home, 'config.json'), JSON.stringify({ ...user, protectedPaths: [], writeProtectedPaths: ['~/x'] }));
      const again = loadConfig(sb.home).config;
      assert.deepEqual(again.protectedPaths, []);
      assert.deepEqual(again.writeProtectedPaths, ['~/x']);
      // a commented file is left byte-for-byte untouched; defaults apply in memory
      const commented = '{\n  // mine\n  "allowedRoots": ["~"],\n}\n';
      writeFileSync(join(sb.home, 'config.json'), commented);
      assert.deepEqual(loadConfig(sb.home).config.writeProtectedPaths, [...DEFAULT_CONFIG.writeProtectedPaths]);
      assert.equal(readFileSync(join(sb.home, 'config.json'), 'utf8'), commented);
    } finally {
      sb.cleanup();
    }
  });
});

describe('apply_patch edge cases', () => {
  let sb;
  let engine;
  before(() => {
    sb = sandbox();
    engine = sandboxEngine(sb);
  });
  after(() => sb.cleanup());

  it('Delete readme.md + Add README.md keeps the file with the new content', async () => {
    sb.write('c1/readme.md', 'old\n');
    const r = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Delete File: c1/readme.md\n*** Add File: c1/README.md\n+new\n*** End Patch' });
    assert.equal(r.ok, true, r.output);
    assert.deepEqual(readdirSync(join(sb.ws, 'c1')), ['README.md']);
    assert.equal(readFileSync(join(sb.ws, 'c1', 'README.md'), 'utf8'), 'new\n');
  });

  it('Add README.md then Delete readme.md is a delete (last action wins)', async () => {
    sb.write('c2/readme.md', 'old\n');
    const r = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Add File: c2/README.md\n+new\n*** Delete File: c2/readme.md\n*** End Patch' });
    assert.equal(r.ok, true, r.output);
    assert.deepEqual(readdirSync(join(sb.ws, 'c2')), IS_WIN ? [] : ['README.md']);
  });

  it('case-only move renames and keeps content', async () => {
    sb.write('c3/readme.md', 'a\nb\n');
    const r = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Update File: c3/readme.md\n*** Move to: c3/README.md\n@@\n a\n-b\n+B\n*** End Patch' });
    assert.equal(r.ok, true, r.output);
    assert.deepEqual(readdirSync(join(sb.ws, 'c3')), ['README.md']);
    assert.equal(readFileSync(join(sb.ws, 'c3', 'README.md'), 'utf8'), 'a\nB\n');
  });

  it('updating via a differently-cased path keeps the on-disk name', { skip: !IS_WIN }, async () => {
    sb.write('c4/Main.ts', 'x\n');
    const r = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Update File: c4/main.ts\n@@\n-x\n+y\n*** End Patch' });
    assert.equal(r.ok, true, r.output);
    assert.deepEqual(readdirSync(join(sb.ws, 'c4')), ['Main.ts']);
    assert.equal(readFileSync(join(sb.ws, 'c4', 'Main.ts'), 'utf8'), 'y\n');
  });

  it('a pure-addition hunk without context appends at EOF', async () => {
    sb.write('eof1.txt', 'one\ntwo\n');
    const r = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Update File: eof1.txt\n@@\n+appended\n*** End Patch' });
    assert.equal(r.ok, true, r.output);
    assert.equal(readFileSync(join(sb.ws, 'eof1.txt'), 'utf8'), 'one\ntwo\nappended\n');
    // with an @@ anchor it still inserts after the anchor line
    sb.write('eof2.txt', 'def a\nend\ndef b\nend\n');
    const a = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Update File: eof2.txt\n@@ def a\n+  body\n*** End Patch' });
    assert.equal(a.ok, true, a.output);
    assert.equal(readFileSync(join(sb.ws, 'eof2.txt'), 'utf8'), 'def a\n  body\nend\ndef b\nend\n');
  });

  it('preserves a missing final newline (and CRLF)', async () => {
    sb.write('nonl.txt', 'a\nb');
    let r = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Update File: nonl.txt\n@@\n a\n-b\n+B\n*** End Patch' });
    assert.equal(r.ok, true, r.output);
    assert.equal(readFileSync(join(sb.ws, 'nonl.txt'), 'utf8'), 'a\nB');
    sb.write('nonl2.txt', 'x\r\ny');
    r = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Update File: nonl2.txt\n@@\n+z\n*** End Patch' });
    assert.equal(r.ok, true, r.output);
    assert.equal(readFileSync(join(sb.ws, 'nonl2.txt'), 'utf8'), 'x\r\ny\r\nz');
    sb.write('withnl.txt', 'a\n');
    r = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Update File: withnl.txt\n@@\n-a\n+b\n*** End Patch' });
    assert.equal(readFileSync(join(sb.ws, 'withnl.txt'), 'utf8'), 'b\n');
    sb.write('empty.txt', '');
    r = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Update File: empty.txt\n@@\n+first\n*** End Patch' });
    assert.equal(r.ok, true, r.output);
    assert.equal(readFileSync(join(sb.ws, 'empty.txt'), 'utf8'), 'first\n');
  });
});

describe('symlinks and dangling links', () => {
  let sb;
  let engine;
  let outside;
  before(() => {
    sb = sandbox();
    engine = sandboxEngine(sb);
    outside = join(sb.root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET needle\n');
  });
  after(() => sb.cleanup());

  it('a dangling junction/symlink cannot be used to write outside the roots', async () => {
    const gone = join(sb.root, 'gone');
    mkdirSync(gone);
    junction(gone, join(sb.ws, 'dl'));
    rmSync(gone, { recursive: true });
    assert.equal((await realpathNearest(join(sb.ws, 'dl', 'x.txt'))).toLowerCase(), join(realpathSync.native(sb.root), 'gone', 'x.txt').toLowerCase());
    const w = await call(engine, 'write_file', { path: 'dl/x.txt', content: 'x' });
    assert.equal(w.ok, false);
    assert.match(w.output, /Access denied/);
    const p = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Add File: dl/sub/y.txt\n+y\n*** End Patch' });
    assert.equal(p.ok, false);
    assert.equal(existsSync(gone), false);
  });

  it('a dangling file symlink cannot be used to write outside the roots', async (t) => {
    const target = join(outside, 'created-by-link.txt');
    if (!tryFileSymlink(target, join(sb.ws, 'dangling.txt'))) return t.skip('file symlinks not permitted');
    const w = await call(engine, 'write_file', { path: 'dangling.txt', content: 'x' });
    assert.equal(w.ok, false);
    assert.equal(existsSync(target), false);
  });

  it('readableReal rejects files reached through links to outside / protected places', async () => {
    junction(outside, join(sb.ws, 'jout'));
    const policy = new PathPolicy([sb.ws], { protectedPaths: [join(sb.ws, 'prot')] });
    sb.write('prot/p.txt', 'p\n');
    sb.write('fine.txt', 'f\n');
    assert.equal(await policy.readableReal(join(sb.ws, 'jout', 'secret.txt')), null);
    assert.equal(await policy.readableReal(join(sb.ws, 'prot', 'p.txt')), null);
    assert.ok(await policy.readableReal(join(sb.ws, 'fine.txt')));
  });

  it('search and open_workspace do not follow file symlinks outside the roots', async (t) => {
    const okLink = tryFileSymlink(join(outside, 'secret.txt'), join(sb.ws, 'leak.txt'));
    if (!okLink) return t.skip('file symlinks not permitted');
    tryFileSymlink(join(outside, 'secret.txt'), join(sb.ws, 'AGENTS.md'));
    const s = await call(engine, 'search', { query: 'needle' });
    assert.doesNotMatch(s.output, /TOPSECRET/);
    const o = await call(engine, 'open_workspace', { path: sb.ws });
    assert.doesNotMatch(o.output, /TOPSECRET/);
    const pr = await engine.handle({ id: 'p1', type: 'primer', mode: 'context', workspace: sb.ws });
    assert.doesNotMatch(pr.result.text, /TOPSECRET/);
  });
});
