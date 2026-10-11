// Loads extension classic scripts into a fresh vm context (shared globalThis.DSG).
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

export function loadScripts(files, extraGlobals = {}) {
  const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, ...extraGlobals };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of files) {
    const p = join(EXT, f);
    vm.runInContext(readFileSync(p, 'utf8'), ctx, { filename: p });
  }
  return ctx;
}

/** JSON round-trip: values created inside the vm have foreign prototypes (deepStrictEqual cares). */
export const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
