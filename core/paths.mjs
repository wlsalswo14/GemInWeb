// Path policy: every file path must resolve (after symlinks/junctions) inside an allowed root,
// and outside the protected paths (`protectedPaths` = no read/write, `writeProtectedPaths` = no write).
// Ideas from DevSpace src/roots.ts (MIT, (c) 2026 Waishnav).
import { lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from './util.mjs';

const IS_WIN = process.platform === 'win32';

/** The GemInWeb install dir (project root), resolved from this module's location. */
export const INSTALL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** Normalize model-supplied paths: `~`, Git Bash `/c/Users/...`, `file:///` URLs, stray quotes. */
export function normalizeInputPath(input) {
  let p = String(input).trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1).trim();
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
      if (IS_WIN && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    } catch {
      // keep as-is
    }
  }
  p = expandHome(p);
  if (IS_WIN) {
    const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
    if (m) p = `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
  }
  return p;
}

export function cmpKey(p) {
  return IS_WIN ? p.toLowerCase() : p;
}

export function samePath(a, b) {
  return cmpKey(resolve(a)) === cmpKey(resolve(b));
}

/** True when `p` equals `root` or is below it (case-insensitive on Windows). */
export function isInside(root, p) {
  const rel = relative(cmpKey(resolve(root)), cmpKey(resolve(p)));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function stripLongPrefix(p) {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\') || p.startsWith('\\??\\')) return p.slice(4);
  return p;
}

/**
 * realpath of the nearest existing ancestor + the not-yet-existing remainder. A component that
 * exists only as a dangling symlink/junction is followed through its link target, so a write
 * through it is checked where it would really land.
 */
export async function realpathNearest(p, depth = 0) {
  if (depth > 40) throw new ToolError(`Too many levels of symbolic links: ${p}`);
  let existing = resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      return rest.length ? join(real, ...[...rest].reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      let link = null;
      try {
        link = await lstat(existing);
      } catch {
        // really missing
      }
      if (link?.isSymbolicLink()) {
        const target = resolve(dirname(existing), stripLongPrefix(await readlink(existing)));
        return realpathNearest(rest.length ? join(target, ...[...rest].reverse()) : target, depth + 1);
      }
      const parent = dirname(existing);
      if (parent === existing) return resolve(p);
      rest.push(existing.slice(parent.length).replace(/^[\\/]+/, ''));
      existing = parent;
    }
  }
}

/** True when some segment of `p` is `.git` (case-insensitive; on Windows also `.git.`, `.git::$DATA` aliases). */
export function hasGitSegment(p) {
  return resolve(p)
    .split(/[\\/]+/)
    .some((seg) => {
      let s = seg.toLowerCase();
      if (IS_WIN) s = s.replace(/:.*$/, '').replace(/[. ]+$/, '');
      return s === '.git';
    });
}

/** Expand a protected-path entry: `~`, `$DATA_DIR`, `$INSTALL_DIR`. Returns an absolute path or null. */
export function expandPolicyEntry(entry, { dataDir } = {}) {
  if (typeof entry !== 'string' || !entry.trim()) return null;
  let p = entry.trim();
  const m = /^\$(DATA_DIR|INSTALL_DIR)(?=$|[\\/])/.exec(p);
  if (m) {
    const base = m[1] === 'DATA_DIR' ? dataDir : INSTALL_DIR;
    if (!base) return null;
    p = join(base, p.slice(m[0].length));
  }
  return resolve(normalizeInputPath(p));
}

export class PathPolicy {
  /**
   * @param {string[]} allowedRoots raw config entries (may contain `~`)
   * @param {{ protectedPaths?: string[], writeProtectedPaths?: string[], dataDir?: string }} [opts]
   */
  constructor(allowedRoots, { protectedPaths = [], writeProtectedPaths = [], dataDir } = {}) {
    this.roots = allowedRoots.map((r) => resolve(normalizeInputPath(r)));
    this.dataDir = dataDir ? resolve(dataDir) : null;
    this.protectedPaths = protectedPaths.map((e) => expandPolicyEntry(e, { dataDir })).filter(Boolean);
    this.writeProtectedPaths = writeProtectedPaths.map((e) => expandPolicyEntry(e, { dataDir })).filter(Boolean);
    this._realRoots = null;
    this._sets = null;
  }

  async realRoots() {
    if (!this._realRoots) {
      this._realRoots = await Promise.all(this.roots.map((r) => realpathNearest(r).catch(() => r)));
    }
    return this._realRoots;
  }

  /** Compute lexical + real forms of the roots and protected entries (once). */
  async ready() {
    if (!this._sets) {
      const both = async (list) => {
        const out = [];
        for (const p of list) {
          out.push(p);
          const real = await realpathNearest(p).catch(() => p);
          if (!samePath(real, p)) out.push(real);
        }
        return out;
      };
      this._sets = { read: await both(this.protectedPaths), write: await both(this.writeProtectedPaths) };
      this._logDirs = this.dataDir ? (await both([this.dataDir])).map((d) => join(d, 'logs')) : [];
    }
    await this.realRoots();
    return this;
  }

  /** `<dataDir>/logs/bg-<pid>.log` stays readable (run_shell background output). */
  _readException(p) {
    if (!this.dataDir || !/^bg-\d+\.log$/i.test(basename(p))) return false;
    const dirs = this._logDirs ?? [join(this.dataDir, 'logs')];
    return dirs.some((d) => samePath(dirname(p), d));
  }

  /**
   * Synchronous protected-path test (call `await ready()` first for symlink-aware results).
   * Returns `{ entry, key }` for the matching protected entry, or null.
   */
  protectedMatch(p, { write = false } = {}) {
    const sets = this._sets ?? { read: this.protectedPaths, write: this.writeProtectedPaths };
    if (!sets.read.length && !(write && sets.write.length)) return null;
    // hot path (called per entry while walking): plain prefix compare on normalized keys
    if (this._prefixSets !== sets) {
      const prep = (q) => {
        const k = cmpKey(resolve(q));
        return { entry: q, k, prefix: k.endsWith(sep) ? k : k + sep };
      };
      this._prefix = { read: sets.read.map(prep), write: sets.write.map(prep) };
      this._prefixSets = sets;
    }
    const key = cmpKey(resolve(p));
    const inside = (q) => key === q.k || key.startsWith(q.prefix);
    if (write || !this._readException(p)) {
      const hit = this._prefix.read.find(inside);
      if (hit) return { entry: hit.entry, key: 'protectedPaths' };
    }
    if (write) {
      const hit = this._prefix.write.find(inside);
      if (hit) return { entry: hit.entry, key: 'writeProtectedPaths' };
    }
    return null;
  }

  /** True when `p` must be skipped in listings / search (read-protected). */
  isHidden(p) {
    return this.protectedMatch(p) !== null;
  }

  /**
   * Throws ToolError unless absolute path `abs` is inside an allowed root (symlink-safe) and not
   * protected. `write: true` also applies `writeProtectedPaths` and refuses `.git` internals.
   */
  async check(abs, display = abs, { write = false } = {}) {
    if (abs.includes('\0')) throw new ToolError(`Invalid path: ${display}`);
    const real = await realpathNearest(abs);
    await this.ready();
    const lexicalOk = this.roots.some((r) => isInside(r, abs));
    const realOk = this._realRoots.some((r) => isInside(r, real));
    if (!realOk) {
      const why = lexicalOk ? ' (it resolves through a symlink/junction to a location outside)' : '';
      throw new ToolError(
        `Access denied: ${display} is outside the allowed roots${why}. Allowed roots: ${this.roots.join(', ') || '(none)'}`,
      );
    }
    const hit = this.protectedMatch(abs, { write }) ?? this.protectedMatch(real, { write });
    if (hit) {
      const what = hit.key === 'protectedPaths' ? 'a protected location' : 'a write-protected location';
      throw new ToolError(
        `Access denied: ${display} is inside ${what} (${hit.entry}; config.json "${hit.key}"). Do not try to work around this; ask the user if access is really needed.`,
      );
    }
    if (write && (hasGitSegment(abs) || hasGitSegment(real))) {
      throw new ToolError(
        `Refused: ${display} is inside a .git directory. File tools do not write git internals — edit git internals via run_shell git commands (e.g. git config, git checkout).`,
      );
    }
    return abs;
  }

  /** Resolve `input` (relative to `base`) to an absolute, policy-checked path. */
  async resolve(input, base, opts = {}) {
    if (input === undefined || input === null || String(input).trim() === '') {
      throw new ToolError('Missing path');
    }
    const p = normalizeInputPath(input);
    let abs;
    if (isAbsolute(p) && !(IS_WIN && /^[\\/](?![\\/])/.test(p))) {
      abs = resolve(p);
    } else {
      if (!base) {
        throw new ToolError(`No workspace is open, so the relative path "${input}" cannot be resolved. Call open_workspace with an absolute path first.`);
      }
      abs = resolve(base, p);
    }
    return this.check(abs, String(input), opts);
  }

  /**
   * Read-check a file met while walking a directory or reading a context file: realpath it
   * (follows symlinks) and return the real path, or null when it is missing, outside the
   * allowed roots, or protected.
   */
  async readableReal(abs) {
    try {
      const real = await realpath(abs);
      await this.check(real);
      return this.isHidden(abs) ? null : real;
    } catch {
      return null;
    }
  }
}

/** Show `abs` relative to the workspace (posix separators) when inside it, else absolute. */
export function displayPath(abs, workspace) {
  if (workspace && isInside(workspace, abs)) {
    const rel = relative(workspace, abs);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }
  return abs;
}
