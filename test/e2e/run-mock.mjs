/* AI Studio mock E2E — real extension + real native host, fake AI Studio page.
 *
 *   node test/e2e/run-mock.mjs [--keep] [--headless] [--port 9334] [--only basic,reload,sys,seeded,ctrlenter]
 *
 * What it does
 * - Launches Playwright's Chromium (or $DSG_CHROME) with a FRESH throwaway profile under
 *   test/.tmp/prof-mock and the unpacked extension/ folder. No Google sign-in, no real profile.
 * - Intercepts https://aistudio.google.com/* with CDP Fetch.fulfillRequest and serves
 *   test/fixtures/aistudio-chat.html + test/e2e/mock/aistudio-model.js (a scripted fake model),
 *   so the content scripts inject on the real URL. Nothing reaches the network.
 * - Drives the GemInWeb panel (workspace = %LOCALAPPDATA%\Temp\devspace-gem-e2e\ws-mock — outside the repo,
 *   which core write-protects; approval = auto) and asserts:
 *   basic     primer+task → write_file (header form) → batch read_file + run_shell (JSON, 2 blocks,
 *             one labelled "json") → edit_file (SEARCH/REPLACE) → final answer; thought/KaTeX/user
 *             decoys never run; every call runs exactly once; file content is right.
 *   reload    reloading the finished conversation executes nothing.
 *   sys       "시스템 지침에 넣기" fills the System instructions textarea; 작업 시작 then sends
 *             only the short [DevSpace context] block.
 *   seeded    opening an existing conversation whose last model turn holds a mutating call
 *             executes nothing; a new task in it still works.
 *   ctrlenter Run button never enables → extension falls back to Ctrl+Enter on the textarea.
 *   trusted   the page cannot see the (closed) panel, synthetic clicks on it are ignored, and
 *             forging the old sessionStorage flags (dsg.agentOn / dsg.autoApprove) arms nothing.
 *   carry     작업 시작 in a new chat that never gets an id, then SPA-navigating to an EXISTING
 *             conversation (history + generating flicker) executes nothing and types nothing.
 *   long      a 7,000+ char run_shell under ask_shell: 승인 stays disabled until the full command
 *             was expanded with a real click.
 * Requires the native host to be installed (install\install.ps1). Exit code 0 = all passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBrowser, launchChrome, sleep, PLAYWRIGHT_CHROMIUM } from './cdp.mjs';
import { panel } from './panel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(ROOT, 'test', '.tmp');
// Scratch workspace OUTSIDE the repo: core write-protects the GemInWeb checkout ($INSTALL_DIR).
const WS = process.env.DSG_E2E_WS || path.join(process.env.LOCALAPPDATA || TMP, 'Temp', 'devspace-gem-e2e', 'ws-mock');
const EXT_ID = 'ekplpihmkdcielcfideebgocdkajifcc';
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PORT = Number(opt('--port', 9334));
const ONLY = opt('--only', 'trusted,basic,reload,sys,seeded,ctrlenter,carry,long').split(',');
const HOST_LOG = path.join(process.env.DEVSPACE_GEM_HOME || path.join(process.env.USERPROFILE || '', '.devspace-gem'), 'logs', 'host.log');

const fixture = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'aistudio-chat.html'), 'utf8');
const model = fs.readFileSync(path.join(ROOT, 'test', 'e2e', 'mock', 'aistudio-model.js'), 'utf8');
const MOCK_HTML = fixture.replace('</body>', `<script>\n${model}\n</script>\n</body>`);

// ------------------------------------------------------------------ helpers
let failures = 0;
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  if (!cond) failures++;
  console.log(`${cond ? '  PASS' : '  FAIL'} ${name}${!cond && detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`);
}
function hostCalls() {
  try {
    return fs.readFileSync(HOST_LOG, 'utf8').split('\n').filter((l) => / INFO call /.test(l) && / id=t\d+:/.test(l)).length;
  } catch (_) {
    return -1;
  }
}
async function waitFor(fn, ms, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch (_) {
      v = null;
    }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const readWs = (f) => {
  try {
    return fs.readFileSync(path.join(WS, f), 'utf8');
  } catch (_) {
    return null;
  }
};

// ------------------------------------------------------------------ setup
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });
const profile = path.join(TMP, 'prof-mock');
fs.rmSync(profile, { recursive: true, force: true });
const extraArgs = argv.includes('--headless') ? ['--headless=new'] : [];
const chrome = await launchChrome({ exe: process.env.DSG_CHROME || PLAYWRIGHT_CHROMIUM, userDataDir: profile, port: PORT, extensionDir: path.join(ROOT, 'extension'), args: extraArgs });
const b = await connectBrowser(PORT);
let exitCode = 1;
try {
  const sw = await waitFor(async () => (await b.targets()).find((t) => t.url === `chrome-extension://${EXT_ID}/background.js`), 10000);
  check('extension loaded with pinned id ' + EXT_ID, !!sw);

  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const p = await b.attach(targetId);
  await p.send('Page.enable');
  await p.send('Fetch.enable', { patterns: [{ urlPattern: 'https://aistudio.google.com/*', requestStage: 'Request' }] });
  p.on('Fetch.requestPaused', async (e) => {
    const isDoc = e.resourceType === 'Document';
    await p
      .send('Fetch.fulfillRequest', {
        requestId: e.requestId,
        responseCode: isDoc ? 200 : 404,
        responseHeaders: [{ name: 'Content-Type', value: isDoc ? 'text/html; charset=utf-8' : 'text/plain' }],
        body: Buffer.from(isDoc ? MOCK_HTML : '').toString('base64'),
      })
      .catch(() => {});
  });
  const P = await panel(p);
  const mock = (expr) => p.eval(`window.__mock && (${expr})`);
  async function open(url) {
    await p.send('Page.navigate', { url });
    await P.waitPresent();
    await P.expand();
    await waitFor(async () => /ok/.test(await P.connection()), 10000);
  }
  async function useScratchWorkspace() {
    const w = await P.setWorkspace(WS);
    return w.toLowerCase().includes(WS.toLowerCase());
  }
  async function runTask(task, ms = 60000) {
    await P.setTask(task);
    await P.click('작업 시작');
    const done = await waitFor(async () => (await mock('__mock.done')) && /도구 호출 없음/.test(await P.status()), ms, 500);
    await sleep(2500); // let anything that would (wrongly) run, run
    return done;
  }
  const shot = (n) => p.screenshot(path.join(TMP, `mock-${n}.png`)).catch(() => {});

  // ---------------------------------------------------------------- trusted
  if (ONLY.includes('trusted')) {
    console.log('\n[trusted] closed panel, synthetic clicks, forged sessionStorage flags');
    await open('https://aistudio.google.com/prompts/new_chat?scenario=simple');
    check('agent starts OFF in a fresh tab', !(await P.switchOn()));
    check('page main world cannot reach the panel (closed shadow root)', (await p.eval(`document.getElementById('devspace-gem-panel').shadowRoot === null`)) === true);
    await p.eval(`sessionStorage.setItem('dsg.agentOn', '1'); sessionStorage.setItem('dsg.autoApprove', '1'); true`);
    await p.send('Page.reload', {});
    await P.waitPresent();
    await sleep(1500);
    check('forged sessionStorage flags do not arm the tab', !(await P.switchOn()));
    await P.setTask('synthetic task');
    await P.syntheticClick('작업 시작');
    await sleep(2500);
    check('synthetic click on 작업 시작 is ignored', (await mock('__mock.received.length')) === 0 && !(await P.switchOn()));
  }

  // ---------------------------------------------------------------- basic
  if (ONLY.includes('basic') || ONLY.includes('reload')) {
    console.log('\n[basic] new chat, full primer, 4 rounds');
    await open('https://aistudio.google.com/prompts/new_chat?scenario=basic');
    check('panel shows host connected', /ok/.test(await P.connection()), await P.connection());
    check('workspace set to scratch folder', await useScratchWorkspace(), await P.workspaceText());
    await P.setApproval('auto');
    const c0 = hostCalls();
    const done = await runTask('mock-hello.txt 파일을 만들고 읽은 다음 node 버전을 확인하고, 내용을 수정해 줘.');
    await shot('basic');
    const received = await mock('__mock.received');
    const errors = await mock('__mock.errors');
    const log = await P.log();
    check('loop finished (model answered without blocks)', done, await P.status());
    check('mock saw no unexpected message', errors && errors.length === 0, errors);
    check('4 messages sent (task + 3 results)', received && received.length === 4, received && received.map((r) => r.slice(0, 80)));
    check('first message = full primer + task', received && received[0].startsWith('[GemInWeb protocol v1]') && received[0].includes('mock-hello.txt 파일을'));
    check('textarea input path used Run button click', (await mock('__mock.clickSends')) === 4, await mock('__mock.clickSends'));
    check('exactly 4 host calls (write, read, run_shell, edit) — no double execution, no decoys', hostCalls() - c0 === 4, hostCalls() - c0);
    check('panel log has the 4 calls, all ok', log.filter((l) => l.sum !== null && !/open_workspace/.test(l.sum)).map((l) => /성공/.test(l.st)).join() === 'true,true,true,true', log);
    check('no decoy in panel log', !JSON.stringify(log).includes('DECOY'), log);
    check('mock-hello.txt = "안녕 AI Studio Mock\\n"', readWs('mock-hello.txt') === '안녕 AI Studio Mock\n', readWs('mock-hello.txt'));
    check('url got an id (new chat carried over)', /\/prompts\/mock[a-z0-9]+/.test(await p.eval('location.pathname')), await p.eval('location.pathname'));
    check('result message for batch has 1/2 + 2/2', received && /\[DevSpace result 1\/2\] read_file[\s\S]*\[DevSpace result 2\/2\] run_shell/.test(received[2]));

    if (ONLY.includes('reload')) {
      console.log('\n[reload] reload the finished conversation');
      const c1 = hostCalls();
      await p.send('Page.reload', {});
      await P.waitPresent();
      await sleep(8000);
      check('history re-rendered after reload', (await p.eval(`document.querySelectorAll('ms-chat-turn').length`)) === 8);
      check('agent still ON after reload', await P.switchOn());
      check('nothing executed after reload', hostCalls() === c1, hostCalls() - c1);
      check('nothing sent after reload', (await mock('__mock.received.length')) === 0);
      await shot('reload');
    }
  }

  // ---------------------------------------------------------------- system instructions
  if (ONLY.includes('sys')) {
    console.log('\n[sys] system instructions + context-only start');
    await open('https://aistudio.google.com/prompts/new_chat?scenario=sys');
    check('workspace set to scratch folder', await useScratchWorkspace());
    await P.setApproval('auto');
    await P.click('시스템 지침에 넣기');
    const si = await waitFor(() => mock(`__mock.systemInstructions.includes('[GemInWeb protocol v1]') && __mock.systemInstructions.length`), 6000);
    check('System instructions textarea filled with the full primer', !!si, await mock('__mock.systemInstructions.slice(0, 80)'));
    check('panel confirms system instructions', !!(await waitFor(async () => (await P.notices()).join(' ').includes('시스템 지침에 프로토콜을 넣었습니다'), 4000)), await P.notices());
    check('system instructions panel closed again', await waitFor(() => mock('!document.querySelector(".cdk-overlay-container")'), 3000), 'overlay still open');
    const c0 = hostCalls();
    const done = await runTask('폴더 목록을 보여줘');
    const received = await mock('__mock.received');
    check('loop finished', done, await P.status());
    check('task message is context-only (no full primer)', received && received[0] && received[0].startsWith('[DevSpace context]') && !received[0].includes('[GemInWeb protocol v1]'), received && received[0].slice(0, 120));
    check('1 host call', hostCalls() - c0 === 1, hostCalls() - c0);
    check('mock saw no unexpected message', (await mock('__mock.errors.length')) === 0, await mock('__mock.errors'));
    await shot('sys');
  }

  // ---------------------------------------------------------------- seeded history
  if (ONLY.includes('seeded')) {
    console.log('\n[seeded] open an existing conversation with a historic mutating call');
    const c0 = hostCalls();
    await open('https://aistudio.google.com/prompts/seeded_history_1');
    await sleep(8000);
    check('agent ON (tab armed) while opening history', await P.switchOn());
    check('historic call not executed', hostCalls() === c0 && readWs('HISTORIC_MUST_NOT_EXIST.txt') === null, hostCalls() - c0);
    check('nothing sent', (await mock('__mock.received.length')) === 0);
    check('workspace set to scratch folder', await useScratchWorkspace());
    const c1 = hostCalls();
    const done = await runTask('폴더 목록을 보여줘');
    check('new task in the old conversation runs', done && hostCalls() - c1 === 1, { done, calls: hostCalls() - c1, st: await P.status() });
    check('historic call still not executed', readWs('HISTORIC_MUST_NOT_EXIST.txt') === null);
    await shot('seeded');
  }

  // ---------------------------------------------------------------- ctrl+enter fallback
  if (ONLY.includes('ctrlenter')) {
    console.log('\n[ctrlenter] Run button disabled → Ctrl+Enter keyboard path');
    await open('https://aistudio.google.com/prompts/new_chat?scenario=simple&mock=ctrlenter');
    check('workspace set to scratch folder', await useScratchWorkspace());
    const c0 = hostCalls();
    const done = await runTask('폴더 목록을 보여줘', 90000);
    check('loop finished via Ctrl+Enter', done && (await mock('__mock.keyboardSends')) === 2, { done, kb: await mock('__mock.keyboardSends'), st: await P.status() });
    check('1 host call', hostCalls() - c0 === 1, hostCalls() - c0);
    await shot('ctrlenter');
  }

  // ---------------------------------------------------------------- carry-over guard
  if (ONLY.includes('carry')) {
    console.log('\n[carry] start in a new chat without id, then open an existing conversation (SPA)');
    await open('https://aistudio.google.com/prompts/new_chat?scenario=simple&autosave=off');
    check('workspace set to scratch folder', await useScratchWorkspace());
    await P.setApproval('auto');
    const c0 = hostCalls();
    await P.setTask('폴더 목록을 보여줘');
    await P.click('작업 시작');
    check('task sent', !!(await waitFor(() => mock('__mock.received.length === 1'), 10000)));
    await p.eval('__mock.spaOpenSeeded(); true');
    await sleep(9000);
    check('SPA-opened conversation is the seeded one', (await p.eval('location.pathname')) === '/prompts/seeded_spa');
    check('historic call of the other conversation not executed', hostCalls() === c0 && readWs('HISTORIC_MUST_NOT_EXIST.txt') === null, hostCalls() - c0);
    check('nothing typed or sent into the other conversation', (await mock('__mock.received.length')) === 0 && (await p.eval(`document.querySelector('ms-autosize-textarea textarea').value`)) === '');
    await shot('carry');
  }

  // ---------------------------------------------------------------- oversized command approval
  if (ONLY.includes('long')) {
    console.log('\n[long] oversized run_shell needs full view before approval');
    await open('https://aistudio.google.com/prompts/new_chat?scenario=long');
    check('workspace set to scratch folder', await useScratchWorkspace());
    await P.setApproval('ask_shell');
    const c0 = hostCalls();
    await P.setTask('긴 명령을 실행해 줘');
    await P.click('작업 시작');
    const card = await waitFor(async () => (await P.approvals()).length > 0, 20000);
    check('approval card shown', !!card);
    check('승인 disabled while the command is cut', (await P.approvalButtonDisabled('승인')) === true);
    await P.approve('승인'); // real click on a disabled button: nothing
    await sleep(1000);
    check('nothing ran yet', hostCalls() === c0);
    await shot('long-card');
    await P.approve('명령이 잘림');
    check('승인 enabled after expanding', (await P.approvalButtonDisabled('승인')) === false);
    await P.approve('승인');
    const done = await waitFor(async () => (await mock('__mock.done')) && /도구 호출 없음/.test(await P.status()), 30000, 500);
    check('long command ran once after approval', done && hostCalls() - c0 === 1, { done, calls: hostCalls() - c0 });
    await P.setApproval('auto');
  }

  fs.writeFileSync(path.join(TMP, 'mock-results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  exitCode = failures ? 1 : 0;
} catch (e) {
  console.error('E2E crashed:', e);
} finally {
  if (!argv.includes('--keep')) await chrome.close(b);
  else console.log('browser left running on port', PORT);
  b.disconnect();
}
process.exit(exitCode);
