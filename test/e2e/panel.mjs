/* Drive the GemInWeb panel over CDP.
 * The panel lives in a CLOSED shadow root and ignores synthetic (untrusted) events, so:
 * - reads/value writes run in the extension's isolated world (DSG._panel.shadow),
 * - clicks are real input events (Input.dispatchMouseEvent at the element's centre),
 * - the approval mode is set through DSG.settings (chrome.storage), like the options page.
 */
import { sleep, trackContexts } from './cdp.mjs';

const EXT_ID = 'ekplpihmkdcielcfideebgocdkajifcc';
const R = `DSG._panel.shadow`;
const findBtn = (text, scope = R) =>
  `Array.from(${scope}.querySelectorAll('button')).find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}) && b.getClientRects().length)`;

export async function panel(page) {
  const ctx = await trackContexts(page);
  const iso = () => ctx.isolated(EXT_ID);
  async function ev(js) {
    const id = iso();
    if (!id) throw new Error('extension isolated world not found');
    return page.eval(js, { contextId: id });
  }
  async function clickAt(expr) {
    const r = await ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, disabled: !!el.disabled }; })()`);
    if (!r) return false;
    if (r.disabled) {
      // A real click on a disabled button: the browser swallows it (no events) — that's the point.
      await page.send('Page.bringToFront').catch(() => {});
      for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
      return false;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      // Input only reaches the foreground tab (a fresh profile opens the options page on install).
      await page.send('Page.bringToFront').catch(() => {});
      // Count trusted clicks that really land on the target element.
      await ev(`(() => { const el = ${expr}; window.__dsgE2eHit = 0; el.addEventListener('click', (e) => { if (e.isTrusted) window.__dsgE2eHit++; }, { once: true, capture: true }); return true; })()`);
      const b = await ev(`(() => { const el = ${expr}; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await page.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      }
      if (await ev('window.__dsgE2eHit > 0')) return true;
      if (process.env.DSG_E2E_DEBUG) {
        const hit = await ev(`(() => { const h = document.elementFromPoint(${b.x}, ${b.y}); const s = DSG._panel.shadow.elementFromPoint(${b.x}, ${b.y}); return (h ? h.tagName + '#' + h.id + '.' + h.className : 'none') + ' | shadow: ' + (s ? s.tagName + ' ' + s.textContent.slice(0, 20) : 'none'); })()`);
        console.log('[panel] click did not reach the element, retrying', JSON.stringify(b), hit);
      }
      await sleep(500);
    }
    throw new Error('mouse click was not delivered to the page');
  }
  const api = {
    ev,
    async waitPresent(ms = 15000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try {
          if (await ev(`!!(globalThis.DSG && DSG._panel && ${R}.querySelector('.status'))`)) return true;
        } catch (_) {
          /* context not there yet */
        }
        await sleep(250);
      }
      throw new Error('panel not injected');
    },
    expand: () => ev(`(() => { const p = ${R}.querySelector('.pill'); if (p && !p.classList.contains('hidden')) p.classList.add('hidden'), ${R}.querySelector('.panel').classList.remove('hidden'); return true; })()`),
    click: (text) => clickAt(findBtn(text)),
    /** Synthetic click from script (must be ignored by the panel). */
    syntheticClick: (text) => ev(`(() => { const b = ${findBtn(text)}; if (!b) return false; b.click(); return true; })()`),
    status: () => ev(`${R}.querySelector('.status')?.textContent || ''`),
    connection: () => ev(`(${R}.querySelector('.dot')?.className || '')`),
    switchOn: () => ev(`!!${R}.querySelector('button.switch')?.classList.contains('on')`),
    workspaceText: () => ev(`Array.from(${R}.querySelectorAll('.row')).find(r => r.textContent.includes('작업 폴더'))?.querySelector('.mono')?.textContent || ''`),
    async setWorkspace(path) {
      await clickAt(findBtn('변경'));
      await sleep(200);
      await ev(`(() => { const i = ${R}.querySelector('input[type=text]'); i.value = ${JSON.stringify(path)}; return true; })()`);
      await clickAt(findBtn('확인'));
      await sleep(1500);
      return api.workspaceText();
    },
    setApproval: (mode) => ev(`DSG.settings.save({ approval: ${JSON.stringify(mode)} }).then(s => s.approval)`),
    setTask: (text) => ev(`(() => { ${R}.querySelector('textarea').value = ${JSON.stringify(text)}; return true; })()`),
    log: () =>
      ev(`Array.from(${R}.querySelectorAll('.entry')).reverse().map(e => ({ sum: e.querySelector('.sum')?.textContent, st: e.querySelector('.st')?.textContent, out: e.querySelector('pre')?.textContent }))`),
    notices: () => ev(`Array.from(${R}.querySelectorAll('.notice')).filter(n => !n.classList.contains('hidden')).map(n => n.textContent)`),
    approvals: () => ev(`Array.from(${R}.querySelectorAll('.card')).map(c => c.textContent)`),
    approvalButtonDisabled: (which) => ev(`(() => { const c = ${R}.querySelector('.card'); const b = c && ${findBtn(which, 'c')}; return b ? b.disabled : null; })()`),
    approve: (which = '승인') => clickAt(`(() => { const c = ${R}.querySelector('.card'); return c && ${findBtn(which, 'c')}; })()`),
    text: () => ev(`${R}.querySelector('.panel')?.innerText || ''`),
  };
  return api;
}
