/* GemInWeb — options page. */
'use strict';
(function () {
  const KEY = globalThis.DSG_SETTINGS_KEY || 'dsg.settings';
  const merge = globalThis.DSG_mergeSettings;
  const $ = (id) => document.getElementById(id);

  function load() {
    return new Promise((resolve) => chrome.storage.local.get(KEY, (o) => resolve(merge(o && o[KEY]))));
  }
  function save(s) {
    return new Promise((resolve) => chrome.storage.local.set({ [KEY]: s }, () => resolve(s)));
  }

  function fill(s) {
    $('transport').value = s.transport;
    $('httpUrl').value = s.httpUrl;
    $('httpToken').value = s.httpToken;
    $('approval').value = s.approval;
    $('maxSteps').value = s.maxSteps;
    $('maxCallsPerTurn').value = s.maxCallsPerTurn;
    $('mmcGemini').value = s.maxMessageChars.gemini;
    $('mmcAistudio').value = s.maxMessageChars.aistudio;
    $('primerMode').value = s.primerMode;
    $('autoSend').checked = !!s.autoSend;
    syncHttp();
  }

  function int(id, min, max, dflt) {
    const n = parseInt($(id).value, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  function read() {
    const d = globalThis.DSG_DEFAULT_SETTINGS;
    return merge({
      transport: $('transport').value === 'http' ? 'http' : 'native',
      httpUrl: ($('httpUrl').value || d.httpUrl).trim().replace(/\/+$/, ''),
      httpToken: $('httpToken').value.trim(),
      approval: $('approval').value,
      maxSteps: int('maxSteps', 1, 500, d.maxSteps),
      maxCallsPerTurn: int('maxCallsPerTurn', 1, 50, d.maxCallsPerTurn),
      maxMessageChars: {
        gemini: int('mmcGemini', 2000, 1000000, d.maxMessageChars.gemini),
        aistudio: int('mmcAistudio', 2000, 1000000, d.maxMessageChars.aistudio),
      },
      primerMode: $('primerMode').value === 'context' ? 'context' : 'full',
      autoSend: $('autoSend').checked,
    });
  }

  function syncHttp() {
    $('httpBox').classList.toggle('hidden', $('transport').value !== 'http');
  }

  function flash(el, text, cls) {
    el.textContent = text;
    el.className = cls || '';
  }

  function rpc(request) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'dsg.rpc', request }, (resp) => {
        const le = chrome.runtime.lastError;
        if (le) resolve({ ok: false, error: le.message });
        else resolve(resp || { ok: false, error: '응답 없음' });
      });
    });
  }

  async function testConnection() {
    await save(read());
    flash($('testMsg'), '확인 중…');
    $('testOut').hidden = true;
    const t0 = performance.now();
    const r = await rpc({ id: 'opt' + Date.now(), type: 'status' });
    const ms = Math.round(performance.now() - t0);
    if (r.ok) {
      const s = r.result || {};
      flash($('testMsg'), `연결됨 — v${s.version || '?'} (${ms} ms)`, 'ok');
      const lines = [
        `platform:          ${s.platform || ''}`,
        `config:            ${s.configPath || ''}`,
        `allowedRoots:      ${(s.allowedRoots || []).join('; ')}`,
        `defaultWorkspace:  ${s.defaultWorkspace || ''}`,
        `shell:             ${s.shell ? s.shell.kind + ' — ' + (s.shell.path || '') : ''}`,
      ];
      $('testOut').textContent = lines.join('\n');
      $('testOut').hidden = false;
    } else {
      flash($('testMsg'), r.error || '실패', 'err');
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('extid').textContent = chrome.runtime.id;
    fill(await load());
    $('transport').addEventListener('change', syncHttp);
    $('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      fill(await save(read()));
      flash($('msg'), '저장했습니다', 'ok');
      setTimeout(() => flash($('msg'), ''), 2500);
    });
    $('reset').addEventListener('click', async () => {
      fill(merge(null));
      flash($('msg'), '기본값을 채웠습니다 — 저장을 누르세요');
    });
    $('test').addEventListener('click', testConnection);
  });
})();
