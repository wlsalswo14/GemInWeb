/* Live Gemini E2E (logged out) — drives the real GemInWeb panel on gemini.google.com.
 *
 * Prereqs: native host installed (install\install.ps1). Uses a throwaway profile under
 * test/.tmp/ and Playwright's Chromium (never the user's Chrome profile, never signs in).
 *
 *   node test/e2e/run-gemini-live.mjs --launch                 # start browser (port 9333), open gemini, leave running
 *   node test/e2e/run-gemini-live.mjs "<task>" [--new] [--max 240] [--approval auto]
 *   node test/e2e/run-gemini-live.mjs --reload                 # reload the tab and verify nothing re-executes
 *   node test/e2e/run-gemini-live.mjs --close                  # close the test browser
 *
 * Workspace is always %LOCALAPPDATA%\Temp\devspace-gem-e2e\ws-gemini (scratch, outside the write-protected repo); the script aborts if the panel shows anything else.
 * Screenshots → test/.tmp/gemini-*.png, panel log → stdout + test/.tmp/gemini-log-*.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBrowser, launchChrome, sleep, PLAYWRIGHT_CHROMIUM } from './cdp.mjs';
import { panel } from './panel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(ROOT, 'test', '.tmp');
// Scratch workspace OUTSIDE the repo: core write-protects the GemInWeb checkout ($INSTALL_DIR).
const WS = process.env.DSG_E2E_WS || path.join(process.env.LOCALAPPDATA || TMP, 'Temp', 'devspace-gem-e2e', 'ws-gemini');
const PORT = Number(process.env.DSG_E2E_PORT || 9333);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const task = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && ['--max', '--approval'].includes(argv[i - 1])));

fs.mkdirSync(WS, { recursive: true });

if (flag('--launch')) {
  const c = await launchChrome({ exe: process.env.DSG_CHROME || PLAYWRIGHT_CHROMIUM, userDataDir: path.join(TMP, 'prof-gemini'), port: PORT, extensionDir: path.join(ROOT, 'extension'), detached: true });
  c.child.unref();
  const b = await connectBrowser(PORT);
  await b.send('Target.createTarget', { url: 'https://gemini.google.com/app' });
  console.log('launched pid', c.child.pid, 'port', PORT);
  b.disconnect();
  process.exit(0);
}

const b = await connectBrowser(PORT);
if (flag('--close')) {
  await b.send('Browser.close').catch(() => {});
  process.exit(0);
}
let t = (await b.targets()).find((x) => x.type === 'page' && x.url.includes('gemini.google.com'));
if (!t) {
  const { targetId } = await b.send('Target.createTarget', { url: 'https://gemini.google.com/app' });
  t = { targetId };
  await sleep(6000);
}
const p = await b.attach(t.targetId);
await p.send('Page.enable');
const P = await panel(p);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const turns = () =>
  p.eval(`Array.from(document.querySelectorAll('user-query, model-response')).map(e => (e.tagName === 'USER-QUERY' ? 'U: ' : 'M: ') + e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400))`);

if (flag('--new')) {
  await p.send('Page.navigate', { url: 'https://gemini.google.com/app' });
  await sleep(6000);
}
if (flag('--reload')) {
  const before = await hostCalls();
  await p.send('Page.reload', {});
  await sleep(4000);
  await P.waitPresent();
  await sleep(15000);
  const after = await hostCalls();
  console.log('status after reload:', await P.status(), '| switch on:', await P.switchOn());
  console.log('panel log after reload:', JSON.stringify(await P.log()));
  console.log('host calls before/after reload:', before, after, after === before ? 'OK (nothing re-executed)' : 'FAIL');
  await p.screenshot(path.join(TMP, `gemini-reload-${stamp()}.png`));
  b.disconnect();
  process.exit(0);
}

async function hostCalls() {
  const f = path.join(process.env.USERPROFILE || '', '.devspace-gem', 'logs', 'host.log');
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter((l) => / INFO call /.test(l)).length;
  } catch (_) {
    return -1;
  }
}

await P.waitPresent();
await P.expand();
if (!(await P.workspaceText()).toLowerCase().includes(WS.toLowerCase())) {
  console.log('workspace ->', await P.setWorkspace(WS));
}
const wsNow = await P.workspaceText();
if (!wsNow.toLowerCase().includes(WS.toLowerCase())) {
  console.error('ABORT: workspace is not the scratch folder:', wsNow, (await P.notices()).join(' | '));
  process.exit(2);
}
console.log('approval ->', await P.setApproval(opt('--approval', 'auto')));
const callsBefore = await hostCalls();
if (task) {
  await P.setTask(task);
  console.log('start ->', await P.click('작업 시작'));
}
const maxSec = Number(opt('--max', 240));
let last = '';
const t0 = Date.now();
let idleSince = 0;
let active = !task; // with a task: only accept "done" after this run was seen working
while ((Date.now() - t0) / 1000 < maxSec) {
  await sleep(2000);
  const st = await P.status();
  if (/응답 대기|전송 중|실행 중|승인 대기/.test(st)) active = true;
  const log = await P.log();
  const line = st + ' || ' + log.map((l) => `${l.sum} [${l.st}]`).join(' ; ');
  if (line !== last) {
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`);
    last = line;
  }
  if (await P.approvals().then((a) => a.length)) {
    console.log('approval card:', (await P.approvals())[0].slice(0, 200));
    if (opt('--approval', 'auto') !== 'manual-wait') await P.approve('승인');
  }
  if (active && /도구 호출 없음|전송 실패|오류|일시 정지|한도/.test(st)) {
    if (!idleSince) idleSince = Date.now();
    if (Date.now() - idleSince > 6000) break;
  } else idleSince = 0;
}
const s = stamp();
const log = await P.log();
fs.writeFileSync(path.join(TMP, `gemini-log-${s}.json`), JSON.stringify({ url: await p.eval('location.href'), log, turns: await turns() }, null, 2));
console.log('URL', await p.eval('location.href'));
console.log('host calls during run:', (await hostCalls()) - callsBefore, '| panel log entries:', log.length);
console.log('TURNS\n' + (await turns()).join('\n'));
console.log('NOTICES', await P.notices());
await p.screenshot(path.join(TMP, `gemini-${s}.png`));
b.disconnect();
