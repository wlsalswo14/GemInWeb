/* Diagnostic: sample Gemini's "generating"/"complete" selector matches every second.
 *   node test/e2e/watch-gemini-signals.mjs [seconds=120] [port=9333]
 * Prints a line whenever the set of matching stopButton / generatingIndicator / turnComplete
 * selectors (with visibility) changes, so a stuck signal is easy to spot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBrowser, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const secs = Number(process.argv[2] || 120);
const port = Number(process.argv[3] || 9333);
const selSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'selectors.js'), 'utf8');
const b = await connectBrowser(port);
const t = (await b.targets()).find((x) => x.type === 'page' && x.url.includes('gemini.google.com'));
const p = await b.attach(t.targetId);
const probe = `(() => {
  const g = {}; (function (__g) { ${selSrc.replace(/var g = globalThis;/, 'var g = __g;')} })(g);
  const S = g.DSG.SELECTORS.gemini;
  const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const out = [];
  for (const k of ['stopButton', 'generatingIndicator']) {
    for (const s of S[k]) { const els = Array.from(document.querySelectorAll(s)); if (els.length) out.push(k + ' ' + s + ' n=' + els.length + ' vis=' + els.filter(vis).length); }
  }
  const last = Array.from(document.querySelectorAll('model-response')).pop();
  if (last) for (const s of S.turnComplete) if (last.matches(s) || last.querySelector(s)) out.push('turnComplete ' + s);
  out.push('turns=' + document.querySelectorAll('user-query, model-response').length);
  return out.join('\\n');
})()`;
let prev = '';
const t0 = Date.now();
while ((Date.now() - t0) / 1000 < secs) {
  const cur = await p.eval(probe).catch((e) => 'ERR ' + e.message);
  if (cur !== prev) {
    console.log(`--- ${((Date.now() - t0) / 1000).toFixed(0)}s\n${cur}`);
    prev = cur;
  }
  await sleep(1000);
}
b.disconnect();
