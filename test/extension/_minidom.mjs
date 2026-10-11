// Minimal DOM for running site adapters against the HTML fixtures in Node (no deps).
// HTML: elements, attributes, text, comments, void tags, raw-text <style>/<script>,
// <template> (contents inert: not reachable by queries from outside).
// Selectors: lists, combinators ' ' and '>', tag/*, #id, .class, [a], [a=v], [a^=v],
// [a$=v], [a*=v], [a~=v] (+ ' i' flag), :not(list), :has(relative list),
// :first-child, :last-child, :first-of-type, :last-of-type, :scope.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] !== undefined ? ENT[e] : m;
  });

class Text {
  constructor(t) {
    this.nodeType = 3;
    this.data = t;
    this.parentNode = null;
  }
  get textContent() {
    return this.data;
  }
  cloneNode() {
    return new Text(this.data);
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

class ClassList {
  constructor(el) {
    this.el = el;
  }
  get _list() {
    return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }
  contains(c) {
    return this._list.includes(c);
  }
  add(...cs) {
    const l = this._list;
    for (const c of cs) if (!l.includes(c)) l.push(c);
    this.el.setAttribute('class', l.join(' '));
  }
  remove(...cs) {
    this.el.setAttribute('class', this._list.filter((c) => !cs.includes(c)).join(' '));
  }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : force;
    on ? this.add(c) : this.remove(c);
    return on;
  }
}

export class Element {
  constructor(tag, attrs) {
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attrs || {}));
    this.childNodes = [];
    this.parentNode = null;
    this.classList = new ClassList(this);
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  get className() {
    return this.getAttribute('class') || '';
  }
  get isContentEditable() {
    for (let n = this; n; n = n.parentElement) {
      const v = n.getAttribute('contenteditable');
      if (v === 'true' || v === '') return true;
      if (v === 'false') return false;
    }
    return false;
  }
  get disabled() {
    return this.hasAttribute('disabled');
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) {
      if (n.parentNode.localName === 'template') return false;
      n = n.parentNode;
    }
    return n.nodeType === 9;
  }
  getAttribute(k) {
    k = k.toLowerCase();
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  hasAttribute(k) {
    return this.attributes.has(k.toLowerCase());
  }
  setAttribute(k, v) {
    this.attributes.set(k.toLowerCase(), String(v));
  }
  removeAttribute(k) {
    this.attributes.delete(k.toLowerCase());
  }
  get textContent() {
    if (this.localName === 'template') return '';
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(t) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = t ? [new Text(String(t))] : [];
    if (this.childNodes[0]) this.childNodes[0].parentNode = this;
  }
  get value() {
    return this._value !== undefined ? this._value : this.localName === 'textarea' ? this.textContent : this.getAttribute('value') || '';
  }
  set value(v) {
    this._value = String(v);
  }
  appendChild(n) {
    if (n.nodeType === 11) {
      for (const c of [...n.childNodes]) this.appendChild(c);
      return n;
    }
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  append(...ns) {
    for (const n of ns) this.appendChild(typeof n === 'string' ? new Text(n) : n);
  }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
    return n;
  }
  prepend(n) {
    return this.insertBefore(n, this.childNodes[0]);
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceWith(n) {
    const p = this.parentNode;
    p.insertBefore(n, this);
    p.removeChild(this);
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  cloneNode(deep) {
    const c = new Element(this.localName, Object.fromEntries(this.attributes));
    if (deep) for (const k of this.childNodes) c.appendChild(k.cloneNode(true));
    if (this.content) c.content = this.content;
    return c;
  }
  contains(o) {
    for (let n = o; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  focus() {
    const d = this.ownerDocument || docOf(this);
    if (d) d.activeElement = this;
  }
  click() {
    if (this.onclick) this.onclick();
    this._clicks = (this._clicks || 0) + 1;
  }
  dispatchEvent(ev) {
    (this._events = this._events || []).push(ev);
    return true;
  }
  getClientRects() {
    if (!this.isConnected) return [];
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.hasAttribute('hidden')) return [];
    return [{}];
  }
  *descendants() {
    if (this.localName === 'template') return; // inert
    for (const c of this.childNodes) {
      if (c.nodeType !== 1) continue;
      yield c;
      yield* c.descendants();
    }
  }
  matches(sel) {
    return matchesList(this, parseSelectorList(sel), null);
  }
  querySelectorAll(sel) {
    const list = parseSelectorList(sel);
    const out = [];
    for (const e of this.descendants()) if (matchesList(e, list, this)) out.push(e);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  getElementById(id) {
    for (const e of this.descendants()) if (e.id === id) return e;
    return null;
  }
}

function docOf(n) {
  while (n.parentNode) n = n.parentNode;
  return n.nodeType === 9 ? n : null;
}

export class Document extends Element {
  constructor() {
    super('#document');
    this.nodeType = 9;
    this.activeElement = null;
  }
  get documentElement() {
    return this.children[0] || null;
  }
  get body() {
    return this.querySelector('body');
  }
  createElement(t) {
    return new Element(t);
  }
  createTextNode(t) {
    return new Text(t);
  }
  execCommand() {
    return false;
  }
}

// ------------------------------------------------------------------ HTML parser
export function parseHTML(html) {
  const doc = new Document();
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const e = html.indexOf('-->', i + 4);
      i = e < 0 ? html.length : e + 3;
      continue;
    }
    if (html.startsWith('<!', i)) {
      i = html.indexOf('>', i) + 1;
      continue;
    }
    if (html[i] === '<' && html[i + 1] === '/') {
      const e = html.indexOf('>', i);
      const name = html.slice(i + 2, e).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].localName === name) {
          stack.length = k;
          break;
        }
      }
      i = e + 1;
      continue;
    }
    if (html[i] === '<' && /[a-zA-Z]/.test(html[i + 1] || '')) {
      const m = /^<([a-zA-Z][\w-]*)/.exec(html.slice(i, i + 100));
      const name = m[1].toLowerCase();
      let j = i + m[0].length;
      const attrs = {};
      for (;;) {
        while (/\s/.test(html[j])) j++;
        if (html[j] === '>' || html.startsWith('/>', j)) break;
        const am = /^([^\s=>\/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/.exec(html.slice(j));
        if (!am) {
          j++;
          continue;
        }
        attrs[am[1].toLowerCase()] = decode(am[3] ?? am[4] ?? am[5] ?? '');
        j += am[0].length;
      }
      const selfClose = html.startsWith('/>', j);
      i = j + (selfClose ? 2 : 1);
      if (name === 'p' && top().localName === 'p') stack.pop();
      const el = new Element(name, attrs);
      top().appendChild(el);
      if (VOID.has(name) || selfClose) continue;
      if (RAW.has(name)) {
        const end = html.toLowerCase().indexOf('</' + name, i);
        const txt = html.slice(i, end < 0 ? html.length : end);
        if (txt) el.appendChild(new Text(name === 'style' || name === 'script' ? txt : decode(txt)));
        i = end < 0 ? html.length : html.indexOf('>', end) + 1;
        continue;
      }
      stack.push(el);
      continue;
    }
    const e = html.indexOf('<', i + 1);
    const t = html.slice(i, e < 0 ? html.length : e);
    if (stack.length > 1) top().appendChild(new Text(decode(t)));
    i = e < 0 ? html.length : e;
  }
  for (const t of doc.querySelectorAllIncludingTemplates('template')) {
    t.content = { cloneNode: () => fragmentOf(t) };
  }
  return doc;
}

function fragmentOf(tpl) {
  const frag = new Element('#fragment');
  frag.nodeType = 11;
  for (const c of tpl.childNodes) frag.appendChild(c.cloneNode(true));
  return frag;
}

Element.prototype.querySelectorAllIncludingTemplates = function (tag) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType !== 1) continue;
      if (c.localName === tag) out.push(c);
      walk(c);
    }
  };
  walk(this);
  return out;
};

// ------------------------------------------------------------------ selectors
const cache = new Map();

function parseSelectorList(src) {
  if (cache.has(src)) return cache.get(src);
  const p = { s: src, i: 0 };
  const list = parseList(p, false);
  skipWs(p);
  if (p.i < p.s.length) throw new SyntaxError(`bad selector "${src}" at ${p.i}`);
  cache.set(src, list);
  return list;
}
function skipWs(p) {
  while (/\s/.test(p.s[p.i] || '')) p.i++;
}
function parseList(p, relative) {
  const out = [];
  for (;;) {
    skipWs(p);
    out.push(parseComplex(p, relative));
    skipWs(p);
    if (p.s[p.i] === ',') {
      p.i++;
      continue;
    }
    return out;
  }
}
function parseComplex(p, relative) {
  const compounds = [];
  const combs = [];
  skipWs(p);
  if (relative) {
    compounds.push({ scope: true, tag: null, id: null, cls: [], attrs: [], pseudos: [] });
    if (p.s[p.i] === '>') {
      p.i++;
      combs.push('>');
    } else combs.push(' ');
    skipWs(p);
  }
  compounds.push(parseCompound(p));
  for (;;) {
    const save = p.i;
    let sawWs = false;
    while (/\s/.test(p.s[p.i] || '')) {
      p.i++;
      sawWs = true;
    }
    const ch = p.s[p.i];
    if (ch === '>') {
      p.i++;
      skipWs(p);
      combs.push('>');
      compounds.push(parseCompound(p));
    } else if (ch === '+' || ch === '~') {
      throw new SyntaxError('sibling combinators unsupported in minidom');
    } else if (sawWs && ch && ch !== ',' && ch !== ')') {
      combs.push(' ');
      compounds.push(parseCompound(p));
    } else {
      p.i = save;
      return { compounds, combs };
    }
  }
}
function ident(p) {
  const m = /^-?[\w-]+/.exec(p.s.slice(p.i));
  if (!m) throw new SyntaxError(`ident expected in "${p.s}" at ${p.i}`);
  p.i += m[0].length;
  return m[0];
}
function parseCompound(p) {
  const c = { tag: null, id: null, cls: [], attrs: [], pseudos: [] };
  let any = false;
  for (;;) {
    const ch = p.s[p.i];
    if (ch === '*') {
      p.i++;
      any = true;
    } else if (/[a-zA-Z]/.test(ch || '') && !any && !c.tag && c.cls.length + c.attrs.length + c.pseudos.length === 0 && !c.id) {
      c.tag = ident(p).toLowerCase();
      any = true;
    } else if (ch === '#') {
      p.i++;
      c.id = ident(p);
      any = true;
    } else if (ch === '.') {
      p.i++;
      c.cls.push(ident(p));
      any = true;
    } else if (ch === '[') {
      const m = /^\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*(i)?\s*)?\]/.exec(p.s.slice(p.i));
      if (!m) throw new SyntaxError(`bad attribute selector in "${p.s}"`);
      p.i += m[0].length;
      c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, val: m[3] ?? m[4] ?? m[5] ?? null, ci: !!m[6] });
      any = true;
    } else if (ch === ':') {
      p.i++;
      const name = ident(p).toLowerCase();
      if (name === 'not' || name === 'has' || name === 'is' || name === 'where') {
        if (p.s[p.i] !== '(') throw new SyntaxError('( expected');
        p.i++;
        const list = parseList(p, name === 'has');
        skipWs(p);
        if (p.s[p.i] !== ')') throw new SyntaxError(') expected in ' + p.s);
        p.i++;
        c.pseudos.push({ name, list });
      } else if (['first-child', 'last-child', 'first-of-type', 'last-of-type', 'scope'].includes(name)) {
        c.pseudos.push({ name });
      } else throw new SyntaxError(`unsupported pseudo :${name}`);
      any = true;
    } else break;
  }
  if (!any) throw new SyntaxError(`empty compound in "${p.s}" at ${p.i}`);
  return c;
}

function attrMatch(el, a) {
  let v = el.getAttribute(a.name);
  if (v == null) return false;
  if (!a.op) return true;
  let w = a.val;
  if (a.ci) {
    v = v.toLowerCase();
    w = w.toLowerCase();
  }
  switch (a.op) {
    case '=':
      return v === w;
    case '^=':
      return w !== '' && v.startsWith(w);
    case '$=':
      return w !== '' && v.endsWith(w);
    case '*=':
      return w !== '' && v.includes(w);
    case '~=':
      return v.split(/\s+/).includes(w);
    case '|=':
      return v === w || v.startsWith(w + '-');
  }
  return false;
}

function compoundMatch(el, c, scope) {
  if (c.scope) return el === scope;
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.cls) if (!el.classList.contains(k)) return false;
  for (const a of c.attrs) if (!attrMatch(el, a)) return false;
  for (const ps of c.pseudos) {
    const parent = el.parentElement;
    const sibs = parent ? parent.children : [el];
    switch (ps.name) {
      case 'not':
        if (matchesList(el, ps.list, scope)) return false;
        break;
      case 'is':
      case 'where':
        if (!matchesList(el, ps.list, scope)) return false;
        break;
      case 'has': {
        let ok = false;
        for (const d of el.descendants()) {
          if (ps.list.some((cx) => matchComplex(d, cx, cx.compounds.length - 1, el))) {
            ok = true;
            break;
          }
        }
        if (!ok) return false;
        break;
      }
      case 'first-child':
        if (sibs[0] !== el) return false;
        break;
      case 'last-child':
        if (sibs[sibs.length - 1] !== el) return false;
        break;
      case 'first-of-type':
        if (sibs.find((s) => s.localName === el.localName) !== el) return false;
        break;
      case 'last-of-type':
        if (sibs.filter((s) => s.localName === el.localName).pop() !== el) return false;
        break;
      case 'scope':
        if (el !== scope) return false;
        break;
    }
  }
  return true;
}

function matchComplex(el, cx, idx, scope) {
  if (!el || el.nodeType !== 1) return false;
  if (!compoundMatch(el, cx.compounds[idx], scope)) return false;
  if (idx === 0) return true;
  const comb = cx.combs[idx - 1];
  if (comb === '>') return matchComplex(el.parentElement, cx, idx - 1, scope);
  for (let a = el.parentElement; a; a = a.parentElement) if (matchComplex(a, cx, idx - 1, scope)) return true;
  return false;
}

function matchesList(el, list, scope) {
  return list.some((cx) => matchComplex(el, cx, cx.compounds.length - 1, scope));
}

/** A window-ish object for createSiteAdapter. */
export function makeWindow(doc, href) {
  const u = new URL(href);
  return {
    document: doc,
    location: { hostname: u.hostname, pathname: u.pathname, href },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    setTimeout,
    Event: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    KeyboardEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
  };
}
