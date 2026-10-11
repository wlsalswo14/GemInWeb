// Shared helpers for the GemInWeb core (no external dependencies).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const VERSION = '0.1.0';

/** A tool failed in an expected way: becomes `result.ok:false` with this message as output. */
export class ToolError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ToolError';
    Object.assign(this, extra);
  }
}

export const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.venv', 'venv',
  '__pycache__', '.cache', 'coverage', 'target',
]);

export const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

export function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(s)) return true;
  if (['false', 'no', '0', 'off'].includes(s)) return false;
  return fallback;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function countReplacement(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xfffd) n++;
  return n;
}

/** Decode process / file bytes: UTF-8 first, cp949 (euc-kr) when that yields fewer U+FFFD. */
export function decodeBytes(buf) {
  if (!buf || buf.length === 0) return '';
  let text = new TextDecoder('utf-8').decode(buf);
  const bad = countReplacement(text);
  if (bad > 0) {
    try {
      const alt = new TextDecoder('euc-kr').decode(buf);
      if (countReplacement(alt) < bad) text = alt;
    } catch {
      // ICU without euc-kr: keep UTF-8
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

export function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Keep head 40% + tail 60% of `text` within `max` chars. */
export function truncateMiddle(text, max) {
  if (text.length <= max) return { text, truncated: false };
  const budget = Math.max(0, max - 80);
  const head = Math.floor(budget * 0.4);
  const tail = budget - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** Keep the head of `text` within `max` chars. */
export function truncateHead(text, max) {
  if (text.length <= max) return { text, truncated: false };
  const keep = Math.max(0, max - 100);
  const omitted = text.length - keep;
  return {
    text: `${text.slice(0, keep)}\n[… ${omitted} chars truncated — narrow the request or use offset/limit …]`,
    truncated: true,
  };
}

export function stripAnsi(text) {
  // CSI / OSC sequences
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '');
}

export function compareNames(a, b) {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al < bl ? -1 : al > bl ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Walk files under `root` (depth-first, sorted). Skips IGNORED_DIRS (unless `all`), does not
 * follow symlinked directories. Calls `onFile(absPath, relPosix, dirent)`; return false to stop.
 * `skip(absPath, dirent)` (optional) silently drops an entry (e.g. protected paths) and its subtree.
 */
export async function walkFiles(root, { all = false, signal, maxEntries = 200000, onFile, skip }) {
  let visited = 0;
  let stopped = false;
  async function visit(dir, rel) {
    if (stopped) return;
    if (signal?.aborted) throw new ToolError('Cancelled', { cancelled: true });
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareNames(a.name, b.name));
    for (const entry of entries) {
      if (stopped) return;
      if (++visited > maxEntries) {
        stopped = true;
        return;
      }
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip?.(abs, entry)) continue;
      if (entry.isDirectory()) {
        if (!all && IGNORED_DIRS.has(entry.name)) continue;
        await visit(abs, relPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if ((await onFile(abs, relPath, entry)) === false) {
          stopped = true;
          return;
        }
      }
    }
  }
  await visit(root, '');
  return { visited, limitHit: visited > maxEntries };
}

/** Convert a glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) to a RegExp matching a posix relative path. */
export function globToRegExp(glob, { caseInsensitive = process.platform === 'win32' } = {}) {
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braceDepth++;
      re += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (c === ',' && braceDepth > 0) {
      re += '|';
    } else if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
      } else {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else {
      re += c.replace(/[.+^$()|\\\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

export function isGlobPattern(p) {
  return /[*?[{]/.test(p);
}

/** Build a predicate over posix relative paths from a glob or plain substring pattern. */
export function makePathMatcher(pattern) {
  let p = String(pattern).trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (!isGlobPattern(p)) {
    const needle = p.toLowerCase();
    return (rel) => rel.toLowerCase().includes(needle);
  }
  const re = globToRegExp(p);
  if (!p.includes('/')) {
    return (rel) => re.test(rel.slice(rel.lastIndexOf('/') + 1));
  }
  return (rel) => re.test(rel);
}
