/* GemInWeb — default settings shared by background.js and the options page.
 * content/rpc.js keeps an identical copy (content-script order is fixed by the spec);
 * test/extension/settings.test.mjs asserts they match. */
(function (g) {
  'use strict';
  g.DSG_DEFAULT_SETTINGS = {
    transport: 'native',
    httpUrl: 'http://127.0.0.1:7679',
    httpToken: '',
    approval: 'ask_shell',
    maxSteps: 25,
    maxCallsPerTurn: 6,
    maxMessageChars: { gemini: 24000, aistudio: 80000 },
    primerMode: 'full',
    autoSend: true,
  };
  g.DSG_SETTINGS_KEY = 'dsg.settings';
  g.DSG_mergeSettings = function (stored) {
    const d = g.DSG_DEFAULT_SETTINGS;
    const s = Object.assign({}, d, stored || {});
    s.maxMessageChars = Object.assign({}, d.maxMessageChars, (stored && stored.maxMessageChars) || {});
    return s;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
