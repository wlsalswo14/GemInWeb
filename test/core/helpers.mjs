// Test helpers: every test uses a throwaway data dir via DEVSPACE_GEM_HOME (never the real one).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../../core/engine.mjs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const IS_WIN = process.platform === 'win32';

/** Make a temp sandbox { root, home, ws } and point DEVSPACE_GEM_HOME at it. */
export function sandbox(prefix = 'dsg-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home');
  const ws = join(root, 'ws');
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  process.env.DEVSPACE_GEM_HOME = home;
  return {
    root,
    home,
    ws,
    write(rel, content) {
      const p = join(ws, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows may hold handles briefly
      }
    },
  };
}

/** Engine confined to the sandbox workspace. */
export function sandboxEngine(sb, config = {}) {
  return createEngine({ home: sb.home, config: { allowedRoots: [sb.ws], defaultWorkspace: sb.ws, ...config } });
}

let seq = 0;
/** Call a tool and return the `call` result (asserting the envelope is ok). */
export async function call(engine, tool, args = {}, workspace) {
  const res = await engine.handle({ id: `t${++seq}`, type: 'call', tool, args, workspace });
  if (!res.ok) throw new Error(`envelope error: ${res.error}`);
  return res.result;
}
