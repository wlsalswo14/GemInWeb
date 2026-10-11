import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { cleanOutput, findBash, resolveShell } from '../../core/shell.mjs';
import { decodeBytes, truncateMiddle } from '../../core/util.mjs';
import { call, IS_WIN, sandbox, sandboxEngine } from './helpers.mjs';

const HAS_BASH = Boolean(findBash());

describe('run_shell', () => {
  let sb;
  let engine;
  before(() => {
    sb = sandbox();
    engine = sandboxEngine(sb);
    sb.write('hello.txt', 'hi\n');
  });
  after(() => sb.cleanup());

  it('detects Git Bash on Windows (not WSL)', { skip: !IS_WIN }, () => {
    const bash = findBash();
    assert.ok(bash, 'Git Bash should be installed on this machine');
    assert.doesNotMatch(bash, /system32/i);
    assert.equal(resolveShell({ shell: 'auto', bashPath: null }).kind, 'bash');
    assert.equal(resolveShell({ shell: 'auto', bashPath: null }, 'powershell').kind, 'powershell');
  });

  it('runs bash with the documented layout and exit 0', { skip: !HAS_BASH }, async () => {
    const r = await call(engine, 'run_shell', { command: 'echo "a b" && cat hello.txt && pwd' });
    assert.equal(r.ok, true, r.output);
    const lines = r.output.split('\n');
    assert.equal(lines[0], '$ echo "a b" && cat hello.txt && pwd');
    assert.match(lines[1], /^\[cwd: .+ · shell: bash\]$/);
    assert.equal(lines[2], 'a b');
    assert.equal(lines[3], 'hi');
    assert.match(lines.at(-1), /^\[exit 0 · \d+\.\ds\]$/);
  });

  it('reports non-zero exit codes as ok:false', { skip: !HAS_BASH }, async () => {
    const r = await call(engine, 'bash', { command: 'echo out; echo err 1>&2; exit 3' });
    assert.equal(r.ok, false);
    assert.match(r.output, /out\nerr|err\nout/);
    assert.match(r.output, /\[exit 3 · /);
  });

  it('sets the documented environment and ignores stdin', { skip: !HAS_BASH }, async () => {
    const r = await call(engine, 'exec', { command: 'echo "$PAGER $GIT_PAGER $TERM $NO_COLOR $PYTHONUTF8 $PYTHONIOENCODING"; cat; echo done' });
    assert.match(r.output, /cat cat dumb 1 1 utf-8\ndone/);
  });

  it('honors cwd and rejects cwd outside allowed roots', { skip: !HAS_BASH }, async () => {
    sb.write('sub/x.txt', 'x');
    const r = await call(engine, 'run', { command: 'ls', cwd: 'sub' });
    assert.match(r.output, /x\.txt/);
    const bad = await call(engine, 'run_shell', { command: 'ls', cwd: '..' });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /Access denied/);
  });

  it('decodes UTF-8 (Korean) output', { skip: !HAS_BASH }, async () => {
    const r = await call(engine, 'run_shell', { command: 'echo 한글 테스트' });
    assert.match(r.output, /한글 테스트/);
  });

  it('kills the whole process tree on timeout', { skip: !HAS_BASH }, async () => {
    const started = Date.now();
    const r = await call(engine, 'run_shell', { command: 'sleep 30 & sleep 30; echo never', timeout: 1 });
    assert.equal(r.ok, false);
    assert.match(r.output, /\[killed: timeout after 1s · /);
    assert.doesNotMatch(r.output.split('\n').slice(2).join('\n'), /never/);
    // if the backgrounded `sleep 30` survived it would hold the pipes and we'd hit the 3 s grace period
    assert.doesNotMatch(r.output, /may have survived/);
    assert.ok(Date.now() - started < 15000, `should return promptly (took ${Date.now() - started} ms)`);
  });

  it('refuses commands matching blockedCommands', async () => {
    const strict = sandboxEngine(sb, { blockedCommands: ['rm\\s+-rf\\s+/'] });
    const r = await call(strict, 'run_shell', { command: 'rm -rf / --no-preserve-root' });
    assert.equal(r.ok, false);
    assert.match(r.output, /blockedCommands/);
  });

  it('runs PowerShell with UTF-8 and propagates native exit codes', { skip: !IS_WIN }, async () => {
    const r = await call(engine, 'powershell', { command: 'Write-Output "ps 한글"; cmd /c exit 5' });
    assert.equal(r.ok, false);
    assert.match(r.output, /shell: powershell\]/);
    assert.match(r.output, /ps 한글/);
    assert.match(r.output, /\[exit 5 · /);
    const ok = await call(engine, 'run_shell', { command: '$x = 1 + 1\nWrite-Output "sum=$x"', shell: 'powershell' });
    assert.equal(ok.ok, true, ok.output);
    assert.match(ok.output, /sum=2/);
    const err = await call(engine, 'run_shell', { command: 'Get-Item C:\\definitely\\missing\\path', shell: 'powershell' });
    assert.equal(err.ok, false);
    assert.match(err.output, /\[exit 1 · /);
  });

  it('starts background commands with a bg-<pid>.log', { skip: !HAS_BASH }, async () => {
    const r = await call(engine, 'run_shell', { command: 'echo started-bg; sleep 1; echo finished-bg', background: true });
    assert.equal(r.ok, true, r.output);
    const pid = Number(/pid (\d+)/.exec(r.output)[1]);
    const log = /Log: (.+)/.exec(r.output)[1].trim();
    assert.ok(pid > 0);
    assert.ok(log.endsWith(`bg-${pid}.log`), log);
    assert.ok(log.startsWith(join(sb.home, 'logs')));
    for (let i = 0; i < 50 && !/finished-bg/.test(existsSync(log) ? readFileSync(log, 'utf8') : ''); i++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.match(readFileSync(log, 'utf8'), /started-bg\nfinished-bg/);
  });

  it('cancel kills an in-flight command', { skip: !HAS_BASH }, async () => {
    const pending = engine.handle({ id: 'long-1', type: 'call', tool: 'run_shell', args: { command: 'echo begun; sleep 30' } });
    await new Promise((res) => setTimeout(res, 700));
    const c = await engine.handle({ id: 'c-1', type: 'cancel', target: 'long-1' });
    assert.deepEqual(c, { id: 'c-1', ok: true, result: { cancelled: true } });
    const res = await pending;
    assert.equal(res.ok, true);
    assert.equal(res.result.ok, false);
    assert.equal(res.result.cancelled, true);
    assert.match(res.result.output, /\[cancelled · /);
    const again = await engine.handle({ id: 'c-2', type: 'cancel', target: 'long-1' });
    assert.equal(again.result.cancelled, false);
  });
});

describe('output helpers', () => {
  it('keeps head 40% and tail 60% when truncating', () => {
    const text = `${'a'.repeat(1000)}${'b'.repeat(1000)}`;
    const t = truncateMiddle(text, 580);
    assert.equal(t.truncated, true);
    assert.ok(t.text.length <= 600);
    const [head, tail] = t.text.split(/\n\[… \d+ chars omitted …\]\n/);
    assert.equal(head.length, 200);
    assert.equal(tail.length, 300);
  });

  it('falls back to cp949 when UTF-8 decoding produces replacement chars', () => {
    const cp949 = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // "한글" in cp949
    assert.equal(decodeBytes(cp949), '한글');
    assert.equal(decodeBytes(Buffer.from('한글', 'utf8')), '한글');
  });

  it('cleans ANSI escapes, CRLF and carriage-return progress lines', () => {
    assert.equal(cleanOutput('\u001b[31mred\u001b[0m\r\n10%\r50%\r100%\nend'), 'red\n100%\nend');
  });
});
