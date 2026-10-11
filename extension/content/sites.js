/* GemInWeb — site adapters (AI Studio / Gemini).
 * Consumes ONLY DSG.SELECTORS[site] (ordered selector arrays, first match wins).
 * Every key is optional; missing keys degrade to conservative fallbacks. */
(function (g) {
  'use strict';
  const DSG = (g.DSG = g.DSG || {});

  const SITES = {
    'aistudio.google.com': 'aistudio',
    'gemini.google.com': 'gemini',
  };

  // Used only when DSG.SELECTORS lacks the key.
  const FALLBACK_CONV_RE = {
    aistudio: '/prompts/([A-Za-z0-9_-]{6,})',
    gemini: '/app/([0-9a-fA-F]{8,})',
  };
  const NEW_CHAT_IDS = new Set(['new_chat', 'new', 'new-chat']);

  function detectSite(loc) {
    loc = loc || g.location;
    if (!loc) return null;
    return SITES[String(loc.hostname || '').toLowerCase()] || null;
  }

  function toList(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v.filter((s) => typeof s === 'string' && s.trim());
    if (typeof v === 'string' && v.trim()) return [v];
    return [];
  }

  function createSiteAdapter(site, opts) {
    opts = opts || {};
    const win = opts.win || g;
    const doc = opts.doc || win.document;
    const selectorsFor = () => {
      const all = opts.selectors || DSG.SELECTORS || {};
      return all[site] || {};
    };
    const sel = (key) => toList(selectorsFor()[key]);
    const sleep = opts.sleep || ((ms) => new Promise((r) => win.setTimeout(r, ms)));
    const now = opts.now || (() => Date.now());

    // ------------------------------------------------------------ DOM helpers
    function safeQSA(root, s) {
      try {
        return Array.from(root.querySelectorAll(s));
      } catch (_) {
        return []; // invalid selector (e.g. :has() unsupported) → skip
      }
    }
    function safeMatches(el, s) {
      try {
        return !!(el && el.matches && el.matches(s));
      } catch (_) {
        return false;
      }
    }
    function safeQS(root, s) {
      try {
        return root.querySelector(s);
      } catch (_) {
        return null;
      }
    }

    function isVisible(el) {
      if (!el || el.isConnected === false) return false;
      try {
        if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
        const cs = win.getComputedStyle ? win.getComputedStyle(el) : null;
        if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) return false;
      } catch (_) {
        /* best effort */
      }
      return true;
    }

    /** All elements for the first selector of `key` that yields any (optionally visible) match. */
    function qAll(key, root, opt) {
      root = root || doc;
      for (const s of sel(key)) {
        let els = safeQSA(root, s);
        if (opt && opt.visible) els = els.filter(isVisible);
        if (els.length) return els;
      }
      return [];
    }
    /** First element: first selector wins; prefers visible elements when opt.visible. */
    function q(key, root, opt) {
      const els = qAll(key, root, opt);
      return els[0] || null;
    }
    /** First-matching-selector semantics: the first selector that matches anything decides, so
     * broad fallbacks are only consulted when the specific selectors match nothing at all. */
    function anyVisible(key, root) {
      root = root || doc;
      for (const s of sel(key)) {
        const els = safeQSA(root, s);
        if (els.length) return els.some(isVisible);
      }
      return false;
    }
    function elMatchesKey(el, key, deep) {
      for (const s of sel(key)) {
        if (safeMatches(el, s)) return true;
        if (deep && safeQS(el, s)) return true;
      }
      return false;
    }
    function isExcluded(el, stopAt) {
      const ex = sel('exclude');
      if (!ex.length) return false;
      for (let n = el; n && n !== stopAt; n = n.parentElement) {
        for (const s of ex) if (safeMatches(n, s)) return true;
      }
      return false;
    }

    // ------------------------------------------------------------ turns
    function turnKey(el, i) {
      if (!el || !el.getAttribute) return 'idx:' + i;
      const id = el.id || el.getAttribute('data-turn-id') || el.getAttribute('data-message-id') || el.getAttribute('data-id');
      if (id) return 'id:' + id;
      // Some frameworks put the id on the first child.
      const inner = el.querySelector && safeQS(el, '[id^="turn-"],[data-turn-id],[data-message-id]');
      if (inner) {
        const iid = inner.id || inner.getAttribute('data-turn-id') || inner.getAttribute('data-message-id');
        if (iid) return 'id:' + iid;
      }
      return 'idx:' + i;
    }

    function roleOf(el) {
      if (elMatchesKey(el, 'modelTurn', false)) return 'model';
      if (elMatchesKey(el, 'userTurn', false)) return 'user';
      if (elMatchesKey(el, 'modelTurn', true)) return 'model';
      if (elMatchesKey(el, 'userTurn', true)) return 'user';
      return null;
    }

    function getTurns() {
      let els = qAll('turn');
      if (!els.length) {
        // Degrade: union of model/user turn selectors in document order.
        const joined = [...sel('modelTurn'), ...sel('userTurn')];
        els = joined.length ? safeQSA(doc, joined.join(', ')) : []; // one query keeps document order
        if (!els.length) {
          // some selector was invalid: query one by one and sort into document order
          const set = new Set();
          for (const s of joined) for (const el of safeQSA(doc, s)) set.add(el);
          els = Array.from(set);
          if (els.length > 1 && els[0].compareDocumentPosition) {
            els.sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
          }
        }
        // drop elements nested in another collected element
        els = els.filter((el) => !els.some((o) => o !== el && o.contains && o.contains(el)));
      }
      const out = [];
      els.forEach((el, i) => {
        const role = roleOf(el);
        if (!role) return;
        out.push({ el, role, key: turnKey(el, i) });
      });
      return out;
    }

    function bodyOf(turnEl) {
      return q('turnBody', turnEl) || turnEl;
    }

    function cloneWithoutExcluded(root) {
      const clone = root.cloneNode(true);
      for (const s of sel('exclude')) for (const el of safeQSA(clone, s)) el.remove();
      return clone;
    }

    function turnText(turnEl) {
      if (!turnEl) return '';
      const body = bodyOf(turnEl);
      const c = sel('exclude').length ? cloneWithoutExcluded(body) : body;
      return String(c.textContent || '');
    }

    function langOf(codeEl, turnEl) {
      // class="language-xxx" on the code element or its pre
      const cls = (codeEl.className && String(codeEl.className)) || '';
      const m = /(?:^|\s)(?:language|lang)-([\w.+-]+)/.exec(cls);
      if (m) return m[1].toLowerCase();
      const attr = codeEl.getAttribute && (codeEl.getAttribute('data-language') || codeEl.getAttribute('data-lang'));
      if (attr) return attr.trim().toLowerCase();
      // Optional extra key: attribute on a wrapper carrying the fence language (AI Studio).
      const attrNames = sel('codeLanguageAttr');
      if (attrNames.length) {
        for (let n = codeEl; n && n !== turnEl; n = n.parentElement) {
          for (const a of attrNames) {
            const v = n.getAttribute && n.getAttribute(a);
            if (v) return v.trim().toLowerCase();
          }
        }
      }
      if (sel('codeLanguage').length) {
        let n = codeEl;
        for (let depth = 0; n && n !== turnEl && depth < 5; depth++, n = n.parentElement) {
          const lab = q('codeLanguage', n);
          if (lab && lab !== codeEl && !codeEl.contains(lab)) return String(lab.textContent || '').trim().toLowerCase();
        }
      }
      return '';
    }

    function getModelBlocks(turnEl) {
      if (!turnEl) return [];
      const body = bodyOf(turnEl);
      let els = qAll('codeBlock', body);
      if (!els.length && !sel('codeBlock').length) els = safeQSA(body, 'pre');
      els = els.filter((el) => !isExcluded(el, turnEl));
      // keep outermost only
      els = els.filter((el) => !els.some((o) => o !== el && o.contains && o.contains(el)));
      return els.map((el) => ({ text: String(el.textContent || ''), lang: langOf(el, turnEl) }));
    }

    function isGenerating() {
      return anyVisible('stopButton') || anyVisible('generatingIndicator');
    }

    function isTurnComplete(turnEl) {
      if (!sel('turnComplete').length) return true;
      if (!turnEl) return false;
      return elMatchesKey(turnEl, 'turnComplete', true);
    }

    // ------------------------------------------------------------ input
    function getInput() {
      return q('input', doc, { visible: true }) || q('input', doc);
    }
    function isTextarea(el) {
      return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
    }
    function editableOf(el) {
      if (!el) return null;
      if (isTextarea(el) || el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') === 'true')) return el;
      return safeQS(el, 'textarea') || safeQS(el, '[contenteditable="true"]') || el;
    }
    function readInput(el) {
      el = editableOf(el);
      if (!el) return '';
      if (isTextarea(el)) return String(el.value || '');
      return String(el.innerText != null ? el.innerText : el.textContent || '');
    }
    function getInputText() {
      return readInput(getInput());
    }
    const squash = (s) => String(s || '').replace(/\s+/g, '');
    function lengthOk(el, text) {
      const want = squash(text).length;
      const got = squash(readInput(el)).length;
      if (want === 0) return got === 0;
      return Math.abs(got - want) <= Math.max(2, want * 0.02);
    }
    function fire(el, type, init) {
      try {
        const Ev = type === 'input' && win.InputEvent ? win.InputEvent : win.Event;
        el.dispatchEvent(new Ev(type, Object.assign({ bubbles: true, cancelable: false }, init || {})));
      } catch (_) {
        /* ignore */
      }
    }
    function execInsert(text) {
      try {
        return !!doc.execCommand('insertText', false, text);
      } catch (_) {
        return false;
      }
    }

    async function setTextOn(target, text) {
      const el = editableOf(target);
      if (!el) return false;
      el.focus && el.focus();
      if (isTextarea(el)) {
        // Native value setter + bubbling input event (what Angular forms listen to) …
        try {
          const proto = el.tagName === 'INPUT' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        } catch (_) {
          el.value = text;
        }
        fire(el, 'input', { inputType: 'insertText', data: text });
        fire(el, 'change');
        if (el.value === text) return true;
        // … falling back to a real editing command.
        try {
          el.select();
        } catch (_) {
          /* ignore */
        }
        if (text === '') {
          try {
            doc.execCommand('delete', false);
          } catch (_) {
            /* ignore */
          }
        } else execInsert(text);
        return el.value === text;
      }
      // contenteditable / Quill
      const selectAll = () => {
        try {
          const range = doc.createRange();
          range.selectNodeContents(el);
          const s = win.getSelection();
          s.removeAllRanges();
          s.addRange(range);
        } catch (_) {
          try {
            doc.execCommand('selectAll', false);
          } catch (__) {
            /* ignore */
          }
        }
      };
      selectAll();
      if (text === '') {
        try {
          doc.execCommand('delete', false);
        } catch (_) {
          /* ignore */
        }
        return squash(readInput(el)).length === 0;
      }
      execInsert(text);
      await sleep(30);
      if (lengthOk(el, text)) return true;
      // Fallback 1: synthetic paste (Quill's clipboard module reads clipboardData)
      selectAll();
      try {
        doc.execCommand('delete', false);
      } catch (_) {
        /* ignore */
      }
      try {
        const dt = new win.DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      } catch (_) {
        /* ignore */
      }
      await sleep(60);
      if (lengthOk(el, text)) return true;
      // Fallback 2: write paragraphs directly
      try {
        while (el.firstChild) el.removeChild(el.firstChild);
        for (const line of String(text).split('\n')) {
          const p = doc.createElement('p');
          if (line) p.textContent = line;
          else p.appendChild(doc.createElement('br'));
          el.appendChild(p);
        }
        fire(el, 'input', { inputType: 'insertFromPaste' });
      } catch (_) {
        /* ignore */
      }
      await sleep(30);
      return lengthOk(el, text);
    }

    async function setInput(text) {
      const el = getInput();
      if (!el) return false;
      return setTextOn(el, String(text));
    }

    function isEnabled(btn) {
      if (!btn) return false;
      if (btn.disabled) return false;
      const ad = btn.getAttribute && btn.getAttribute('aria-disabled');
      if (ad === 'true') return false;
      return isVisible(btn);
    }

    async function send() {
      const deadline = now() + 5000;
      let btn = null;
      for (;;) {
        btn = qAll('sendButton', doc).find(isEnabled) || null;
        if (btn || now() >= deadline) break;
        await sleep(150);
      }
      if (btn) {
        try {
          btn.click();
          return true;
        } catch (_) {
          /* fall through */
        }
      }
      const el = editableOf(getInput());
      if (!el) return false;
      el.focus && el.focus();
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      if (site === 'aistudio') init.ctrlKey = true;
      try {
        el.dispatchEvent(new win.KeyboardEvent('keydown', init));
        el.dispatchEvent(new win.KeyboardEvent('keypress', init));
        el.dispatchEvent(new win.KeyboardEvent('keyup', init));
      } catch (_) {
        return false;
      }
      return true;
    }

    // ------------------------------------------------------------ conversation
    function conversationId() {
      const loc = win.location || {};
      let res = sel('conversationIdFromUrl');
      if (!res.length) res = [FALLBACK_CONV_RE[site]].filter(Boolean);
      for (const src of res) {
        let re;
        try {
          re = new RegExp(src);
        } catch (_) {
          continue;
        }
        for (const s of [loc.pathname || '', loc.href || '']) {
          const m = re.exec(s);
          if (m && m[1] && !NEW_CHAT_IDS.has(m[1].toLowerCase())) return m[1];
        }
      }
      return null;
    }
    function isNewChat() {
      return !conversationId();
    }
    function conversationKey() {
      const id = conversationId();
      if (id) return site + ':' + id;
      const loc = win.location || {};
      return site + ':' + (loc.pathname || '/');
    }

    // ------------------------------------------------------------ AI Studio system instructions
    async function setSystemInstructions(text) {
      if (site !== 'aistudio') return false;
      let input = q('systemInstructionsInput', doc, { visible: true });
      let opened = false;
      if (!input) {
        const opener = q('systemInstructionsOpen', doc, { visible: true });
        if (!opener) return false;
        try {
          opener.click();
          opened = true;
        } catch (_) {
          return false;
        }
        const deadline = now() + 3000;
        while (!input && now() < deadline) {
          await sleep(120);
          input = q('systemInstructionsInput', doc, { visible: true });
        }
      }
      if (!input) return false;
      const ok = await setTextOn(input, String(text));
      if (ok && opened) {
        // We opened the panel: close it again so it does not cover the chat.
        await sleep(300);
        const close = q('systemInstructionsClose', doc, { visible: true });
        try {
          if (close) close.click();
        } catch (_) {
          /* leave it open */
        }
      }
      return ok;
    }

    return {
      site,
      // Gemini silently drops input beyond 32,000 chars (docs/dom-research.md).
      maxInputChars: site === 'gemini' ? 32000 : 0,
      hasSelectors: () => Object.keys(selectorsFor()).length > 0,
      missingKeys: () =>
        ['input', 'sendButton', 'stopButton', 'turn', 'modelTurn', 'userTurn', 'codeBlock'].filter((k) => !sel(k).length),
      getTurns,
      getModelBlocks,
      turnText,
      isGenerating,
      isTurnComplete,
      getInput,
      getInputText,
      setInput,
      send,
      conversationId,
      conversationKey,
      isNewChat,
      setSystemInstructions: site === 'aistudio' ? setSystemInstructions : null,
      _internal: { isVisible, qAll, q, elMatchesKey, toList },
    };
  }

  DSG.detectSite = detectSite;
  DSG.createSiteAdapter = createSiteAdapter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
