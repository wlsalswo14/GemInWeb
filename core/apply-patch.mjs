// Codex-style `*** Begin Patch` applier.
//
// Ported to plain JavaScript from DevSpace `src/apply-patch.ts`
// (https://github.com/Waishnav/devspace), MIT License, Copyright (c) 2026 Waishnav.
// Permission is hereby granted, free of charge, to any person obtaining a copy of this
// software ... (full MIT text: see the upstream LICENSE). Changes: no `diff` dependency
// (uses ./diff.mjs), path confinement delegated to the GemInWeb path policy,
// tolerant of missing Begin/End markers and surrounding code fences.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { unifiedDiff } from './diff.mjs';
import { cmpKey, realpathNearest } from './paths.mjs';

export class PatchError extends Error {
  constructor(message) {
    super(`Invalid patch: ${message}`);
    this.name = 'PatchError';
  }
}

const patchError = (message) => new PatchError(message);

function patchLines(patch) {
  let lines = String(patch).replace(/\r\n/g, '\n').trim().split('\n');
  // strip a surrounding ``` fence
  if (lines.length >= 2 && /^`{3,}/.test(lines[0].trim()) && /^`{3,}$/.test(lines.at(-1).trim())) {
    lines = lines.slice(1, -1);
  }
  const first = lines[0]?.trim();
  const last = lines.at(-1)?.trim();
  if ((first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') && last?.endsWith('EOF') && lines.length >= 4) {
    lines = lines.slice(1, -1);
  }
  // tolerate missing markers when the body clearly is a patch
  if (lines[0]?.trim() !== '*** Begin Patch' && lines.some(isTopLevelHeader)) lines.unshift('*** Begin Patch');
  if (lines.at(-1)?.trim() !== '*** End Patch' && lines[0]?.trim() === '*** Begin Patch') lines.push('*** End Patch');
  return lines;
}

function isTopLevelHeader(line) {
  const t = line.trim();
  return (
    t.startsWith('*** Add File: ') ||
    t.startsWith('*** Delete File: ') ||
    t.startsWith('*** Update File: ') ||
    t.startsWith('*** Environment ID: ')
  );
}

/** Parse a patch into actions: {kind:'add',path,content} | {kind:'delete',path} | {kind:'update',path,moveTo?,hunks}. */
export function parsePatch(patch) {
  const lines = patchLines(patch);
  if (lines.shift()?.trim() !== '*** Begin Patch') throw patchError('missing *** Begin Patch marker');
  if (lines.pop()?.trim() !== '*** End Patch') throw patchError('missing *** End Patch marker');

  const actions = [];
  let index = 0;
  while (index < lines.length) {
    const header = lines[index++].trim();
    if (header === '') continue;

    if (header.startsWith('*** Environment ID: ')) {
      if (!header.slice('*** Environment ID: '.length).trim()) throw patchError('environment id cannot be empty');
      continue;
    }

    if (header.startsWith('*** Add File: ')) {
      const path = header.slice('*** Add File: '.length).trim();
      const content = [];
      while (index < lines.length && !isTopLevelHeader(lines[index])) {
        const line = lines[index++];
        if (!line.startsWith('+')) throw patchError(`added file line must start with +: ${line}`);
        content.push(line.slice(1));
      }
      if (content.length === 0) throw patchError(`add file for ${path} has no content`);
      actions.push({ kind: 'add', path, content: `${content.join('\n')}\n` });
      continue;
    }

    if (header.startsWith('*** Delete File: ')) {
      actions.push({ kind: 'delete', path: header.slice('*** Delete File: '.length).trim() });
      continue;
    }

    if (header.startsWith('*** Update File: ')) {
      const path = header.slice('*** Update File: '.length).trim();
      let moveTo;
      const hunks = [];
      if (lines[index]?.trim().startsWith('*** Move to: ')) {
        moveTo = lines[index++].trim().slice('*** Move to: '.length).trim();
      }
      let current;
      const finishCurrent = () => {
        if (!current) return;
        while (current.lines.length && current.lines.at(-1).bare) current.lines.pop();
        if (current.lines.length === 0) throw patchError(`empty update hunk for ${path}`);
        hunks.push(current);
        current = undefined;
      };
      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();
        if (!current && trimmed === '') {
          index++;
          continue;
        }
        if (trimmed === '*** End of File') {
          if (!current) throw patchError(`end-of-file marker without update hunk for ${path}`);
          current.endOfFile = true;
          index++;
          continue;
        }
        if ((!current || !line.startsWith(' ')) && isTopLevelHeader(line)) break;
        if (trimmed.startsWith('@@') && !line.startsWith(' ')) {
          finishCurrent();
          const changeContext = trimmed.slice(2).trim();
          current = { lines: [], changeContext: changeContext || undefined };
          index++;
          continue;
        }
        current ??= { lines: [] };
        index++;
        if (line.startsWith(' ')) current.lines.push({ kind: 'context', text: line.slice(1) });
        else if (line.startsWith('+')) current.lines.push({ kind: 'add', text: line.slice(1) });
        else if (line.startsWith('-')) current.lines.push({ kind: 'remove', text: line.slice(1) });
        else if (line === '\\ No newline at end of file') continue;
        else if (line === '') current.lines.push({ kind: 'context', text: '', bare: true });
        else throw patchError(`hunk line must start with space, +, or -: ${line}`);
      }
      finishCurrent();
      if (hunks.length === 0 && !moveTo) throw patchError(`update for ${path} has no hunks or move destination`);
      actions.push({ kind: 'update', path, moveTo, hunks });
      continue;
    }

    throw patchError(`unknown action header: ${header}`);
  }
  if (actions.length === 0) throw patchError('contains no file actions');
  return actions;
}

function splitFile(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n/g, '\n');
  if (normalized === '') return { lines: [], eol, finalNewline: true };
  const finalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function findSequence(haystack, needle, from, endOfFile = false) {
  if (needle.length === 0) return from;
  const matchAt = (index, normalize) =>
    needle.every((line, offset) => normalize(haystack[index + offset] ?? '') === normalize(line));
  for (const normalize of [(v) => v, (v) => v.trimEnd(), (v) => v.trim()]) {
    const start = endOfFile ? haystack.length - needle.length : from;
    const end = haystack.length - needle.length;
    for (let index = start; index <= end; index += 1) {
      if (index >= from && matchAt(index, normalize)) return index;
    }
  }
  return -1;
}

function applyHunks(path, content, hunks) {
  const file = splitFile(content);
  const lines = [...file.lines];
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.changeContext) {
      const contextIndex = findSequence(lines, [hunk.changeContext], cursor);
      if (contextIndex < 0) throw patchError(`could not find hunk context in ${path}: ${hunk.changeContext}`);
      cursor = contextIndex + 1;
    }
    const oldLines = hunk.lines.filter((l) => l.kind !== 'add').map((l) => l.text);
    const newLines = hunk.lines.filter((l) => l.kind !== 'remove').map((l) => l.text);
    // A pure addition (no context/removed lines) appends at EOF unless an @@ context anchors it.
    const index =
      oldLines.length === 0 && (hunk.endOfFile || !hunk.changeContext)
        ? lines.length
        : findSequence(lines, oldLines, cursor, hunk.endOfFile);
    if (index < 0) {
      const preview = oldLines.slice(0, 3).join('\n');
      throw patchError(`could not find hunk context in ${path}:\n${preview}`);
    }
    lines.splice(index, oldLines.length, ...newLines);
    cursor = index + newLines.length;
  }
  // keep the original's final-newline state
  const normalized = lines.length ? `${lines.join('\n')}${file.finalNewline ? '\n' : ''}` : '';
  return file.eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function replaceFile(temporary, destination, destinationExists, platform = process.platform) {
  if (platform !== 'win32' || !destinationExists) {
    await rename(temporary, destination);
    return;
  }
  const backup = `${temporary}.original`;
  await rename(destination, backup);
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rename(backup, destination);
    throw error;
  }
  await rm(backup, { force: true });
}

async function readOptionalTextFile(absolute, displayPath) {
  if (!(await fileExists(absolute))) return null;
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw patchError(`path is not a regular file: ${displayPath}`);
  const bytes = await readFile(absolute);
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw patchError(`file is not valid UTF-8 text: ${displayPath}`);
  }
  if (content.includes('\0')) throw patchError(`file appears to be binary: ${displayPath}`);
  return { content, mode: metadata.mode };
}

async function writeTextFile(destination, content, mode) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.devspace-patch-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, mode === undefined ? undefined : { mode });
    await replaceFile(temporary, destination, await fileExists(destination));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function filePatch(oldPath, newPath, oldContent, newContent) {
  const { text } = unifiedDiff(oldContent ?? '', newContent ?? '', {
    oldName: oldContent === null ? '/dev/null' : `a/${oldPath}`,
    newName: newContent === null ? '/dev/null' : `b/${newPath}`,
  });
  const head = [`diff --git a/${oldPath} b/${newPath}`];
  if (oldContent === null) head.push('new file mode 100644');
  if (newContent === null) head.push('deleted file mode 100644');
  return [...head, text].filter(Boolean).join('\n');
}

/**
 * Apply `patch`. `resolvePath(p)` must return a policy-checked absolute path (or throw).
 * All files are staged first; nothing is written unless every action applies.
 * Returns { files: [{ path, previousPath?, operation }], patch, additions, removals }.
 */
export async function applyPatch(patch, { resolvePath }) {
  const actions = parsePatch(patch);
  const results = [];
  const patches = [];
  // Staged final state per file, keyed by real path (case-insensitive on Windows) so that
  // "Delete readme.md" + "Add README.md" or a case-only move collapse onto the same file.
  // entry = { path: where to write/remove, file: { content, mode } | null (deleted) }
  const staged = new Map();

  const keyOf = async (absolute) => cmpKey(await realpathNearest(absolute));
  const stage = async (absolute, displayPath) => {
    const key = await keyOf(absolute);
    if (!staged.has(key)) {
      const file = await readOptionalTextFile(absolute, displayPath);
      // an existing file is written back under its on-disk name (keeps its case / symlink)
      const path = file ? await realpath(absolute).catch(() => absolute) : absolute;
      staged.set(key, { path, file });
    }
    return { key, entry: staged.get(key) };
  };

  for (const action of actions) {
    const absolute = await resolvePath(action.path);
    const { key, entry } = await stage(absolute, action.path);
    const original = entry.file;
    if (action.kind === 'add') {
      staged.set(key, { path: absolute, file: { content: action.content, mode: original?.mode } });
      patches.push(filePatch(action.path, action.path, original?.content ?? null, action.content));
      results.push({ path: action.path, operation: original ? 'update' : 'add' });
      continue;
    }
    if (!original) throw patchError(`file does not exist: ${action.path}`);
    if (action.kind === 'delete') {
      staged.set(key, { path: entry.path, file: null });
      patches.push(filePatch(action.path, action.path, original.content, null));
      results.push({ path: action.path, operation: 'delete' });
      continue;
    }
    const updated = applyHunks(action.path, original.content, action.hunks);
    const next = { content: updated, mode: original.mode };
    if (action.moveTo) {
      const destination = await resolvePath(action.moveTo);
      const destKey = await keyOf(destination);
      if (destKey === key) {
        // same file (e.g. case-only rename): write under the new name
        staged.set(key, { path: destination, file: next });
      } else {
        await stage(destination, action.moveTo);
        staged.set(destKey, { path: destination, file: next });
        staged.set(key, { path: entry.path, file: null });
      }
      patches.push(filePatch(action.path, action.moveTo, original.content, updated));
      results.push({ path: action.moveTo, previousPath: action.path, operation: 'move' });
    } else {
      staged.set(key, { path: entry.path, file: next });
      patches.push(filePatch(action.path, action.path, original.content, updated));
      results.push({ path: action.path, operation: 'update' });
    }
  }

  for (const { path, file } of staged.values()) if (file) await writeTextFile(path, file.content, file.mode);
  for (const { path, file } of staged.values()) if (!file) await rm(path, { force: true });

  const unified = patches.filter(Boolean).join('\n');
  let additions = 0;
  let removals = 0;
  for (const line of unified.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) removals++;
  }
  return { files: results, patch: unified, additions, removals };
}
