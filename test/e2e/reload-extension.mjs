/* Reload the unpacked GemInWeb extension in a running test browser, then reload matching tabs.
 *   node test/e2e/reload-extension.mjs [port=9333] [urlSubstring=google.com]
 * Uses chrome://extensions (developerPrivate): turns developer mode on first, because reloading an
 * unpacked extension with developer mode off disables it ("unsupportedDeveloperExtension").
 */
import { connectBrowser, sleep } from './cdp.mjs';

const EXT = 'ekplpihmkdcielcfideebgocdkajifcc';
const port = Number(process.argv[2] || 9333);
const match = process.argv[3] || 'google.com';
const b = await connectBrowser(port);
const { targetId } = await b.send('Target.createTarget', { url: 'chrome://extensions/' });
await sleep(1500);
const s = await b.attach(targetId);
const cb = (call) => `new Promise((res) => ${call.replace('CB', '() => res(chrome.runtime.lastError ? chrome.runtime.lastError.message : "ok")')})`;
console.log('dev mode', await s.eval(cb(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, CB)`)));
console.log('enable', await s.eval(cb(`chrome.management.setEnabled('${EXT}', true, CB)`)));
console.log('reload', await s.eval(cb(`chrome.developerPrivate.reload('${EXT}', { failQuietly: true, populateErrorForUnpacked: false }, CB)`)));
await sleep(1500);
const state = await s.eval(
  `new Promise((res) => chrome.developerPrivate.getExtensionInfo('${EXT}', (i) => res(i.state + ' ' + JSON.stringify(Object.entries(i.disableReasons || {}).filter(([, v]) => v).map(([k]) => k)))))`
);
console.log('state', state);
await s.send('Page.close').catch(() => {});
for (const t of await b.targets()) {
  if (t.type === 'page' && t.url.includes(match)) {
    const p = await b.attach(t.targetId);
    await p.send('Page.reload', {});
    console.log('reloaded tab', t.url);
  }
}
b.disconnect();
