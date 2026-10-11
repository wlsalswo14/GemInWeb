// Model-facing primer: the protocol the model uses to call GemInWeb tools.
// Examples here must parse under the protocol in docs/SPEC.md (tested in test/core/primer.test.mjs).
import { release, version as osVersion } from 'node:os';
import { readInstructionFile, TOOL_DEFS } from './tools.mjs';

export const PROTOCOL_MARKER = '[GemInWeb protocol v1]';
export const CONTEXT_MARKER = '[DevSpace context]';
export const FULL_PRIMER_MAX = 6000;
export const INSTRUCTION_EXCERPT_MAX = 1500;

const F = '```';

const PROTOCOL = `${PROTOCOL_MARKER}
You are connected to the user's real computer through the GemInWeb browser extension. It runs the tools below on the user's machine and sends the real results back. You CAN read and edit files and run commands here; never say you lack access.

HOW TO CALL TOOLS
Write a fenced code block tagged devspace, then STOP and wait. Results arrive in the next message as "[DevSpace result …]". Never write, guess or simulate results yourself.

JSON form (any tool):
${F}devspace
{"tool": "read_file", "args": {"path": "src/app.py", "offset": 1, "limit": 200}}
${F}

Header form (no JSON escaping; best for file content, patches, scripts): "key: value" lines, a line that is exactly ---, then the body.
${F}devspace
tool: write_file
path: src/hello.py
---
print("hello")
${F}

The body is the content for write_file, the command for run_shell, the patch for apply_patch, and SEARCH/REPLACE blocks for edit_file:
${F}devspace
tool: edit_file
path: src/hello.py
---
<<<<<<< SEARCH
print("hello")
=======
print("hello, world")
>>>>>>> REPLACE
${F}

SEARCH text must match the file exactly (indentation included) and only once; add nearby lines to make it unique. Several blocks may follow each other; "replace_all: true" replaces every match.
If a body contains ${F}, use a longer fence: open with ${F}\`devspace and close with ${F}\`.

RULES
- Batch independent read-only calls (several blocks in one message). Writes and commands: one per message unless independent; check each result before continuing.
- Paths are relative to the workspace; open_workspace switches projects.
- On Windows run_shell uses Git Bash (POSIX: ls, grep, &&, /c/Users/...) unless you add "shell: powershell".
- Read before you edit. edit_file for small changes, write_file for new files or full rewrites.
- When the task is done (or you need the user's input), answer normally with NO devspace block.
- Always reply to the user in the user's language.
- Do not use your own code-execution sandbox for the user's files; use these tools.`;

const TOOL_LINES = {
  open_workspace: 'open_workspace(path) — open a project folder: git status, top-level files, AGENTS.md',
  list_dir: 'list_dir(path?=".", depth?=1 (max 4), all?=false) — directory tree; skips .git, node_modules, build dirs unless all',
  find_files: 'find_files(pattern, path?) — glob like "**/*.ts" or a name substring (max 200)',
  read_file: 'read_file(path, offset?, limit?) — numbered lines; use offset/limit for big files',
  write_file: 'write_file(path, content) — create or overwrite the whole file',
  edit_file: 'edit_file(path, edits) — exact replacements; edits = [{"old_text": "…", "new_text": "…", "replace_all": false}] or a SEARCH/REPLACE body',
  apply_patch:
    'apply_patch(patch) — multi-file patch: *** Begin Patch, then *** Add File: p (lines start with +) | *** Update File: p (@@ hunks of " " context, -old, +new) | *** Delete File: p, then *** End Patch',
  run_shell: 'run_shell(command, timeout?=120, cwd?, shell?, background?) — output + exit code; background: true for servers/watchers',
  search: 'search(query, path?, regex?=false, case_sensitive?=false, glob?, max_results?=100) — grep file contents',
  show_changes: 'show_changes(path?) — git status + diff of uncommitted changes',
  fetch_url: 'fetch_url(url, max_chars?=20000) — GET a web page as readable text',
};

function toolDocs() {
  const lines = ['TOOLS (? = optional, =default)'];
  for (const def of TOOL_DEFS) {
    const fallback = `${def.name}(${def.params.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ')}) — ${def.description}`;
    lines.push(`- ${TOOL_LINES[def.name] ?? fallback}`);
  }
  return lines.join('\n');
}

/** Protocol + tool docs, no dynamic context (for Gem / AI Studio system instructions). */
export function staticPrimer() {
  return `${PROTOCOL}\n\n${toolDocs()}\n\nEach new chat starts with a ${CONTEXT_MARKER} block (time, OS, shell, workspace). Use it.`;
}

function fmtDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const off = `${sign}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`;
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // ignore
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (UTC${off}${tz ? ` ${tz}` : ''})`;
}

function osName() {
  try {
    return `${osVersion()} (${process.platform} ${release()})`;
  } catch {
    return `${process.platform} ${release()}`;
  }
}

/**
 * Short dynamic context block.
 * info = { workspace, workspaceError?, allowedRoots, shell: {kind,path}|null, now?, instructionMax? }
 */
export async function contextBlock(info) {
  const lines = [CONTEXT_MARKER];
  lines.push(`Time: ${fmtDate(info.now ?? new Date())}`);
  const shell = info.shell
    ? `${info.shell.kind === 'bash' ? (process.platform === 'win32' ? 'Git Bash' : 'bash') : 'PowerShell'} (${info.shell.path})`
    : 'unavailable';
  lines.push(`OS: ${osName()} · shell: ${shell}`);
  lines.push(`Workspace: ${info.workspace ?? `(none${info.workspaceError ? ` — ${info.workspaceError}` : ''}; call open_workspace)`}`);
  lines.push(`Allowed roots: ${(info.allowedRoots ?? []).join(', ') || '(none)'}`);
  if (info.workspace) {
    const max = Math.max(0, Math.min(INSTRUCTION_EXCERPT_MAX, info.instructionMax ?? INSTRUCTION_EXCERPT_MAX));
    const instr = max > 100 ? await readInstructionFile(info.workspace, max, info.policy) : null;
    if (instr) lines.push(`Project instructions (${instr.name}, excerpt):`, instr.text);
  }
  return lines.join('\n');
}

/**
 * Build the primer. mode 'full' = protocol + tools + context (≤ 6000 chars);
 * 'context' = only the context block. Returns { text, marker }.
 */
export async function buildPrimer({ mode = 'full', site = 'generic', info }) {
  if (mode === 'context') {
    return { text: await contextBlock(info), marker: CONTEXT_MARKER };
  }
  const head = staticPrimer();
  const siteNote = site === 'gemini' ? '\nGemini app: write the devspace blocks directly in your reply (not in Canvas).' : '';
  const base = `${head}${siteNote}\n\n`;
  const probe = await contextBlock({ ...info, instructionMax: 0 });
  const room = FULL_PRIMER_MAX - base.length - probe.length - 60;
  let ctx = await contextBlock({ ...info, instructionMax: room });
  if (base.length + ctx.length > FULL_PRIMER_MAX) ctx = probe;
  let text = `${base}${ctx}`;
  if (text.length > FULL_PRIMER_MAX) text = text.slice(0, FULL_PRIMER_MAX);
  return { text, marker: PROTOCOL_MARKER };
}
