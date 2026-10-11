// The 11 GemInWeb tools: definitions (for `tools` RPC + primer) and implementations.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { applyPatch, PatchError } from './apply-patch.mjs';
import { capLines, unifiedDiff } from './diff.mjs';
import { displayPath, isInside, samePath } from './paths.mjs';
import { findGit, resolveShell, runBackground, runCommand, shellEnv } from './shell.mjs';
import {
  IGNORED_DIRS,
  MAX_SCAN_FILE_BYTES,
  ToolError,
  clamp,
  compareNames,
  decodeBytes,
  formatBytes,
  formatSeconds,
  isBinaryBuffer,
  makePathMatcher,
  toBool,
  toInt,
  truncateHead,
  truncateMiddle,
  walkFiles,
} from './util.mjs';

const P = (name, type, required, description) => ({ name, type, required, description });

/** Canonical tool definitions. `argAliases` maps canonical arg → accepted alternative names. */
export const TOOL_DEFS = [
  {
    name: 'open_workspace',
    aliases: ['open', 'cd'],
    mutating: false,
    description: 'Set the workspace root (a directory). Shows git status, top-level entries and AGENTS.md / GEMINI.md / CLAUDE.md.',
    params: [P('path', 'string', true, 'Directory to open (absolute, ~, or relative to the current workspace).')],
    argAliases: { path: ['dir', 'directory', 'root', 'workspace', 'folder'] },
  },
  {
    name: 'list_dir',
    aliases: ['ls', 'list'],
    mutating: false,
    description: 'List a directory as a tree (dirs first, sizes). Skips .git, node_modules, build output, etc. unless all=true.',
    params: [
      P('path', 'string', false, 'Directory (default ".").'),
      P('depth', 'integer', false, 'Levels to descend, 1-4 (default 1).'),
      P('all', 'boolean', false, 'Also descend into ignored folders like node_modules (default false).'),
    ],
    argAliases: { path: ['dir', 'directory', 'folder'] },
  },
  {
    name: 'find_files',
    aliases: ['glob', 'find'],
    mutating: false,
    description: 'Find files by glob (e.g. "**/*.ts", "src/*.py") or plain substring of the path. Max 200 results.',
    params: [
      P('pattern', 'string', true, 'Glob or substring. A glob without "/" matches file names at any depth.'),
      P('path', 'string', false, 'Directory to search (default ".").'),
    ],
    argAliases: { pattern: ['glob', 'name', 'query'], path: ['dir', 'directory'] },
  },
  {
    name: 'read_file',
    aliases: ['read', 'cat', 'view'],
    mutating: false,
    description: 'Read a text file with line numbers. Use offset/limit for large files.',
    params: [
      P('path', 'string', true, 'File to read.'),
      P('offset', 'integer', false, '1-based first line (default 1).'),
      P('limit', 'integer', false, 'Max lines (default 2000).'),
    ],
    argAliases: { path: ['file_path', 'filePath', 'file', 'filename'], offset: ['start_line', 'startLine', 'line'], limit: ['lines', 'max_lines', 'count'] },
  },
  {
    name: 'write_file',
    aliases: ['write', 'create_file'],
    mutating: true,
    bodyParam: 'content',
    description: 'Create or overwrite a file with the full content (parent folders are created).',
    params: [P('path', 'string', true, 'File to write.'), P('content', 'string', true, 'Complete new file content.')],
    argAliases: { path: ['file_path', 'filePath', 'file', 'filename'], content: ['contents', 'text', 'body', 'data', 'file_text'] },
  },
  {
    name: 'edit_file',
    aliases: ['edit', 'str_replace'],
    mutating: true,
    bodyParam: 'edits',
    description: 'Replace exact text in a file. Each old_text must match exactly once (unless replace_all). All-or-nothing.',
    params: [
      P('path', 'string', true, 'File to edit.'),
      P('edits', 'array', true, 'List of { old_text, new_text, replace_all? } applied in order. Header form: SEARCH/REPLACE blocks.'),
    ],
    argAliases: { path: ['file_path', 'filePath', 'file', 'filename'] },
  },
  {
    name: 'apply_patch',
    aliases: ['patch'],
    mutating: true,
    bodyParam: 'patch',
    description: 'Apply a multi-file patch in "*** Begin Patch" format (Add File / Update File / Delete File / Move to).',
    params: [P('patch', 'string', true, 'The patch text from *** Begin Patch to *** End Patch.')],
    argAliases: { patch: ['input', 'diff', 'content', 'body'] },
  },
  {
    name: 'run_shell',
    aliases: ['bash', 'shell', 'exec', 'run', 'powershell'],
    mutating: true,
    bodyParam: 'command',
    description: 'Run a shell command (Git Bash on Windows unless shell=powershell). Returns combined output and exit code.',
    params: [
      P('command', 'string', true, 'Command line / script.'),
      P('timeout', 'integer', false, 'Seconds before the process tree is killed (default 120).'),
      P('cwd', 'string', false, 'Working directory (default: workspace root).'),
      P('shell', 'string', false, '"bash" or "powershell".'),
      P('background', 'boolean', false, 'Start detached (servers/watchers); returns pid + log file.'),
    ],
    argAliases: { command: ['cmd', 'script', 'commands', 'code'], timeout: ['timeout_sec', 'timeoutSec', 'timeout_seconds'], cwd: ['dir', 'directory', 'workdir'] },
  },
  {
    name: 'search',
    aliases: ['grep', 'rg'],
    mutating: false,
    description: 'Search file contents (literal text by default). Returns path:line: text.',
    params: [
      P('query', 'string', true, 'Text (or regex if regex=true).'),
      P('path', 'string', false, 'File or directory (default ".").'),
      P('regex', 'boolean', false, 'Treat query as a JavaScript regex (default false).'),
      P('case_sensitive', 'boolean', false, 'Default false.'),
      P('glob', 'string', false, 'Only files matching this glob, e.g. "*.ts".'),
      P('max_results', 'integer', false, 'Default 100.'),
    ],
    argAliases: { query: ['pattern', 'q', 'text', 'search'], path: ['dir', 'directory'], case_sensitive: ['caseSensitive'], max_results: ['maxResults', 'limit'], glob: ['include', 'file_pattern'] },
  },
  {
    name: 'show_changes',
    aliases: ['git_diff', 'diff', 'git_status'],
    mutating: false,
    description: 'Show uncommitted git changes: status, diff stat, diff, untracked files.',
    params: [P('path', 'string', false, 'Limit to this file/directory (default: workspace).')],
    argAliases: { path: ['file', 'dir'] },
  },
  {
    name: 'fetch_url',
    aliases: ['fetch', 'open_url'],
    mutating: false,
    description: 'HTTP(S) GET a URL; HTML is converted to readable text.',
    params: [P('url', 'string', true, 'http:// or https:// URL.'), P('max_chars', 'integer', false, 'Default 20000.')],
    argAliases: { url: ['href', 'link', 'uri'], max_chars: ['maxChars', 'limit'] },
  },
];

const BY_NAME = new Map();
for (const def of TOOL_DEFS) {
  BY_NAME.set(def.name, def);
  for (const a of def.aliases) BY_NAME.set(a, def);
}

/** Map a tool name or alias (case/dash-insensitive) to its definition, or null. */
export function resolveToolName(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase().replace(/-/g, '_');
  return BY_NAME.get(key) ?? null;
}

/** Public view of the definitions for the `tools` RPC. */
export function toolList() {
  return TOOL_DEFS.map(({ name, description, mutating, bodyParam, params, aliases }) => ({
    name,
    description,
    mutating,
    ...(bodyParam ? { bodyParam } : {}),
    params,
    aliases,
  }));
}

/** Apply argument aliases (first one wins; canonical names take precedence). */
export function normalizeArgs(def, args, calledAs) {
  const out = { ...args };
  for (const [canon, alts] of Object.entries(def.argAliases ?? {})) {
    if (out[canon] !== undefined) continue;
    for (const alt of alts) {
      if (out[alt] !== undefined) {
        out[canon] = out[alt];
        break;
      }
    }
  }
  if (def.name === 'run_shell' && typeof calledAs === 'string' && calledAs.trim().toLowerCase() === 'powershell' && !out.shell) {
    out.shell = 'powershell';
  }
  return out;
}

// ---------------------------------------------------------------------------- helpers

function requireString(value, what) {
  if (typeof value !== 'string' || value === '') throw new ToolError(`Missing required argument: ${what}`);
  return value;
}

async function statOrNull(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function readTextFile(abs, shown, { maxBytes = 50 * 1024 * 1024 } = {}) {
  const st = await statOrNull(abs);
  if (!st) throw new ToolError(`File not found: ${shown}`);
  if (st.isDirectory()) throw new ToolError(`${shown} is a directory — use list_dir`);
  if (st.size > maxBytes) throw new ToolError(`${shown} is too large (${formatBytes(st.size)})`);
  const buf = await readFile(abs);
  if (isBinaryBuffer(buf)) throw new ToolError(`${shown} looks like a binary file (${formatBytes(buf.length)}); not shown`);
  return { buf, st };
}

// Internal git calls must never execute repository-controlled commands: a planted .git/config
// (core.fsmonitor, filter drivers, diff.external, textconv, hooks, pager) would otherwise run
// during a read-only open_workspace / show_changes. Command-line config wins over repo config.
const GIT_SAFE_ARGS = [
  '-c', 'core.quotepath=false',
  '-c', 'color.ui=false',
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${devNull}`,
  '-c', 'diff.external=',
  '-c', 'core.pager=cat',
  '-c', 'safe.bareRepository=explicit',
  '--no-pager',
  '--no-optional-locks',
];

const GIT_ENV_DROP = /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|EXTERNAL_DIFF|DIFF_OPTS|CONFIG|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|PAGER|EDITOR|SSH|SSH_COMMAND|ASKPASS|EXEC_PATH|TRACE\w*)$/i;

function gitEnv() {
  const env = { ...shellEnv(), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (GIT_ENV_DROP.test(key)) delete env[key];
  return env;
}

function spawnGit(git, args, cwd, signal, env) {
  return new Promise((resolvePromise) => {
    const out = [];
    const err = [];
    let child;
    try {
      child = spawn(git, [...GIT_SAFE_ARGS, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    } catch (e) {
      resolvePromise({ code: -1, stdout: '', stderr: e.message });
      return;
    }
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => resolvePromise({ code: -1, stdout: '', stderr: e.message }));
    child.on('close', (code) =>
      resolvePromise({ code: code ?? -1, stdout: decodeBytes(Buffer.concat(out)), stderr: decodeBytes(Buffer.concat(err)) }),
    );
  });
}

/**
 * Filter drivers (filter.<x>.clean/smudge/process) cannot be disabled with one switch, so list
 * every configured driver and blank it through GIT_CONFIG_COUNT/KEY/VALUE (command-line scope,
 * immune to odd driver names). Resolves { env } or { error } when the config is unreadable.
 */
async function gitSafeEnv(git, cwd, signal) {
  const base = gitEnv();
  const r = await spawnGit(git, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], cwd, signal, base);
  if (r.code !== 0 && r.code !== 1) return { error: r };
  const names = new Set();
  for (const key of r.stdout.split('\0')) {
    const k = key.trim();
    if (!k.toLowerCase().startsWith('filter.') || k.lastIndexOf('.') <= 7) continue;
    names.add(k.slice(7, k.lastIndexOf('.')));
  }
  const pairs = [];
  for (const n of names) {
    for (const [k, v] of [['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false']]) pairs.push([`filter.${n}.${k}`, v]);
  }
  const extra = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => {
    extra[`GIT_CONFIG_KEY_${i}`] = k;
    extra[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return { env: { ...base, ...extra } };
}

/** A hardened git runner for one directory: `run(args)` resolves { code, stdout, stderr } (code -1 when git is unavailable). */
export function gitRunner(cwd, signal) {
  const git = findGit();
  let envPromise = null;
  return async (args) => {
    if (!git) return { code: -1, stdout: '', stderr: 'git not found' };
    envPromise ??= gitSafeEnv(git, cwd, signal);
    const safe = await envPromise;
    if (safe.error) return safe.error;
    return spawnGit(git, args, cwd, signal, safe.env);
  };
}

/** Run git once in `cwd` with the hardened settings above. */
export function runGit(args, cwd, signal) {
  return gitRunner(cwd, signal)(args);
}

/** Predicate hiding read-protected entries under `base` (also when `base` is reached through a link). */
async function hiddenFilter(ctx, base) {
  if (!ctx.policy) return () => false;
  await ctx.policy.ready();
  let realBase = base;
  try {
    realBase = await realpath(base);
  } catch {
    // keep lexical
  }
  const translate = !samePath(realBase, base);
  return (abs) => ctx.policy.isHidden(abs) || (translate && ctx.policy.isHidden(join(realBase, relative(base, abs))));
}

function relPosix(base, abs) {
  const r = relative(base, abs);
  return r === '' ? '.' : r.split(sep).join('/');
}

// ---------------------------------------------------------------------------- open_workspace

const INSTRUCTION_FILES = ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md'];

/** Read a context file at the workspace root, following symlinks only into allowed, unprotected places. */
async function readContextFile(root, name, policy) {
  const abs = join(root, name);
  const target = policy ? await policy.readableReal(abs) : abs;
  if (!target) return null;
  const st = await statOrNull(target);
  if (!st?.isFile() || st.size > MAX_SCAN_FILE_BYTES) return null;
  return readFile(target);
}

export async function readInstructionFile(root, maxChars, policy) {
  for (const name of INSTRUCTION_FILES) {
    try {
      const buf = await readContextFile(root, name, policy);
      if (!buf) continue;
      const text = decodeBytes(buf).trim();
      if (text) return { name, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n[… truncated]` : text };
    } catch {
      // next
    }
  }
  return null;
}

async function openWorkspace(args, ctx) {
  const abs = await ctx.policy.resolve(requireString(args.path, 'path'), ctx.workspace);
  const st = await statOrNull(abs);
  if (!st) throw new ToolError(`Directory not found: ${args.path}`);
  if (!st.isDirectory()) throw new ToolError(`${args.path} is not a directory`);
  let root = abs;
  try {
    root = await realpath(abs);
  } catch {
    // keep lexical
  }
  await ctx.policy.check(root, args.path);

  const lines = [`Workspace: ${root}`];
  const git = gitRunner(root, ctx.signal);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.code === 0) {
    const status = await git(['status', '--short', '--ignore-submodules=dirty']);
    const changed = status.stdout.split('\n').filter(Boolean);
    lines.push(`Git: branch ${branch.stdout.trim()} — ${changed.length ? `${changed.length} changed/untracked` : 'clean'}`);
    for (const l of changed.slice(0, 20)) lines.push(`  ${l}`);
    if (changed.length > 20) lines.push(`  … ${changed.length - 20} more`);
  } else {
    const probe = await git(['rev-parse', '--git-dir']);
    lines.push(probe.code === 0 ? 'Git: repository without commits yet' : 'Git: not a git repository');
  }

  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    lines.push(`(cannot list: ${err.message})`);
  }
  const hidden = await hiddenFilter(ctx, root);
  entries = entries.filter((e) => !hidden(join(root, e.name)));
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? compareNames(a.name, b.name) : a.isDirectory() ? -1 : 1));
  lines.push(`Entries (${entries.length}):`);
  for (const e of entries.slice(0, 60)) lines.push(`  ${e.name}${e.isDirectory() ? '/' : ''}`);
  if (entries.length > 60) lines.push(`  … ${entries.length - 60} more (use list_dir)`);

  for (const name of INSTRUCTION_FILES) {
    try {
      const buf = await readContextFile(root, name, ctx.policy);
      if (!buf) continue;
      const text = decodeBytes(buf);
      if (!text.trim()) continue;
      const shown = text.length > 8000 ? `${text.slice(0, 8000)}\n[… ${text.length - 8000} chars truncated — use read_file]` : text;
      lines.push('', `--- ${name} ---`, shown.trimEnd());
    } catch {
      // not present
    }
  }
  return { output: lines.join('\n'), workspace: root };
}

// ---------------------------------------------------------------------------- list_dir

async function listDir(args, ctx) {
  const shownPath = args.path ?? '.';
  const abs = await ctx.resolve(shownPath);
  const st = await statOrNull(abs);
  if (!st) throw new ToolError(`Directory not found: ${shownPath}`);
  if (!st.isDirectory()) throw new ToolError(`${shownPath} is a file (${formatBytes(st.size)}) — use read_file`);
  const depth = clamp(toInt(args.depth, 1), 1, 4);
  const all = toBool(args.all, false);
  const MAX = 500;
  const out = [];
  let count = 0;
  let capped = false;
  const hidden = await hiddenFilter(ctx, abs);

  async function walk(dir, level, indent) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      out.push(`${indent}(unreadable: ${err.code ?? err.message})`);
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? compareNames(a.name, b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (ctx.signal?.aborted) throw new ToolError('Cancelled', { cancelled: true });
      if (hidden(join(dir, e.name))) continue;
      if (count >= MAX) {
        capped = true;
        return;
      }
      count++;
      const childAbs = join(dir, e.name);
      if (e.isDirectory()) {
        const skipped = !all && IGNORED_DIRS.has(e.name);
        out.push(`${indent}${e.name}/${skipped ? '  (skipped)' : ''}`);
        if (!skipped && level < depth) await walk(childAbs, level + 1, `${indent}  `);
      } else {
        let size = '';
        try {
          const s = await stat(childAbs);
          size = s.isDirectory() ? '/' : `  (${formatBytes(s.size)})`;
        } catch {
          size = '  (broken link)';
        }
        out.push(`${indent}${e.name}${e.isSymbolicLink() ? ' ->' : ''}${size}`);
      }
    }
  }
  await walk(abs, 1, '');
  const header = `${abs}${sep}  (${count} entr${count === 1 ? 'y' : 'ies'}${depth > 1 ? `, depth ${depth}` : ''})`;
  const footer = capped ? `\n[… stopped at ${MAX} entries — list a subdirectory or lower depth]` : '';
  return { output: `${header}\n${out.join('\n') || '(empty directory)'}${footer}`, truncated: capped };
}

// ---------------------------------------------------------------------------- find_files

async function findFiles(args, ctx) {
  const pattern = requireString(typeof args.pattern === 'string' ? args.pattern.trim() : args.pattern, 'pattern');
  const shownPath = args.path ?? '.';
  const base = await ctx.resolve(shownPath);
  const st = await statOrNull(base);
  if (!st?.isDirectory()) throw new ToolError(`Directory not found: ${shownPath}`);
  const match = makePathMatcher(pattern);
  const MAX = 200;
  const found = [];
  let more = 0;
  const hidden = await hiddenFilter(ctx, base);
  const { limitHit } = await walkFiles(base, {
    all: toBool(args.all, false),
    signal: ctx.signal,
    skip: (abs) => hidden(abs),
    onFile: (abs, rel) => {
      if (!match(rel)) return true;
      if (found.length < MAX) found.push(rel);
      else more++;
      return more < 10000;
    },
  });
  if (found.length === 0) return `No files matching "${pattern}" under ${displayPath(base, ctx.workspace)}${limitHit ? ' (scan limit reached)' : ''}`;
  const lines = [`${found.length + more} file(s) matching "${pattern}" under ${displayPath(base, ctx.workspace)}:`, ...found];
  if (more) lines.push(`[… ${more} more not shown — use a narrower pattern or path]`);
  if (limitHit) lines.push('[scan limit reached; results may be incomplete]');
  return { output: lines.join('\n'), truncated: more > 0 };
}

// ---------------------------------------------------------------------------- read_file

async function readFileTool(args, ctx) {
  const shown = requireString(args.path, 'path');
  const abs = await ctx.resolve(shown);
  const { buf } = await readTextFile(abs, shown);
  const text = decodeBytes(buf);
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  if (total === 0) return `(empty file: ${displayPath(abs, ctx.workspace)})`;
  const maxLines = ctx.config.readMaxLines;
  let offset = toInt(args.offset, 1);
  if (offset < 0) offset = Math.max(1, total + offset + 1);
  if (offset < 1) offset = 1;
  if (offset > total) throw new ToolError(`offset ${offset} is past the end of ${shown} (${total} lines)`);
  const limit = clamp(toInt(args.limit, maxLines), 1, maxLines);
  const budget = ctx.config.maxOutputChars - 200;
  const out = [];
  let used = 0;
  let end = offset - 1;
  for (let n = offset; n <= Math.min(total, offset + limit - 1); n++) {
    let line = lines[n - 1];
    if (line.length > 2000) line = `${line.slice(0, 2000)} … [${line.length - 2000} more chars on this line]`;
    const row = `${String(n).padStart(6)}\t${line}`;
    if (used + row.length + 1 > budget && out.length) break;
    out.push(row);
    used += row.length + 1;
    end = n;
  }
  let output = out.join('\n');
  const partial = offset > 1 || end < total;
  if (partial) output += `\n(lines ${offset}-${end} of ${total} — use offset to read more)`;
  return { output, truncated: end < Math.min(total, offset + limit - 1) };
}

// ---------------------------------------------------------------------------- write_file

async function writeFileTool(args, ctx) {
  const shown = requireString(args.path, 'path');
  let content = args.content;
  if (content === undefined || content === null) throw new ToolError('Missing required argument: content');
  if (typeof content !== 'string') content = `${JSON.stringify(content, null, 2)}\n`;
  const abs = await ctx.resolve(shown, { write: true });
  const st = await statOrNull(abs);
  if (st?.isDirectory()) throw new ToolError(`${shown} is a directory`);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  const lineCount = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  return `Wrote ${lineCount} lines (${bytes} bytes) to ${displayPath(abs, ctx.workspace)} (${st ? 'overwritten' : 'created'})`;
}

// ---------------------------------------------------------------------------- edit_file

const SR_SEARCH = /^<{5,9} SEARCH\s*$/;
const SR_DIVIDER = /^={5,9}\s*$/;
const SR_REPLACE = /^>{5,9} REPLACE\s*$/;

/** Parse Aider-style SEARCH/REPLACE blocks into [{ old_text, new_text }]. */
export function parseSearchReplace(body) {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n');
  const edits = [];
  let i = 0;
  while (i < lines.length) {
    if (!SR_SEARCH.test(lines[i])) {
      i++;
      continue;
    }
    i++;
    const oldLines = [];
    while (i < lines.length && !SR_DIVIDER.test(lines[i])) oldLines.push(lines[i++]);
    if (i >= lines.length) throw new ToolError('SEARCH block without ======= divider');
    i++;
    const newLines = [];
    while (i < lines.length && !SR_REPLACE.test(lines[i])) newLines.push(lines[i++]);
    if (i >= lines.length) throw new ToolError('SEARCH block without >>>>>>> REPLACE marker');
    i++;
    edits.push({ old_text: oldLines.join('\n'), new_text: newLines.join('\n') });
  }
  return edits;
}

function pick(obj, names) {
  for (const n of names) if (obj[n] !== undefined) return obj[n];
  return undefined;
}

const OLD_NAMES = ['old_text', 'oldText', 'old_string', 'oldString', 'old_str', 'old', 'search'];
const NEW_NAMES = ['new_text', 'newText', 'new_string', 'newString', 'new_str', 'new', 'replace', 'replacement'];

export function normalizeEdits(args) {
  let edits = args.edits ?? args.changes ?? args.edit;
  if (typeof edits === 'string') {
    const s = edits.trim();
    if (/^[[{]/.test(s)) {
      try {
        edits = JSON.parse(s);
      } catch {
        throw new ToolError('edits is not valid JSON');
      }
    } else {
      edits = parseSearchReplace(s);
      if (!edits.length) throw new ToolError('edits body has no <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks');
    }
  }
  if (edits === undefined || edits === null) {
    const old = pick(args, OLD_NAMES);
    if (old === undefined) throw new ToolError('Missing edits: give edits: [{ old_text, new_text }] (or old_text/new_text)');
    edits = [{ old_text: old, new_text: pick(args, NEW_NAMES), replace_all: args.replace_all ?? args.replaceAll }];
  }
  if (!Array.isArray(edits)) edits = [edits];
  if (!edits.length) throw new ToolError('edits is empty');
  const globalAll = toBool(args.replace_all ?? args.replaceAll, false);
  return edits.map((e, i) => {
    if (!e || typeof e !== 'object') throw new ToolError(`edit ${i + 1} is not an object`);
    const oldText = pick(e, OLD_NAMES);
    const newText = pick(e, NEW_NAMES);
    if (typeof oldText !== 'string' || oldText === '') throw new ToolError(`edit ${i + 1}: old_text is missing or empty (use write_file to create a file)`);
    if (typeof newText !== 'string') throw new ToolError(`edit ${i + 1}: new_text is missing`);
    return { oldText, newText, replaceAll: toBool(e.replace_all ?? e.replaceAll, globalAll) };
  });
}

function findAll(hay, needle) {
  const pos = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    pos.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return pos;
}

function lineNumberAt(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function bigrams(s) {
  const set = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    set.set(g, (set.get(g) ?? 0) + 1);
  }
  return set;
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

function closestLines(content, oldText) {
  const fileLines = content.replace(/\r\n/g, '\n').split('\n');
  const oldLines = oldText.replace(/\r\n/g, '\n').split('\n');
  const probe = oldLines.find((l) => l.trim()) ?? oldLines[0];
  const target = probe.trim();
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < fileLines.length; i++) {
    const s = similarity(fileLines[i].trim(), target);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  if (best < 0 || bestScore < 0.3) return '';
  const offsetInOld = Math.max(0, oldLines.indexOf(probe));
  const from = Math.max(0, best - offsetInOld - 2);
  const to = Math.min(fileLines.length, from + Math.min(oldLines.length + 4, 14));
  const rows = [];
  for (let i = from; i < to; i++) rows.push(`${String(i + 1).padStart(6)}\t${fileLines[i]}`);
  return `Closest match near line ${best + 1}:\n${rows.join('\n')}`;
}

function convertEol(text, eol) {
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
}

/** Line-wise match ignoring trailing whitespace. Returns [{ start, end }] char ranges. */
function fuzzyLineMatches(content, oldText) {
  const segs = content.split(/(?<=\n)/);
  const starts = [];
  let acc = 0;
  for (const s of segs) {
    starts.push(acc);
    acc += s.length;
  }
  let oldLines = oldText.replace(/\r\n/g, '\n').split('\n');
  const oldEndsNl = oldText.endsWith('\n');
  if (oldEndsNl) oldLines = oldLines.slice(0, -1);
  if (!oldLines.length) return [];
  const strip = (s) => s.replace(/\r?\n$/, '').trimEnd();
  const matches = [];
  for (let i = 0; i + oldLines.length <= segs.length; i++) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k++) {
      if (strip(segs[i + k]) !== oldLines[k].trimEnd()) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const last = segs[i + oldLines.length - 1];
      const lastEol = /\r?\n$/.exec(last)?.[0] ?? '';
      const start = starts[i];
      const end = starts[i + oldLines.length - 1] + last.length - (oldEndsNl ? 0 : lastEol.length);
      matches.push({ start, end });
    }
  }
  return matches;
}

async function editFileTool(args, ctx) {
  const shown = requireString(args.path, 'path');
  const edits = normalizeEdits(args);
  const abs = await ctx.resolve(shown, { write: true });
  const { buf } = await readTextFile(abs, shown);
  let original;
  try {
    original = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new ToolError(`${shown} is not valid UTF-8; edit_file only edits UTF-8 text (use write_file or run_shell)`);
  }
  const bom = original.startsWith('﻿') ? '﻿' : '';
  if (bom) original = original.slice(1);
  const crlf = (original.match(/\r\n/g) ?? []).length;
  const lf = (original.match(/\n/g) ?? []).length - crlf;
  const eol = crlf > 0 && crlf >= lf ? '\r\n' : '\n';
  const display = displayPath(abs, ctx.workspace);

  let content = original;
  const notes = [];
  edits.forEach((edit, idx) => {
    const label = edits.length > 1 ? `edit ${idx + 1} of ${edits.length}` : 'edit';
    if (edit.oldText === edit.newText) throw new ToolError(`${label}: old_text and new_text are identical`);
    const newText = original.includes('\n') ? convertEol(edit.newText, eol) : edit.newText;
    const candidates = [edit.oldText];
    const converted = convertEol(edit.oldText, eol);
    if (converted !== edit.oldText) candidates.push(converted);
    for (const cand of candidates) {
      const pos = findAll(content, cand);
      if (pos.length === 0) continue;
      if (pos.length > 1 && !edit.replaceAll) {
        const where = pos.slice(0, 8).map((p) => lineNumberAt(content, p)).join(', ');
        throw new ToolError(
          `edit_file failed (no changes made): ${label} — old_text matches ${pos.length} times in ${display} (lines ${where}${pos.length > 8 ? ', …' : ''}). Include more surrounding lines so it is unique, or set replace_all: true.`,
        );
      }
      content = edit.replaceAll ? content.split(cand).join(newText) : content.slice(0, pos[0]) + newText + content.slice(pos[0] + cand.length);
      return;
    }
    const fuzzy = fuzzyLineMatches(content, edit.oldText);
    if (fuzzy.length === 1 || (fuzzy.length > 1 && edit.replaceAll)) {
      for (const m of [...fuzzy].reverse()) content = content.slice(0, m.start) + newText + content.slice(m.end);
      notes.push(`${label} matched ignoring trailing whitespace`);
      return;
    }
    if (fuzzy.length > 1) {
      throw new ToolError(`edit_file failed (no changes made): ${label} — old_text matches ${fuzzy.length} times in ${display} (ignoring trailing whitespace). Include more surrounding lines.`);
    }
    const hint = closestLines(content, edit.oldText);
    throw new ToolError(
      `edit_file failed (no changes made): ${label} — old_text not found in ${display}.${hint ? `\n${hint}` : ''}\nRe-read the file with read_file and copy the exact text (indentation included).`,
    );
  });

  if (content === original) throw new ToolError('edit_file: the edits produced no change');
  await writeFile(abs, bom + content, 'utf8');
  const diff = unifiedDiff(original, content, { oldName: `a/${display}`, newName: `b/${display}` });
  const summary = `Edited ${display}: ${edits.length} edit${edits.length > 1 ? 's' : ''} applied (+${diff.additions} -${diff.removals} lines)${eol === '\r\n' ? ' [CRLF kept]' : ''}`;
  return [summary, ...notes.map((n) => `note: ${n}`), capLines(diff.text, 80)].join('\n');
}

// ---------------------------------------------------------------------------- apply_patch

async function applyPatchTool(args, ctx) {
  const patch = requireString(args.patch, 'patch');
  let res;
  try {
    res = await applyPatch(patch, { resolvePath: (p) => ctx.resolve(p, { write: true }) });
  } catch (err) {
    if (err instanceof PatchError) throw new ToolError(`${err.message}\n(no files were changed)`);
    throw err;
  }
  const code = { add: 'A', update: 'M', delete: 'D', move: 'R' };
  const lines = [`Applied patch: ${res.files.length} file(s) changed (+${res.additions} -${res.removals})`];
  for (const f of res.files) lines.push(`${code[f.operation]} ${f.previousPath ? `${f.previousPath} -> ` : ''}${f.path}`);
  return `${lines.join('\n')}\n\n${capLines(res.patch, 80)}`;
}

// ---------------------------------------------------------------------------- run_shell

function normalizeCommand(cmd) {
  if (Array.isArray(cmd)) {
    if (cmd.length >= 3 && /^(bash|sh|zsh)$/.test(cmd[0]) && /^-l?c$/.test(cmd[1])) return cmd.slice(2).join(' ');
    return cmd.join(' ');
  }
  return cmd;
}

async function runShellTool(args, ctx) {
  const command = requireString(normalizeCommand(args.command), 'command').replace(/\r\n/g, '\n');
  for (const rule of ctx.config.blockedCommands) {
    let re;
    try {
      re = new RegExp(rule, 'i');
    } catch {
      continue;
    }
    if (re.test(command)) throw new ToolError(`Command refused: it matches the blockedCommands rule /${rule}/ in config.json`);
  }
  let shell;
  try {
    shell = resolveShell(ctx.config, args.shell);
  } catch (err) {
    throw new ToolError(err.message);
  }
  const cwd = args.cwd ? await ctx.resolve(args.cwd) : ctx.workspace;
  if (!cwd) throw new ToolError('No workspace is open; call open_workspace first or pass an absolute cwd');
  const st = await statOrNull(cwd);
  if (!st?.isDirectory()) throw new ToolError(`cwd is not a directory: ${args.cwd ?? cwd}`);
  const header = `$ ${command}\n[cwd: ${cwd} · shell: ${shell.kind}]`;

  if (toBool(args.background, false)) {
    const { pid, logPath } = runBackground({ shell, command, cwd, logsDir: ctx.logsDir });
    const stop = shell.kind === 'bash' ? `taskkill //PID ${pid} //T //F` : `Stop-Process -Id ${pid}`;
    return `${header}\nStarted in background: pid ${pid}\nLog: ${logPath}\nRead the log with read_file; stop it with: ${process.platform === 'win32' ? stop : `kill ${pid}`}`;
  }

  const timeoutSec = clamp(toInt(args.timeout, ctx.config.commandTimeoutSec), 1, ctx.config.maxCommandTimeoutSec);
  const r = await runCommand({ shell, command, cwd, timeoutMs: timeoutSec * 1000, signal: ctx.signal });
  const secs = formatSeconds(r.durationMs);
  let footer;
  if (r.timedOut) footer = `[killed: timeout after ${timeoutSec}s · ${secs}]`;
  else if (r.cancelled) footer = `[cancelled · ${secs}]`;
  else if (r.exitCode === null && r.signal) footer = `[signal ${r.signal} · ${secs}]`;
  else if (r.exitCode === null) footer = `[failed to start · ${secs}]`;
  else footer = `[exit ${r.exitCode} · ${secs}]`;
  const budget = Math.max(2000, ctx.config.maxOutputChars - header.length - footer.length - 200);
  const body = truncateMiddle(r.output.replace(/\s+$/, ''), budget);
  const parts = [header];
  if (body.text) parts.push(body.text);
  if (r.note) parts.push(r.note);
  parts.push(footer);
  return {
    ok: !r.timedOut && !r.cancelled && r.exitCode === 0,
    output: parts.join('\n'),
    truncated: body.truncated,
    cancelled: r.cancelled || undefined,
    capped: true,
  };
}

// ---------------------------------------------------------------------------- search

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function searchTool(args, ctx) {
  const query = requireString(args.query === undefined ? undefined : String(args.query), 'query');
  const shownPath = args.path ?? '.';
  const base = await ctx.resolve(shownPath);
  const st = await statOrNull(base);
  if (!st) throw new ToolError(`Path not found: ${shownPath}`);
  const caseSensitive = toBool(args.case_sensitive, false);
  let re;
  try {
    re = new RegExp(toBool(args.regex, false) ? query : escapeRegExp(query), caseSensitive ? '' : 'i');
  } catch (err) {
    throw new ToolError(`Invalid regex: ${err.message}`);
  }
  const maxResults = clamp(toInt(args.max_results, 100), 1, 2000);
  const globMatch = args.glob ? makePathMatcher(String(args.glob)) : null;
  const results = [];
  const filesWithHits = new Set();
  let filesSearched = 0;
  let limited = false;

  const scan = async (abs, rel, entry) => {
    if (globMatch && !globMatch(rel)) return true;
    let target = abs;
    if (entry?.isSymbolicLink()) {
      // follow a file symlink only into allowed, unprotected places
      target = ctx.policy ? await ctx.policy.readableReal(abs) : abs;
      if (!target) return true;
    }
    let s;
    try {
      s = await stat(target);
    } catch {
      return true;
    }
    if (!s.isFile() || s.size > MAX_SCAN_FILE_BYTES) return true;
    let buf;
    try {
      buf = await readFile(target);
    } catch {
      return true;
    }
    if (isBinaryBuffer(buf)) return true;
    filesSearched++;
    const lines = decodeBytes(buf).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (results.length >= maxResults) {
        limited = true;
        return false;
      }
      let text = lines[i].trim();
      if (text.length > 300) text = `${text.slice(0, 300)}…`;
      results.push(`${rel}:${i + 1}: ${text}`);
      filesWithHits.add(rel);
    }
    return true;
  };

  if (st.isFile()) {
    await scan(base, displayPath(base, ctx.workspace));
  } else {
    const hidden = await hiddenFilter(ctx, base);
    await walkFiles(base, { signal: ctx.signal, skip: (abs) => hidden(abs), onFile: (abs, rel, entry) => scan(abs, rel, entry) });
  }
  const where = displayPath(base, ctx.workspace);
  if (!results.length) return `No matches for "${query}" in ${where} (${filesSearched} files searched)`;
  const footer = `${results.length} match(es) in ${filesWithHits.size} file(s)${limited ? ` — stopped at max_results=${maxResults}; narrow the query/path or raise max_results` : ''}`;
  return { output: `${results.join('\n')}\n${footer}`, truncated: limited };
}

// ---------------------------------------------------------------------------- show_changes

const SAFE_DIFF = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'];

async function showChanges(args, ctx) {
  const target = args.path ? await ctx.resolve(args.path) : ctx.workspace;
  if (!target) throw new ToolError('No workspace is open; call open_workspace first');
  const st = await statOrNull(target);
  if (!st) throw new ToolError(`Path not found: ${args.path}`);
  const dir = st.isDirectory() ? target : dirname(target);
  const git = gitRunner(dir, ctx.signal);
  const top = await git(['rev-parse', '--show-toplevel']);
  if (top.code === -1 && /not found/.test(top.stderr)) throw new ToolError('git is not installed or not on PATH');
  if (top.code !== 0) throw new ToolError(`Not a git repository: ${dir}`);
  const spec = args.path ? ['--', target] : [];
  const [branch, status, stat2, diff, cachedStat, cached, untracked] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--short', '--ignore-submodules=dirty', ...spec]),
    git(['diff', '--stat', ...SAFE_DIFF, ...spec]),
    git(['diff', ...SAFE_DIFF, ...spec]),
    git(['diff', '--cached', '--stat', ...SAFE_DIFF, ...spec]),
    git(['diff', '--cached', ...SAFE_DIFF, ...spec]),
    git(['ls-files', '--others', '--exclude-standard', ...spec]),
  ]);
  const root = top.stdout.trim();
  const lines = [`Repository: ${root}${branch.code === 0 ? ` (branch ${branch.stdout.trim()})` : ' (no commits yet)'}`];
  if (!status.stdout.trim()) {
    lines.push('Working tree clean — no uncommitted changes.');
    return lines.join('\n');
  }
  lines.push('## git status --short', status.stdout.trimEnd());
  if (stat2.stdout.trim()) lines.push('', '## git diff --stat', stat2.stdout.trimEnd());
  if (cachedStat.stdout.trim()) lines.push('', '## staged: git diff --cached --stat', cachedStat.stdout.trimEnd());
  const untrackedList = untracked.stdout.split('\n').filter(Boolean);
  if (untrackedList.length) {
    lines.push('', `## untracked files (${untrackedList.length})`, ...untrackedList.slice(0, 100));
    if (untrackedList.length > 100) lines.push(`… ${untrackedList.length - 100} more`);
  }
  const budget = ctx.config.maxOutputChars - lines.join('\n').length - 300;
  const diffs = [];
  if (diff.stdout.trim()) diffs.push('## git diff', diff.stdout.trimEnd());
  if (cached.stdout.trim()) diffs.push('## staged: git diff --cached', cached.stdout.trimEnd());
  let truncated = false;
  if (diffs.length) {
    const t = truncateHead(diffs.join('\n\n'), Math.max(1000, budget));
    truncated = t.truncated;
    lines.push('', t.text);
  }
  return { output: lines.join('\n'), truncated };
}

// ---------------------------------------------------------------------------- fetch_url

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', laquo: '«', raquo: '»', deg: '°', times: '×', euro: '€', pound: '£', yen: '¥', cent: '¢',
  sect: '§', para: '¶', larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥', check: '✓',
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Convert HTML to readable plain text (drops script/style/nav/svg/head, keeps headings & lists). */
export function htmlToText(html) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|nav|svg|template|iframe|head|canvas)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_, l) => `\n\n${'#'.repeat(Number(l))} `);
  s = s.replace(/<\/(p|div|section|article|header|footer|h[1-6]|ul|ol|table|tr|blockquote|pre|main|aside|dl|dt|dd|figure|figcaption)\s*>/gi, '\n');
  s = s.replace(/<(p|div|section|article|tr|blockquote|pre|table|main|header|footer)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/t[dh]\s*>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  const lines = s.split('\n').map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim());
  const out = [];
  for (const l of lines) {
    if (!l && (!out.length || !out[out.length - 1])) continue;
    out.push(l);
  }
  const text = out.join('\n').trim();
  return title ? `Title: ${title}\n\n${text}` : text;
}

async function fetchUrl(args, ctx) {
  const raw = requireString(typeof args.url === 'string' ? args.url.trim() : args.url, 'url');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError('Only http:// and https:// URLs are allowed');
  const maxChars = clamp(toInt(args.max_chars, 20000), 100, 200000);
  const timeout = AbortSignal.timeout(20000);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DevSpaceGem/0.1)',
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
      },
    });
  } catch (err) {
    if (ctx.signal?.aborted) throw new ToolError('Cancelled', { cancelled: true });
    if (timeout.aborted) throw new ToolError(`fetch_url timed out after 20 s: ${url.href}`);
    throw new ToolError(`fetch_url failed: ${err.cause?.message ?? err.message}`);
  }
  const type = res.headers.get('content-type') ?? 'unknown';
  const header = `HTTP ${res.status} ${res.url || url.href} (${type})`;
  const chunks = [];
  let size = 0;
  const LIMIT = 10 * 1024 * 1024;
  try {
    for await (const chunk of res.body ?? []) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > LIMIT) break;
    }
  } catch (err) {
    if (ctx.signal?.aborted) throw new ToolError('Cancelled', { cancelled: true });
    throw new ToolError(`fetch_url failed while reading the body: ${err.message}`);
  }
  const buf = Buffer.concat(chunks);
  let body;
  if (/^(image|audio|video|font)\/|octet-stream|application\/(pdf|zip|gzip)/i.test(type) || isBinaryBuffer(buf)) {
    body = `[binary content, ${formatBytes(buf.length)} — not shown]`;
  } else {
    const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1];
    let text;
    try {
      text = charset && !/utf-?8/i.test(charset) ? new TextDecoder(charset).decode(buf) : decodeBytes(buf);
    } catch {
      text = decodeBytes(buf);
    }
    body = /html|xml/i.test(type) || /^\s*<(!doctype html|html)/i.test(text) ? htmlToText(text) : text;
  }
  const t = truncateHead(body, maxChars);
  return { ok: res.ok, output: `${header}\n\n${t.text}`, truncated: t.truncated || size > LIMIT };
}

// ---------------------------------------------------------------------------- registry

export const TOOL_IMPLS = {
  open_workspace: openWorkspace,
  list_dir: listDir,
  find_files: findFiles,
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  apply_patch: applyPatchTool,
  run_shell: runShellTool,
  search: searchTool,
  show_changes: showChanges,
  fetch_url: fetchUrl,
};

export { isInside, relPosix };
