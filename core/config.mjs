// Data dir + config.json handling.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expandHome } from './paths.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  allowedRoots: ['~'],
  defaultWorkspace: '~',
  shell: 'auto',
  bashPath: null,
  commandTimeoutSec: 120,
  maxCommandTimeoutSec: 1800,
  maxOutputChars: 30000,
  readMaxLines: 2000,
  http: { port: 7679 },
  blockedCommands: [],
  // No read or write (file tools, listings/search, run_shell cwd). $DATA_DIR = this data dir.
  protectedPaths: Object.freeze([
    '$DATA_DIR',
    '~/.ssh',
    '~/.gnupg',
    '~/.aws',
    '~/.azure',
    '~/.config/gcloud',
    '~/.kube',
    '~/.docker',
    '~/.netrc',
    '~/.git-credentials',
    '~/.npmrc',
    '~/AppData/Local/Google/Chrome/User Data',
    '~/AppData/Local/Microsoft/Edge/User Data',
    '~/AppData/Local/BraveSoftware/Brave-Browser/User Data',
    '~/AppData/Roaming/Mozilla/Firefox',
    '~/AppData/Roaming/Microsoft/Credentials',
    '~/AppData/Local/Microsoft/Credentials',
    '~/AppData/Roaming/Microsoft/Protect',
  ]),
  // No write via file tools. $INSTALL_DIR = the GemInWeb checkout.
  writeProtectedPaths: Object.freeze([
    '$INSTALL_DIR',
    '~/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup',
    '~/.gitconfig',
    '~/.config/git',
  ]),
});

/** Keys added after the first release: merged into an existing config.json when missing. */
const MERGE_KEYS = ['protectedPaths', 'writeProtectedPaths'];

/** `%USERPROFILE%\.devspace-gem` unless `DEVSPACE_GEM_HOME` is set. */
export function resolveDataDir(env = process.env) {
  const override = env.DEVSPACE_GEM_HOME;
  return override && override.trim() ? resolve(expandHome(override.trim())) : join(homedir(), '.devspace-gem');
}

export function ensureDataDir(home) {
  mkdirSync(join(home, 'logs'), { recursive: true });
  return home;
}

/** Strip `//` and block comments plus trailing commas, respecting strings. */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  cfg.http = { ...DEFAULT_CONFIG.http, ...(raw?.http && typeof raw.http === 'object' ? raw.http : {}) };
  const roots = Array.isArray(cfg.allowedRoots) ? cfg.allowedRoots : [cfg.allowedRoots];
  cfg.allowedRoots = roots.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
  if (typeof cfg.defaultWorkspace !== 'string' || !cfg.defaultWorkspace.trim()) cfg.defaultWorkspace = '~';
  if (!['auto', 'bash', 'powershell'].includes(cfg.shell)) cfg.shell = 'auto';
  if (typeof cfg.bashPath !== 'string' || !cfg.bashPath.trim()) cfg.bashPath = null;
  for (const [key, min] of [['commandTimeoutSec', 1], ['maxCommandTimeoutSec', 1], ['maxOutputChars', 1000], ['readMaxLines', 1]]) {
    const n = Number(cfg[key]);
    cfg[key] = Number.isFinite(n) && n >= min ? Math.trunc(n) : DEFAULT_CONFIG[key];
  }
  cfg.http.port = Number.isInteger(Number(cfg.http.port)) ? Number(cfg.http.port) : DEFAULT_CONFIG.http.port;
  cfg.blockedCommands = Array.isArray(cfg.blockedCommands) ? cfg.blockedCommands.filter((s) => typeof s === 'string') : [];
  for (const key of MERGE_KEYS) {
    cfg[key] = Array.isArray(cfg[key]) ? cfg[key].filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [...DEFAULT_CONFIG[key]];
  }
  return cfg;
}

/**
 * Load `<home>/config.json`, creating it with defaults when missing.
 * Returns `{ config, path, created, error }`; an unreadable file falls back to defaults
 * (never overwritten) and reports `error`.
 */
export function loadConfig(home, { create = true, overrides } = {}) {
  const path = join(home, 'config.json');
  let raw = null;
  let created = false;
  let error = null;
  if (existsSync(path)) {
    try {
      const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
      let strict = true;
      try {
        raw = JSON.parse(text);
      } catch {
        strict = false;
        raw = JSON.parse(stripJsonComments(text));
      }
      // Merge newly introduced keys (with defaults) into the file, keeping every user value.
      // Files with comments are left untouched (the defaults still apply in memory).
      const missing = raw && typeof raw === 'object' && !Array.isArray(raw) ? MERGE_KEYS.filter((k) => !(k in raw)) : [];
      if (strict && missing.length) {
        for (const k of missing) raw[k] = [...DEFAULT_CONFIG[k]];
        try {
          writeFileSync(path, `${JSON.stringify(raw, null, 2)}
`, 'utf8');
        } catch {
          // read-only config: defaults still apply in memory
        }
      }
    } catch (err) {
      error = `config.json is invalid (${err.message}); using defaults`;
    }
  } else if (create) {
    ensureDataDir(home);
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    created = true;
  }
  const merged = overrides ? { ...(raw ?? {}), ...overrides, http: { ...(raw?.http ?? {}), ...(overrides.http ?? {}) } } : raw;
  return { config: normalizeConfig(merged), path, created, error };
}

/** Cached loader that re-reads config.json when its mtime changes. */
export function createConfigStore(home, overrides) {
  let cache = null;
  let mtime = -1;
  return {
    path: join(home, 'config.json'),
    get() {
      let m = -2;
      try {
        m = statSync(join(home, 'config.json')).mtimeMs;
      } catch {
        // missing → loadConfig recreates it
      }
      if (!cache || m !== mtime) {
        cache = loadConfig(home, { overrides });
        try {
          mtime = statSync(join(home, 'config.json')).mtimeMs;
        } catch {
          mtime = -2;
        }
      }
      return cache;
    },
  };
}
