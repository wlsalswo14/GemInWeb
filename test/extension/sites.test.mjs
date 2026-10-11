import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts, plain } from './_load.mjs';

// ---------------------------------------------------------------- tiny fake DOM
// Supports compound selectors (tag, #id, .class, [attr], [attr="v"]) joined by
// descendant combinators and comma lists. ":has(" throws like an unsupported selector.
function parseCompound(s) {
  const c = { tag: null, id: null, cls: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  let pos = 0;
  while ((m = re.exec(s))) {
    if (m.index !== pos) throw new SyntaxError('bad selector ' + s);
    pos = re.lastIndex;
    if (m[1]) c.tag = m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.cls.push(m[3]);
    else c.attrs.push([m[4], m[5]]);
  }
  if (pos !== s.length) throw new SyntaxError('bad selector ' + s);
  return c;
}
function matchCompound(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.cls) if (!el.classList.includes(k)) return false;
  for (const [k, v] of c.attrs) {
    const a = el.getAttribute(k);
    if (a == null || (v !== undefined && a !== v)) return false;
  }
  return true;
}
function matchesSel(el, sel) {
  if (sel.includes(':has(')) throw new SyntaxError('unsupported');
  return sel.split(',').some((part) => {
    const chain = part.trim().split(/\s+/).map(parseCompound);
    if (!matchCompound(el, chain[chain.length - 1])) return false;
    let i = chain.length - 2;
    for (let p = el.parentElement; p && i >= 0; p = p.parentElement) if (matchCompound(p, chain[i])) i--;
    return i < 0;
  });
}
class El {
  constructor(tag, attrs = {}, ...kids) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.id = attrs.id || '';
    this.classList = (attrs.class || '').split(/\s+/).filter(Boolean);
    this.children = [];
    this.parentElement = null;
    this.hidden = !!attrs.hidden;
    this.text = '';
    for (const k of kids) this.append(k);
  }
  append(k) {
    if (typeof k === 'string') this.children.push({ text: k, isText: true });
    else {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
  get isConnected() {
    return true;
  }
  getAttribute(k) {
    return k in this.attrs ? String(this.attrs[k]) : null;
  }
  get className() {
    return this.classList.join(' ');
  }
  get textContent() {
    return this.children.map((c) => (c.isText ? c.text : c.textContent)).join('');
  }
  getClientRects() {
    for (let n = this; n; n = n.parentElement) if (n.hidden) return [];
    return [{}];
  }
  matches(sel) {
    return matchesSel(this, sel);
  }
  *walk() {
    for (const c of this.children) {
      if (c.isText) continue;
      yield c;
      yield* c.walk();
    }
  }
  querySelectorAll(sel) {
    const out = [];
    for (const e of this.walk()) if (matchesSel(e, sel)) out.push(e);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  contains(o) {
    for (let n = o; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  cloneNode() {
    const c = new El(this.tagName, this.attrs);
    c.hidden = this.hidden;
    for (const k of this.children) c.append(k.isText ? k.text : k.cloneNode());
    return c;
  }
  remove() {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((x) => x !== this);
    this.parentElement = null;
  }
}
const h = (tag, attrs, ...kids) => new El(tag, attrs || {}, ...kids);

function makeAdapter(site, selectors, body, href) {
  const ctx = loadScripts(['content/protocol.js', 'content/sites.js']);
  const u = new URL(href);
  const win = {
    location: { hostname: u.hostname, pathname: u.pathname, href },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    setTimeout,
    document: body,
  };
  return { ctx, adapter: ctx.DSG.createSiteAdapter(site, { selectors: { [site]: selectors }, win, doc: body }) };
}

// A Gemini-like page.
function geminiPage({ generating = false } = {}) {
  return h(
    'body',
    {},
    h(
      'div',
      { class: 'chat' },
      h('user-query', { id: 'u1' }, 'please read ', h('pre', {}, '{"tool":"read_file","args":{"path":"user-pasted"}}')),
      h(
        'model-response',
        { id: 'm1' },
        h('model-thoughts', {}, h('pre', {}, '{"tool":"run_shell","args":{"command":"thought"}}')),
        h(
          'div',
          { class: 'markdown' },
          'Reading it now.',
          h('div', { class: 'code-block' }, h('span', { class: 'lang' }, 'devspace'), h('pre', {}, h('code', {}, '{"tool":"read_file","args":{"path":"a.txt"}}')))
        )
      )
    ),
    h('rich-textarea', {}, h('div', { class: 'ql-editor', contenteditable: 'true' })),
    h('button', { class: 'send', 'aria-disabled': 'false' }),
    h('button', { class: 'stop', hidden: !generating })
  );
}
const GEMINI_SEL = {
  input: ['textarea.missing', 'rich-textarea .ql-editor'],
  sendButton: ['button.send'],
  stopButton: ['button.stop'],
  turn: ['div.nothing-here', 'user-query, model-response'],
  modelTurn: ['model-response'],
  userTurn: ['user-query'],
  turnBody: ['div.markdown'],
  codeBlock: ['pre:has(code)', 'pre code'],
  codeLanguage: ['span.lang'],
  exclude: ['model-thoughts'],
  conversationIdFromUrl: '/app/([0-9a-f]+)',
};

test('detectSite', () => {
  const { DSG } = loadScripts(['content/sites.js']);
  assert.equal(DSG.detectSite({ hostname: 'aistudio.google.com' }), 'aistudio');
  assert.equal(DSG.detectSite({ hostname: 'gemini.google.com' }), 'gemini');
  assert.equal(DSG.detectSite({ hostname: 'evil.example.com' }), null);
});

test('turns: roles, stable keys from ids, first matching selector wins', () => {
  const { adapter } = makeAdapter('gemini', GEMINI_SEL, geminiPage(), 'https://gemini.google.com/app/abc123');
  const turns = adapter.getTurns();
  assert.deepEqual(plain(turns.map((t) => [t.role, t.key])), [
    ['user', 'id:u1'],
    ['model', 'id:m1'],
  ]);
});

test('model blocks: excluded thoughts are skipped, language label is read, invalid selectors are skipped', () => {
  const { adapter, ctx } = makeAdapter('gemini', GEMINI_SEL, geminiPage(), 'https://gemini.google.com/app/abc123');
  const model = adapter.getTurns()[1].el;
  const blocks = plain(adapter.getModelBlocks(model));
  assert.deepEqual(blocks, [{ text: '{"tool":"read_file","args":{"path":"a.txt"}}', lang: 'devspace' }]);
  const text = adapter.turnText(model);
  assert.ok(!text.includes('thought'));
  assert.ok(text.includes('Reading it now.'));
  const ex = plain(ctx.DSG.protocol.extractCalls(blocks, text));
  assert.deepEqual(ex.calls, [{ tool: 'read_file', args: { path: 'a.txt' } }]);
});

test('generation detection uses visibility', () => {
  assert.equal(makeAdapter('gemini', GEMINI_SEL, geminiPage(), 'https://gemini.google.com/app/1').adapter.isGenerating(), false);
  assert.equal(
    makeAdapter('gemini', GEMINI_SEL, geminiPage({ generating: true }), 'https://gemini.google.com/app/1').adapter.isGenerating(),
    true
  );
});

test('generation detection: the first selector that matches anything decides (broad fallbacks only when it matches nothing)', () => {
  const sel = { ...GEMINI_SEL, stopButton: ['button.stop', 'button.other-stop'] };
  const page = geminiPage(); // button.stop exists but is hidden
  page.append(h('button', { class: 'other-stop' })); // visible unrelated "stop" control
  assert.equal(makeAdapter('gemini', sel, page, 'https://gemini.google.com/app/1').adapter.isGenerating(), false);
  const page2 = geminiPage();
  page2.children = page2.children.filter((c) => !(c.classList && c.classList.includes('stop')));
  page2.append(h('button', { class: 'other-stop' }));
  assert.equal(makeAdapter('gemini', sel, page2, 'https://gemini.google.com/app/1').adapter.isGenerating(), true);
});

test('conversation key / new chat detection', () => {
  let a = makeAdapter('gemini', GEMINI_SEL, geminiPage(), 'https://gemini.google.com/app/abc123').adapter;
  assert.equal(a.conversationKey(), 'gemini:abc123');
  assert.equal(a.isNewChat(), false);
  a = makeAdapter('gemini', GEMINI_SEL, geminiPage(), 'https://gemini.google.com/app').adapter;
  assert.equal(a.conversationKey(), 'gemini:/app');
  assert.equal(a.isNewChat(), true);
  // AI Studio fallback regex when the key is missing; new_chat is not an id
  a = makeAdapter('aistudio', {}, geminiPage(), 'https://aistudio.google.com/prompts/new_chat').adapter;
  assert.equal(a.isNewChat(), true);
  a = makeAdapter('aistudio', {}, geminiPage(), 'https://aistudio.google.com/prompts/1AbC_dEf-ghIJk').adapter;
  assert.equal(a.conversationKey(), 'aistudio:1AbC_dEf-ghIJk');
});

test('missing keys degrade gracefully', () => {
  const { adapter } = makeAdapter(
    'gemini',
    { modelTurn: ['model-response'], userTurn: ['user-query'] },
    geminiPage({ generating: true }),
    'https://gemini.google.com/app/1'
  );
  // turn missing → union of model/user selectors in document order
  assert.deepEqual(plain(adapter.getTurns().map((t) => t.role)), ['user', 'model']);
  // no stopButton/generatingIndicator → never "generating"
  assert.equal(adapter.isGenerating(), false);
  // no turnComplete → complete
  assert.equal(adapter.isTurnComplete(adapter.getTurns()[1].el), true);
  // no codeBlock → every <pre> in the turn body (no exclude key → thoughts included)
  assert.equal(adapter.getModelBlocks(adapter.getTurns()[1].el).length, 2);
  assert.equal(adapter.getInput(), null);
  assert.ok(adapter.missingKeys().includes('input'));
  // completely empty selectors
  const empty = makeAdapter('gemini', {}, geminiPage(), 'https://gemini.google.com/app/1').adapter;
  assert.deepEqual(plain(empty.getTurns()), []);
  assert.equal(empty.hasSelectors(), false);
});

test('turnComplete marker is honoured when defined', () => {
  const page = geminiPage();
  const { adapter } = makeAdapter('gemini', { ...GEMINI_SEL, turnComplete: ['.done'] }, page, 'https://gemini.google.com/app/1');
  const model = adapter.getTurns()[1].el;
  assert.equal(adapter.isTurnComplete(model), false);
  model.append(h('div', { class: 'done' }));
  assert.equal(adapter.isTurnComplete(model), true);
});
