// Shell detection, process spawning, tree-kill, output capture.
// Ideas from DevSpace src/process-platform.ts (MIT, (c) 2026 Waishnav).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, renameSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { decodeBytes, stripAnsi } from './util.mjs';

const IS_WIN = process.platform === 'win32';

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function pathDirs(env = process.env) {
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  return raw.split(delimiter).filter(Boolean);
}

let bashCache = new Map();

/** Locate Git Bash on Windows (never WSL's System32\bash.exe), /bin/bash elsewhere. */
export function findBash(configuredPath = null, env = process.env) {
  const key = `${configuredPath ?? ''}`;
  if (bashCache.has(key)) return bashCache.get(key);
  let found = null;
  if (configuredPath && isFile(configuredPath)) found = configuredPath;
  else if (IS_WIN) {
    const candidates = [];
    for (const base of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (base) candidates.push(join(base, 'Git', 'bin', 'bash.exe'));
    }
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
    for (const dir of pathDirs(env)) {
      if (isFile(join(dir, 'git.exe'))) {
        // <Git>\cmd\git.exe, <Git>\bin\git.exe, <Git>\mingw64\bin\git.exe
        let root = dirname(dir);
        if (/mingw64$/i.test(root)) root = dirname(root);
        candidates.push(join(root, 'bin', 'bash.exe'));
      }
      const b = join(dir, 'bash.exe');
      if (!/\\system32\\?$/i.test(dir) && !/windowsapps/i.test(dir)) candidates.push(b);
    }
    found = candidates.find(isFile) ?? null;
  } else {
    found = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find(isFile) ?? (isFile('/bin/sh') ? '/bin/sh' : null);
  }
  bashCache.set(key, found);
  return found;
}

export function findPowerShell(env = process.env) {
  if (IS_WIN) {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    const p = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return isFile(p) ? p : 'powershell.exe';
  }
  for (const dir of pathDirs(env)) if (isFile(join(dir, 'pwsh'))) return join(dir, 'pwsh');
  return null;
}

let gitCache;
export function findGit(env = process.env) {
  if (gitCache !== undefined) return gitCache;
  const exe = IS_WIN ? 'git.exe' : 'git';
  for (const dir of pathDirs(env)) {
    if (isFile(join(dir, exe))) return (gitCache = join(dir, exe));
  }
  if (IS_WIN) {
    for (const base of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files', env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
      if (!base) continue;
      for (const sub of [['Git', 'cmd', 'git.exe'], ['Git', 'bin', 'git.exe']]) {
        const p = join(base, ...sub);
        if (isFile(p)) return (gitCache = p);
      }
    }
  }
  return (gitCache = null);
}

/**
 * Decide which shell to use. `requested` = per-call `shell` arg ('bash'|'powershell'|undefined).
 * Returns { kind, path } or throws an Error with a helpful message.
 */
export function resolveShell(config, requested) {
  const want = requested ? String(requested).toLowerCase() : null;
  const kind =
    want === 'powershell' || want === 'pwsh' || want === 'ps'
      ? 'powershell'
      : want === 'bash' || want === 'sh' || want === 'git-bash'
        ? 'bash'
        : config.shell === 'bash' || config.shell === 'powershell'
          ? config.shell
          : findBash(config.bashPath)
            ? 'bash'
            : 'powershell';
  if (kind === 'bash') {
    const p = findBash(config.bashPath);
    if (!p) throw new Error('Git Bash was not found. Install Git for Windows, set "bashPath" in config.json, or use shell: powershell.');
    return { kind, path: p };
  }
  const p = findPowerShell();
  if (!p) throw new Error('PowerShell was not found; use shell: bash.');
  return { kind, path: p };
}

const PS_PRELUDE =
  "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;";

export function shellArgs(shell, command) {
  if (shell.kind === 'powershell') {
    const body = `${PS_PRELUDE}\n${command}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`;
    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body];
  }
  return ['-c', command];
}

export function shellEnv(base = process.env) {
  return {
    ...base,
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    TERM: 'dumb',
    NO_COLOR: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
}

/**
 * Windows PIDs of every msys (Git Bash) process whose environment carries DSG_RUN_ID=<tag>.
 * Needed because msys fork/exec breaks the Windows parent chain, so `taskkill /T` alone
 * misses grandchildren such as `sleep 30 &`.
 */
function findTaggedMsysPids(bashPath, tag) {
  return new Promise((resolvePromise) => {
    const script = `for f in $(grep -las 'DSG_RUN_ID=${tag}' /proc/[0-9]*/environ); do d=\${f%/environ}; read -r w < "$d/winpid" && echo "$w"; done`;
    const out = [];
    const env = { ...process.env };
    delete env.DSG_RUN_ID;
    let k;
    try {
      k = spawn(bashPath, ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env });
    } catch {
      resolvePromise([]);
      return;
    }
    const timer = setTimeout(() => k.kill(), 5000);
    k.stdout.on('data', (c) => out.push(c));
    k.on('error', () => {
      clearTimeout(timer);
      resolvePromise([]);
    });
    k.on('close', () => {
      clearTimeout(timer);
      resolvePromise(Buffer.concat(out).toString('utf8').split(/\s+/).filter((s) => /^\d+$/.test(s)));
    });
  });
}

/**
 * Kill a process and all its descendants (`taskkill /T /F` on Windows, process group elsewhere).
 * opts.msysTag + opts.bashPath: also kill Git Bash processes tagged with DSG_RUN_ID.
 */
export async function killTree(pid, opts = {}) {
  if (!pid) return;
  if (IS_WIN && opts.msysTag && opts.bashPath) {
    const extra = await findTaggedMsysPids(opts.bashPath, opts.msysTag);
    if (extra.length) {
      await new Promise((resolvePromise) => {
        const args = ['/F', '/T', ...extra.flatMap((p) => ['/PID', p])];
        const k = spawn('taskkill.exe', args, { stdio: 'ignore', windowsHide: true });
        k.on('error', () => resolvePromise());
        k.on('close', () => resolvePromise());
      });
    }
  }
  return new Promise((resolvePromise) => {
    if (IS_WIN) {
      const k = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('error', () => resolvePromise());
      k.on('close', () => resolvePromise());
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      resolvePromise();
    }
  });
}

/** Bounded byte collector: keeps the first `headBytes` and the last `tailBytes`. */
class Capture {
  constructor(headBytes = 4 * 1024 * 1024, tailBytes = 4 * 1024 * 1024) {
    this.headMax = headBytes;
    this.tailMax = tailBytes;
    this.head = [];
    this.headLen = 0;
    this.tail = [];
    this.tailLen = 0;
    this.omitted = 0;
  }

  push(chunk) {
    if (this.headLen < this.headMax) {
      const take = Math.min(chunk.length, this.headMax - this.headLen);
      this.head.push(chunk.subarray(0, take));
      this.headLen += take;
      chunk = chunk.subarray(take);
      if (!chunk.length) return;
    }
    this.tail.push(chunk);
    this.tailLen += chunk.length;
    while (this.tailLen > this.tailMax && this.tail.length) {
      const first = this.tail[0];
      const excess = this.tailLen - this.tailMax;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailLen -= first.length;
        this.omitted += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailLen -= excess;
        this.omitted += excess;
      }
    }
  }

  text() {
    const head = decodeBytes(Buffer.concat(this.head));
    const tail = decodeBytes(Buffer.concat(this.tail));
    const mid = this.omitted ? `\n[… ${this.omitted} bytes omitted …]\n` : '';
    return cleanOutput(head + mid + tail);
  }
}

export function cleanOutput(text) {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? (line.split('\r').filter(Boolean).pop() ?? '') : line))
    .join('\n');
}

/**
 * Run `command` in `shell` and capture combined output.
 * Resolves { exitCode, signal, output, timedOut, cancelled, durationMs, note }.
 */
export function runCommand({ shell, command, cwd, timeoutMs, signal, env }) {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const capture = new Capture();
    const msysTag = IS_WIN && shell.kind === 'bash' ? randomBytes(8).toString('hex') : null;
    let child;
    try {
      child = spawn(shell.path, shellArgs(shell, command), {
        cwd,
        env: msysTag ? { ...shellEnv(env), DSG_RUN_ID: msysTag } : shellEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !IS_WIN,
      });
    } catch (err) {
      resolvePromise({ exitCode: null, output: `Failed to start ${shell.kind}: ${err.message}`, durationMs: 0, spawnError: true });
      return;
    }
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let exitCode = null;
    let exitSignal = null;
    let note = '';
    let graceTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        exitCode,
        signal: exitSignal,
        output: capture.text(),
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        note,
      });
    };
    let killing = false;
    const kill = async () => {
      if (killing) return;
      killing = true;
      clearTimeout(graceTimer);
      // A msys process caught mid-fork can be missed by one sweep, so sweep again while
      // something still holds the output pipes; then stop waiting.
      for (let sweep = 0; sweep < 4 && !settled; sweep++) {
        await killTree(child.pid, { msysTag, bashPath: shell.path }).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
      }
      if (!settled) {
        note = '[some child processes may have survived the kill; their output was not read]';
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }
    };
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.on('data', (c) => capture.push(c));
    child.stderr.on('data', (c) => capture.push(c));
    child.on('error', (err) => {
      if (exitCode === null) note = `Failed to start ${shell.kind} (${shell.path}): ${err.message}`;
      finish();
    });
    child.on('exit', (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      clearTimeout(graceTimer);
      if (killing) return; // the kill loop decides when to stop waiting
      // background children may keep the pipes open: give them 2 s, then stop reading
      graceTimer = setTimeout(() => {
        note = '[output streams still held by a background process; stopped reading]';
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 2000);
    });
    child.on('close', (code, sig) => {
      if (exitCode === null) {
        exitCode = code;
        exitSignal = sig;
      }
      finish();
    });
  });
}

/** Start a detached background command logging to `<logsDir>/bg-<pid>.log`. */
export function runBackground({ shell, command, cwd, logsDir, env }) {
  const tmp = join(logsDir, `bg-starting-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const fd = openSync(tmp, 'w'); // msys cannot write to append-only handles
  let child;
  try {
    child = spawn(shell.path, shellArgs(shell, command), {
      cwd,
      env: shellEnv(env),
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      detached: true,
    });
  } finally {
    closeSync(fd);
  }
  child.on('error', () => {});
  child.unref();
  let logPath = tmp;
  if (child.pid) {
    const final = join(logsDir, `bg-${child.pid}.log`);
    try {
      if (existsSync(final)) throw new Error('exists');
      renameSync(tmp, final);
      logPath = final;
    } catch {
      // keep the temporary name (Windows may refuse renaming an open file)
    }
  }
  return { pid: child.pid, logPath };
}
