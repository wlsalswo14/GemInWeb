import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parsePatch } from '../../core/apply-patch.mjs';
import { normalizeArgs, parseSearchReplace, resolveToolName } from '../../core/tools.mjs';
import { call, sandbox, sandboxEngine } from './helpers.mjs';

describe('tool aliases', () => {
  it('maps every alias from the spec', () => {
    const table = {
      open_workspace: ['open', 'cd'],
      list_dir: ['ls', 'list'],
      find_files: ['glob', 'find'],
      read_file: ['read', 'cat', 'view'],
      write_file: ['write', 'create_file'],
      edit_file: ['edit', 'str_replace'],
      apply_patch: ['patch'],
      run_shell: ['bash', 'shell', 'exec', 'run', 'powershell'],
      search: ['grep', 'rg'],
      show_changes: ['git_diff', 'diff', 'git_status'],
      fetch_url: ['fetch', 'open_url'],
    };
    for (const [canon, aliases] of Object.entries(table)) {
      assert.equal(resolveToolName(canon).name, canon);
      for (const a of aliases) assert.equal(resolveToolName(a).name, canon, a);
    }
    assert.equal(resolveToolName('nope'), null);
    assert.equal(normalizeArgs(resolveToolName('powershell'), { command: 'x' }, 'powershell').shell, 'powershell');
  });
});

describe('filesystem tools', () => {
  let sb;
  let engine;
  before(() => {
    sb = sandbox();
    engine = sandboxEngine(sb);
    sb.write('src/app.ts', 'export const a = 1;\nexport const b = 2;\n');
    sb.write('src/util/helper.ts', 'export function help() {\n  return "help";\n}\n');
    sb.write('README.md', '# Demo\nhello world\n');
    sb.write('node_modules/pkg/index.js', 'module.exports = "hello";\n');
    sb.write('.git/config', '[core]\n');
    sb.write('dist/bundle.js', 'hello bundle\n');
    sb.write('bin/data.bin', Buffer.from([0, 1, 2, 3, 104, 101, 108, 108, 111]));
    sb.write('AGENTS.md', '# Project rules\nUse tabs.\n');
  });
  after(() => sb.cleanup());

  it('open_workspace reports root, git state, entries, AGENTS.md and returns workspace', async () => {
    const r = await call(engine, 'open_workspace', { path: sb.ws });
    assert.equal(r.ok, true);
    assert.ok(r.workspace);
    assert.match(r.output, /Workspace: /);
    assert.match(r.output, /not a git repository/);
    assert.match(r.output, /src\//);
    assert.match(r.output, /--- AGENTS\.md ---\n# Project rules/);
    const bad = await call(engine, 'open_workspace', { path: 'nope' });
    assert.equal(bad.ok, false);
    assert.equal(bad.workspace, undefined);
  });

  it('list_dir lists dirs first, skips ignored dirs, honors depth and all', async () => {
    const r = await call(engine, 'ls', { path: '.' });
    assert.equal(r.ok, true);
    const lines = r.output.split('\n').slice(1);
    assert.ok(lines.indexOf('src/') < lines.findIndex((l) => l.startsWith('README.md')));
    assert.match(r.output, /node_modules\/ {2}\(skipped\)/);
    assert.doesNotMatch(r.output, /app\.ts/);
    const deep = await call(engine, 'list_dir', { depth: 3 });
    assert.match(deep.output, / {4}helper\.ts/);
    assert.doesNotMatch(deep.output, /index\.js/);
    const all = await call(engine, 'list_dir', { depth: 3, all: true });
    assert.match(all.output, /index\.js/);
    const explicit = await call(engine, 'list_dir', { path: 'node_modules', depth: 2 });
    assert.match(explicit.output, /index\.js/);
    const file = await call(engine, 'list_dir', { path: 'README.md' });
    assert.equal(file.ok, false);
  });

  it('find_files supports globs, substrings, and skips ignored dirs', async () => {
    const r = await call(engine, 'glob', { pattern: '**/*.ts' });
    assert.equal(r.ok, true);
    assert.match(r.output, /src\/app\.ts/);
    assert.match(r.output, /src\/util\/helper\.ts/);
    const base = await call(engine, 'find_files', { pattern: '*.js' });
    assert.doesNotMatch(base.output, /node_modules|dist/);
    const sub = await call(engine, 'find', { pattern: 'helper' });
    assert.match(sub.output, /src\/util\/helper\.ts/);
    const scoped = await call(engine, 'find_files', { pattern: '*.ts', path: 'src/util' });
    assert.match(scoped.output, /^1 file/);
    const none = await call(engine, 'find_files', { pattern: '*.xyz' });
    assert.match(none.output, /No files matching/);
  });

  it('read_file prints cat -n style with offset/limit footer', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    sb.write('long.txt', `${lines}\n`);
    const r = await call(engine, 'cat', { path: 'long.txt', offset: 10, limit: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.output.split('\n')[0], `${'10'.padStart(6)}\tline 10`);
    assert.match(r.output, /\(lines 10-14 of 50 — use offset to read more\)$/);
    const full = await call(engine, 'read_file', { path: 'src/app.ts' });
    assert.equal(full.output, `     1\texport const a = 1;\n     2\texport const b = 2;`);
    const past = await call(engine, 'read', { path: 'long.txt', offset: 99 });
    assert.equal(past.ok, false);
    const bin = await call(engine, 'read_file', { path: 'bin/data.bin' });
    assert.equal(bin.ok, false);
    assert.match(bin.output, /binary/);
    const missing = await call(engine, 'read_file', { path: 'nope.txt' });
    assert.equal(missing.ok, false);
    assert.match(missing.output, /not found/);
    const dir = await call(engine, 'read_file', { path: 'src' });
    assert.match(dir.output, /directory/);
  });

  it('read_file cuts very long lines and respects readMaxLines', async () => {
    sb.write('wide.txt', `${'x'.repeat(5000)}\nshort\n`);
    const r = await call(engine, 'read_file', { path: 'wide.txt' });
    assert.match(r.output, /3000 more chars on this line/);
    const small = sandboxEngine(sb, { readMaxLines: 3 });
    const s = await call(small, 'read_file', { path: 'long.txt' });
    assert.match(s.output, /\(lines 1-3 of 50/);
  });

  it('write_file creates parents and reports created/overwritten', async () => {
    const r = await call(engine, 'write', { path: 'new/deep/file.py', content: 'print(1)\nprint(2)\n' });
    assert.equal(r.output, 'Wrote 2 lines (18 bytes) to new/deep/file.py (created)');
    const again = await call(engine, 'create_file', { file_path: 'new/deep/file.py', content: 'x' });
    assert.equal(again.output, 'Wrote 1 lines (1 bytes) to new/deep/file.py (overwritten)');
    assert.equal(readFileSync(join(sb.ws, 'new/deep/file.py'), 'utf8'), 'x');
    const missing = await call(engine, 'write_file', { path: 'a.txt' });
    assert.equal(missing.ok, false);
  });

  it('edit_file applies edits in order with a diff', async () => {
    sb.write('e.py', 'def a():\n    return 1\n\ndef b():\n    return 2\n');
    const r = await call(engine, 'edit_file', {
      path: 'e.py',
      edits: [
        { old_text: 'return 1', new_text: 'return 10' },
        { oldText: 'def b():', newText: 'def bee():' },
      ],
    });
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /^Edited e\.py: 2 edits applied \(\+2 -2 lines\)/);
    assert.match(r.output, /-    return 1\n\+    return 10/);
    assert.equal(readFileSync(join(sb.ws, 'e.py'), 'utf8'), 'def a():\n    return 10\n\ndef bee():\n    return 2\n');
  });

  it('edit_file accepts single-edit shorthand, old_string/new_string and SEARCH/REPLACE bodies', async () => {
    sb.write('s.txt', 'alpha\nbeta\ngamma\n');
    let r = await call(engine, 'str_replace', { path: 's.txt', old_string: 'beta', new_string: 'BETA' });
    assert.equal(r.ok, true, r.output);
    r = await call(engine, 'edit', { path: 's.txt', old_text: 'alpha', new_text: 'ALPHA' });
    assert.equal(r.ok, true, r.output);
    r = await call(engine, 'edit_file', {
      path: 's.txt',
      edits: '<<<<<<< SEARCH\ngamma\n=======\nGAMMA\ndelta\n>>>>>>> REPLACE\n',
    });
    assert.equal(r.ok, true, r.output);
    assert.equal(readFileSync(join(sb.ws, 's.txt'), 'utf8'), 'ALPHA\nBETA\nGAMMA\ndelta\n');
    assert.deepEqual(parseSearchReplace('<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<<< SEARCH\nc\n========\n\n>>>>>>>> REPLACE'), [
      { old_text: 'a', new_text: 'b' },
      { old_text: 'c', new_text: '' },
    ]);
  });

  it('edit_file fails all-or-nothing on not found / ambiguous, showing closest lines', async () => {
    sb.write('f.js', 'const x = 1;\nconst y = 2;\nconst x2 = 1;\n');
    const before = readFileSync(join(sb.ws, 'f.js'), 'utf8');
    const nf = await call(engine, 'edit_file', {
      path: 'f.js',
      edits: [
        { old_text: 'const y = 2;', new_text: 'const y = 3;' },
        { old_text: 'const z = 9;', new_text: 'nope' },
      ],
    });
    assert.equal(nf.ok, false);
    assert.match(nf.output, /edit 2 of 2 — old_text not found/);
    assert.match(nf.output, /Closest match near line/);
    assert.equal(readFileSync(join(sb.ws, 'f.js'), 'utf8'), before);
    const amb = await call(engine, 'edit_file', { path: 'f.js', old_text: '= 1;', new_text: '= 5;' });
    assert.equal(amb.ok, false);
    assert.match(amb.output, /matches 2 times/);
    assert.match(amb.output, /lines 1, 3/);
    const all = await call(engine, 'edit_file', { path: 'f.js', edits: [{ old_text: '= 1;', new_text: '= 5;', replace_all: true }] });
    assert.equal(all.ok, true, all.output);
    assert.equal(readFileSync(join(sb.ws, 'f.js'), 'utf8'), 'const x = 5;\nconst y = 2;\nconst x2 = 5;\n');
  });

  it('edit_file matches LF text in a CRLF file and keeps CRLF', async () => {
    sb.write('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
    const r = await call(engine, 'edit_file', { path: 'crlf.txt', old_text: 'one\ntwo\n', new_text: 'uno\ndos\n' });
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /CRLF kept/);
    assert.equal(readFileSync(join(sb.ws, 'crlf.txt'), 'utf8'), 'uno\r\ndos\r\nthree\r\n');
  });

  it('edit_file tolerates trailing whitespace differences', async () => {
    sb.write('ws.txt', 'a  \nb\t\nc\n');
    const r = await call(engine, 'edit_file', { path: 'ws.txt', old_text: 'a\nb', new_text: 'A\nB' });
    assert.equal(r.ok, true, r.output);
    assert.equal(readFileSync(join(sb.ws, 'ws.txt'), 'utf8'), 'A\nB\nc\n');
  });

  it('apply_patch adds, updates, deletes and moves files', async () => {
    sb.write('p/keep.txt', 'one\ntwo\nthree\n');
    sb.write('p/gone.txt', 'bye\n');
    sb.write('p/old.txt', 'move me\nline2\n');
    const patch = [
      '*** Begin Patch',
      '*** Add File: p/added.txt',
      '+hello',
      '+world',
      '*** Update File: p/keep.txt',
      '@@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '*** Delete File: p/gone.txt',
      '*** Update File: p/old.txt',
      '*** Move to: p/new.txt',
      '@@',
      ' move me',
      '-line2',
      '+line 2',
      '*** End Patch',
    ].join('\n');
    const r = await call(engine, 'apply_patch', { patch });
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /^Applied patch: 4 file\(s\) changed/);
    assert.match(r.output, /A p\/added\.txt/);
    assert.match(r.output, /M p\/keep\.txt/);
    assert.match(r.output, /D p\/gone\.txt/);
    assert.match(r.output, /R p\/old\.txt -> p\/new\.txt/);
    assert.equal(readFileSync(join(sb.ws, 'p/added.txt'), 'utf8'), 'hello\nworld\n');
    assert.equal(readFileSync(join(sb.ws, 'p/keep.txt'), 'utf8'), 'one\nTWO\nthree\n');
    assert.equal(existsSync(join(sb.ws, 'p/gone.txt')), false);
    assert.equal(existsSync(join(sb.ws, 'p/old.txt')), false);
    assert.equal(readFileSync(join(sb.ws, 'p/new.txt'), 'utf8'), 'move me\nline 2\n');
  });

  it('apply_patch is all-or-nothing and confined to allowed roots', async () => {
    sb.write('q/a.txt', 'a\n');
    const bad = await call(engine, 'patch', {
      patch: '*** Begin Patch\n*** Add File: q/b.txt\n+b\n*** Update File: q/a.txt\n@@\n-zzz\n+yyy\n*** End Patch',
    });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /could not find hunk context/);
    assert.equal(existsSync(join(sb.ws, 'q/b.txt')), false);
    const esc = await call(engine, 'apply_patch', { patch: '*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch' });
    assert.equal(esc.ok, false);
    assert.match(esc.output, /Access denied/);
    assert.throws(() => parsePatch('*** Begin Patch\n*** Frobnicate: x\n*** End Patch'), /unknown action header/);
  });

  it('apply_patch keeps CRLF line endings and tolerates missing markers', async () => {
    sb.write('c.txt', 'x\r\ny\r\n');
    const r = await call(engine, 'apply_patch', { patch: '*** Update File: c.txt\n@@\n x\n-y\n+z' });
    assert.equal(r.ok, true, r.output);
    assert.equal(readFileSync(join(sb.ws, 'c.txt'), 'utf8'), 'x\r\nz\r\n');
  });

  it('search finds literal and regex matches, skipping binaries and ignored dirs', async () => {
    const r = await call(engine, 'grep', { query: 'hello' });
    assert.equal(r.ok, true);
    assert.match(r.output, /README\.md:2: hello world/);
    assert.doesNotMatch(r.output, /node_modules|dist|data\.bin/);
    const re = await call(engine, 'search', { query: 'export (const|function) \\w+', regex: true, glob: '*.ts' });
    assert.match(re.output, /src\/app\.ts:1:/);
    assert.match(re.output, /src\/util\/helper\.ts:1:/);
    const cs = await call(engine, 'search', { query: 'HELLO', case_sensitive: true });
    assert.match(cs.output, /No matches/);
    const ci = await call(engine, 'rg', { query: 'HELLO' });
    assert.match(ci.output, /README/);
    const lim = await call(engine, 'search', { query: 'line', path: 'long.txt', max_results: 3 });
    assert.equal(lim.output.split('\n').filter((l) => l.includes(':')).length, 3);
    assert.match(lim.output, /stopped at max_results=3/);
    const bad = await call(engine, 'search', { query: '(', regex: true });
    assert.equal(bad.ok, false);
  });

  it('search skips files over 2 MB', async () => {
    mkdirSync(join(sb.ws, 'big'), { recursive: true });
    writeFileSync(join(sb.ws, 'big', 'huge.txt'), `${'needle\n'.repeat(400000)}`);
    sb.write('big/small.txt', 'needle\n');
    const r = await call(engine, 'search', { query: 'needle', path: 'big' });
    assert.match(r.output, /small\.txt:1/);
    assert.doesNotMatch(r.output, /huge\.txt/);
  });

  it('caps oversized output at maxOutputChars', async () => {
    sb.write('many.txt', `${Array.from({ length: 500 }, (_, i) => `row number ${i}`).join('\n')}\n`);
    const small = sandboxEngine(sb, { maxOutputChars: 1000 });
    const r = await call(small, 'read_file', { path: 'many.txt' });
    assert.ok(r.output.length <= 1000);
    assert.equal(r.truncated, true);
    assert.match(r.output, /use offset to read more/);
    const ls = await call(small, 'run_shell', { command: 'seq 1 5000' });
    assert.ok(ls.output.length <= 1000 + 200, String(ls.output.length));
    assert.equal(ls.truncated, true);
  });
});
