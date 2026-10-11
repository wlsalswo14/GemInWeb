/* GemInWeb — model-facing tool-call protocol (parser + result formatter).
 * Classic script; attaches to globalThis.DSG.protocol. No DOM access, so it can be
 * loaded in Node via `vm` for tests. */
(function (g) {
  'use strict';
  const DSG = (g.DSG = g.DSG || {});

  // ---------------------------------------------------------------- tools
  const TOOL_DEFS = [
    { name: 'open_workspace', mutating: false, bodyParam: null, aliases: ['open', 'cd'] },
    { name: 'list_dir', mutating: false, bodyParam: null, aliases: ['ls', 'list'] },
    { name: 'find_files', mutating: false, bodyParam: null, aliases: ['glob', 'find'] },
    { name: 'read_file', mutating: false, bodyParam: null, aliases: ['read', 'cat', 'view'] },
    { name: 'write_file', mutating: true, bodyParam: 'content', aliases: ['write', 'create_file'] },
    { name: 'edit_file', mutating: true, bodyParam: 'edits', aliases: ['edit', 'str_replace'] },
    { name: 'apply_patch', mutating: true, bodyParam: 'patch', aliases: ['patch'] },
    { name: 'run_shell', mutating: true, bodyParam: 'command', aliases: ['bash', 'shell', 'exec', 'run', 'powershell'] },
    { name: 'search', mutating: false, bodyParam: null, aliases: ['grep', 'rg'] },
    { name: 'show_changes', mutating: false, bodyParam: null, aliases: ['git_diff', 'diff', 'git_status'] },
    { name: 'fetch_url', mutating: false, bodyParam: null, aliases: ['fetch', 'open_url'] },
  ];
  const TOOLS = new Map();
  const ALIASES = new Map();
  // alias → extra args implied by the alias
  const ALIAS_EXTRA = { powershell: { shell: 'powershell' } };

  function registerTool(def) {
    if (!def || typeof def.name !== 'string') return;
    const name = def.name.toLowerCase();
    const prev = TOOLS.get(name) || {};
    const merged = {
      name,
      mutating: def.mutating != null ? !!def.mutating : !!prev.mutating,
      bodyParam: def.bodyParam !== undefined ? def.bodyParam || null : prev.bodyParam || null,
      aliases: Array.from(new Set([...(prev.aliases || []), ...(def.aliases || [])])),
    };
    TOOLS.set(name, merged);
    for (const a of merged.aliases) if (!TOOLS.has(a)) ALIASES.set(a, name);
  }
  TOOL_DEFS.forEach(registerTool);

  function normName(name) {
    return String(name)
      .trim()
      .toLowerCase()
      .replace(/^devspace[._:/-]+/, '')
      .replace(/[-\s]+/g, '_');
  }

  /** Map a tool name or alias to { tool, def, extra } or null when unknown. */
  function resolveTool(name) {
    if (typeof name !== 'string' || !name.trim()) return null;
    const n = normName(name);
    if (TOOLS.has(n)) return { tool: n, def: TOOLS.get(n), extra: null };
    if (ALIASES.has(n)) {
      const tool = ALIASES.get(n);
      return { tool, def: TOOLS.get(tool), extra: ALIAS_EXTRA[n] || null };
    }
    return null;
  }

  function isMutating(tool) {
    const r = resolveTool(tool);
    return !!(r && r.def.mutating);
  }

  // ---------------------------------------------------------------- hashing
  function hashString(s) {
    s = String(s);
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
      h2 ^= h2 >>> 13;
    }
    return h1.toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  function hashCalls(calls) {
    return hashString(stableStringify((calls || []).map((c) => ({ tool: c.tool, args: c.args }))));
  }

  // ---------------------------------------------------------------- lenient JSON
  const DRIVE_PATH_RE = /(?:^|[^A-Za-z0-9_])[A-Za-z]:\\(?![\\"])/;

  function fixStringBody(raw) {
    // raw = string contents between the quotes, exactly as written.
    const drive = DRIVE_PATH_RE.test(raw);
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\\') {
        const nx = raw[i + 1];
        if (nx === undefined) {
          out += '\\\\';
        } else if (nx === '"' || nx === '\\') {
          out += '\\' + nx;
          i++;
        } else if (drive) {
          out += '\\\\'; // literal backslash (Windows path written with single backslashes)
        } else if ('/bfnrt'.includes(nx)) {
          out += '\\' + nx;
          i++;
        } else if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.substr(i + 2, 4))) {
          out += '\\u';
          i++;
        } else {
          out += '\\\\';
        }
      } else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch.charCodeAt(0) < 0x20) out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      else out += ch;
    }
    return out;
  }

  /** Read a quoted string starting at s[i] (the quote). Returns { raw, end } where end is the index after the closing quote. */
  function readQuoted(s, i) {
    const q = s[i];
    let j = i + 1;
    let raw = '';
    while (j < s.length) {
      const ch = s[j];
      if (ch === '\\' && j + 1 < s.length) {
        raw += ch + s[j + 1];
        j += 2;
        continue;
      }
      if (ch === q) return { raw, end: j + 1 };
      raw += ch;
      j++;
    }
    return { raw, end: s.length, unterminated: true };
  }

  function skipWsAndComments(s, i) {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '/' && s[i + 1] === '/') {
        while (i < s.length && s[i] !== '\n') i++;
        continue;
      }
      if (s[i] === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        i = e < 0 ? s.length : e + 2;
        continue;
      }
      return i;
    }
  }

  /** Turn "almost JSON" into JSON: comments, trailing commas, single-quoted strings,
   * raw newlines in strings, invalid escapes, single-backslash Windows paths. */
  function sanitizeJson(s) {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const { raw, end } = readQuoted(s, i);
        let body = raw;
        if (ch === "'") body = body.replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"');
        out += '"' + fixStringBody(body) + '"';
        i = end;
        continue;
      }
      if (ch === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
        i = skipWsAndComments(s, i);
        continue;
      }
      if (ch === ',') {
        const j = skipWsAndComments(s, i + 1);
        if (s[j] === '}' || s[j] === ']') {
          i = j;
          continue;
        }
      }
      // Python-ish literals outside strings
      if (/[TFN]/.test(ch) && !/[A-Za-z0-9_]/.test(s[i - 1] || '')) {
        const m = /^(True|False|None)(?![A-Za-z0-9_])/.exec(s.slice(i, i + 6));
        if (m) {
          out += m[1] === 'True' ? 'true' : m[1] === 'False' ? 'false' : 'null';
          i += m[1].length;
          continue;
        }
      }
      out += ch;
      i++;
    }
    return out;
  }

  function parseJsonLenient(text) {
    const s = String(text).replace(/^﻿/, '').trim();
    try {
      // Fast path only when no single-backslash drive path can be mis-decoded.
      if (!/[A-Za-z]:\\(?![\\"])/.test(s)) return { ok: true, value: JSON.parse(s) };
    } catch (_) {
      /* fall through */
    }
    try {
      return { ok: true, value: JSON.parse(sanitizeJson(s)) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** Index after the balanced {...} / [...] starting at s[i], or -1. String-aware. */
  function scanBalanced(s, i) {
    const open = s[i];
    if (open !== '{' && open !== '[') return -1;
    const stack = [];
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (ch === '"') {
        const r = readQuoted(s, j);
        if (r.unterminated) return -1;
        j = r.end - 1;
        continue;
      }
      if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') {
        if (stack.pop() !== ch) return -1;
        if (!stack.length) return j + 1;
      }
    }
    return -1;
  }

  // ---------------------------------------------------------------- call normalization
  const RESERVED = new Set(['tool', 'name', 'tool_name', 'toolName', 'function', 'args', 'arguments', 'parameters', 'params', 'input', 'type', 'id']);

  function normalizeCall(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (obj.functionCall && typeof obj.functionCall === 'object') obj = obj.functionCall;
    else if (obj.function_call && typeof obj.function_call === 'object') obj = obj.function_call;
    let name = obj.tool;
    if (typeof name !== 'string') name = obj.name;
    if (typeof name !== 'string') name = obj.tool_name;
    if (typeof name !== 'string') name = obj.toolName;
    let fnArgs;
    if (typeof name !== 'string' && obj.function) {
      if (typeof obj.function === 'string') name = obj.function;
      else if (typeof obj.function === 'object') {
        name = obj.function.name;
        fnArgs = obj.function.arguments !== undefined ? obj.function.arguments : obj.function.args;
      }
    }
    const r = resolveTool(name);
    if (!r) return null;
    let args;
    for (const k of ['args', 'arguments', 'parameters', 'params', 'input']) {
      if (obj[k] !== undefined) {
        args = obj[k];
        break;
      }
    }
    if (args === undefined) args = fnArgs;
    if (typeof args === 'string') {
      const t = args.trim();
      const p = /^[{[]/.test(t) ? parseJsonLenient(t) : { ok: false };
      if (p.ok && p.value && typeof p.value === 'object' && !Array.isArray(p.value)) args = p.value;
      else if (r.def.bodyParam && r.def.bodyParam !== 'edits') args = { [r.def.bodyParam]: args };
      else args = {};
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    args = Object.assign({}, args);
    for (const k of Object.keys(obj)) {
      if (!RESERVED.has(k) && !(k in args)) args[k] = obj[k];
    }
    if (r.extra) for (const k of Object.keys(r.extra)) if (args[k] === undefined) args[k] = r.extra[k];
    return { tool: r.tool, args };
  }

  function callsFromValue(v) {
    if (Array.isArray(v)) return v.flatMap(callsFromValue);
    if (!v || typeof v !== 'object') return [];
    const c = normalizeCall(v);
    if (c) return [c];
    for (const k of ['tool_calls', 'calls', 'toolCalls', 'functionCalls']) {
      if (Array.isArray(v[k])) return v[k].flatMap(callsFromValue);
    }
    return [];
  }

  // ---------------------------------------------------------------- header form
  const HDR_RE = /^\s*([A-Za-z_][\w.-]*)\s*:\s?(.*)$/;
  const SR_SEARCH = /^<{5,9}\s*SEARCH\s*$/;
  const SR_DIVIDE = /^={5,9}\s*$/;
  const SR_REPLACE = /^>{5,9}\s*REPLACE\s*$/;

  function convertValue(v) {
    let t = v.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+$/.test(t) && t.length < 16) return parseInt(t, 10);
    if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")) || (t[0] === '`' && t.endsWith('`')))) {
      t = t.slice(1, -1);
    }
    return t;
  }

  /** Parse Aider-style SEARCH/REPLACE blocks → [{old_text, new_text}] (null when none). */
  function parseSearchReplace(body) {
    const lines = String(body).split('\n');
    const edits = [];
    let state = 0;
    let oldL = [];
    let newL = [];
    for (const line of lines) {
      if (state === 0) {
        if (SR_SEARCH.test(line)) {
          state = 1;
          oldL = [];
          newL = [];
        }
      } else if (state === 1) {
        if (SR_DIVIDE.test(line)) state = 2;
        else oldL.push(line);
      } else if (state === 2) {
        if (SR_REPLACE.test(line)) {
          edits.push({ old_text: oldL.join('\n'), new_text: newL.join('\n') });
          state = 0;
        } else newL.push(line);
      }
    }
    if (state !== 0) return { edits, error: 'unterminated SEARCH/REPLACE block (missing ======= or >>>>>>> REPLACE)' };
    return { edits };
  }

  function trimTrailingBlankLines(s) {
    return s.replace(/(?:[ \t]*\n)*[ \t]*$/, (m) => (m.includes('\n') ? '' : m));
  }

  function parseHeaderForm(text) {
    const lines = text.split('\n');
    let start = 0;
    while (start < lines.length && !lines[start].trim()) start++;
    if (start >= lines.length) return null;
    const first = HDR_RE.exec(lines[start]);
    if (!first || !/^(tool|name|tool_name)$/i.test(first[1])) return null;
    const r = resolveTool(convertValue(first[2]) + '');
    if (!r) return { error: `unknown tool "${first[2].trim()}"`, toolName: first[2].trim() };
    let sep = -1;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trimEnd() === '---') {
        sep = i;
        break;
      }
    }
    const args = {};
    let body = null;
    const hdrEnd = sep >= 0 ? sep : lines.length;
    for (let i = start + 1; i < hdrEnd; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      const m = HDR_RE.exec(l);
      if (!m) {
        if (sep < 0 && r.def.bodyParam) {
          body = lines.slice(i).join('\n');
          break;
        }
        return { error: `line ${i - start + 1} is not "key: value" (put the body after a line containing only ---)` };
      }
      args[m[1]] = convertValue(m[2]);
    }
    if (sep >= 0) body = lines.slice(sep + 1).join('\n');
    if (r.extra) for (const k of Object.keys(r.extra)) if (args[k] === undefined) args[k] = r.extra[k];
    const bp = r.def.bodyParam;
    // `command: node -v` as a header followed by an empty `---` body: keep the header value.
    if (body != null && bp && !body.trim() && args[bp] !== undefined) body = null;
    if (body != null && bp) {
      if (bp === 'edits') {
        const sr = parseSearchReplace(body);
        if (sr.error) return { error: sr.error };
        let edits = sr.edits;
        if (!edits.length && body.trim()) {
          const p = parseJsonLenient(body);
          if (p.ok && Array.isArray(p.value)) edits = p.value;
          else if (p.ok && p.value && Array.isArray(p.value.edits)) edits = p.value.edits;
          else return { error: 'edit_file body has no <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks' };
        }
        if (args.replace_all === true) edits = edits.map((e) => Object.assign({}, e, { replace_all: true }));
        delete args.replace_all;
        if (edits.length) args.edits = edits;
      } else if (bp === 'command') {
        args.command = body.trim();
      } else {
        const t = trimTrailingBlankLines(body);
        args[bp] = t.length ? t + '\n' : '';
      }
    }
    return { calls: [{ tool: r.tool, args }] };
  }

  // ---------------------------------------------------------------- blocks
  function cleanText(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .replace(/ /g, ' ')
      .replace(/[​‌‍⁠﻿]/g, '');
  }

  function isDevspaceLang(lang) {
    return typeof lang === 'string' && /^devspace\b/i.test(lang.trim());
  }

  /** Parse one code block. → { calls: [...] } or { calls: [], error } */
  function parseBlock(text, lang) {
    let t = cleanText(text);
    // Rendered blocks occasionally keep the fence or the language label as the first line.
    const fence = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\s*\1`*\s*$/.exec(t);
    if (fence) t = fence[2];
    t = t.replace(/^\s*(devspace|json|jsonc|json5)\s*\n/i, '');
    const trimmed = t.trim();
    if (!trimmed) return { calls: [], error: 'empty block' };
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      const p = parseJsonLenient(trimmed);
      if (p.ok) {
        const calls = callsFromValue(p.value);
        if (calls.length) return { calls };
        return { calls: [], error: unknownToolError(p.value) };
      }
      // Several JSON values in one block (one per line, etc.)
      const calls = [];
      let i = 0;
      let lastErr = p.error;
      while (i < trimmed.length) {
        const ch = trimmed[i];
        if (ch === '{' || ch === '[') {
          const end = scanBalanced(trimmed, i);
          if (end < 0) break;
          const q = parseJsonLenient(trimmed.slice(i, end));
          if (q.ok) calls.push(...callsFromValue(q.value));
          else lastErr = q.error;
          i = end;
        } else i++;
      }
      if (calls.length) return { calls };
      return { calls: [], error: 'invalid JSON: ' + lastErr };
    }
    const h = parseHeaderForm(t);
    if (h && h.calls) return { calls: h.calls };
    if (h && h.error) return { calls: [], error: h.error };
    return { calls: [], error: 'not a tool call (expected JSON {"tool": ..., "args": {...}} or "tool: <name>" header form)' };
  }

  function unknownToolError(v) {
    const pick = (o) => (o && typeof o === 'object' ? o.tool || o.name || o.tool_name || (o.function && o.function.name) : null);
    const n = Array.isArray(v) ? v.map(pick).filter(Boolean)[0] : pick(v);
    return n ? `unknown tool "${n}"` : 'JSON has no "tool" field';
  }

  /** Find fenced code blocks in markdown-ish plain text → [{text, lang}] */
  function findFencedBlocks(text) {
    const lines = cleanText(text).split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const m = /^\s*(`{3,}|~{3,})\s*([\w.+-]*)[^\n`]*$/.exec(lines[i]);
      if (!m) {
        i++;
        continue;
      }
      const fch = m[1][0];
      const flen = m[1].length;
      const body = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const c = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[j]);
        if (c && c[1][0] === fch && c[1].length >= flen) {
          closed = true;
          break;
        }
        body.push(lines[j]);
      }
      if (!closed) break;
      out.push({ text: body.join('\n'), lang: m[2] || '' });
      i = j + 1;
    }
    return out;
  }

  /** Plain-text fallback: fenced blocks first, else balanced {"tool": ...} objects. */
  function extractFromPlainText(text) {
    const t = cleanText(text);
    const calls = [];
    const invalid = [];
    const fenced = findFencedBlocks(t);
    if (fenced.length) {
      for (const b of fenced) {
        const r = parseBlock(b.text, b.lang);
        if (r.calls.length) calls.push(...r.calls);
        else if (isDevspaceLang(b.lang) && b.text.trim()) invalid.push({ error: r.error, snippet: snippet(b.text) });
      }
      if (calls.length || invalid.length) return { calls, invalid };
    }
    const re = /\{\s*"(?:tool|tool_name)"\s*:/g;
    let m;
    while ((m = re.exec(t))) {
      const end = scanBalanced(t, m.index);
      if (end < 0) continue;
      const p = parseJsonLenient(t.slice(m.index, end));
      if (p.ok) {
        const c = callsFromValue(p.value);
        if (c.length) {
          calls.push(...c);
          re.lastIndex = end;
        }
      }
    }
    return { calls, invalid };
  }

  function snippet(s, n) {
    s = String(s).trim().replace(/\s+/g, ' ');
    n = n || 120;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /**
   * Extract tool calls from one model turn.
   * blocks: [{text, lang}] from rendered <pre>/<code>; plainText: turn text (used only when no blocks).
   * → { calls: [{tool, args}], invalid: [{error, snippet}] }   (invalid only for blocks labelled devspace)
   */
  function extractCalls(blocks, plainText) {
    const calls = [];
    const invalid = [];
    if (blocks && blocks.length) {
      for (const b of blocks) {
        const r = parseBlock(b.text, b.lang);
        if (r.calls.length) calls.push(...r.calls);
        else if (isDevspaceLang(b.lang) && String(b.text || '').trim()) invalid.push({ error: r.error, snippet: snippet(b.text) });
      }
      return { calls, invalid };
    }
    if (plainText) return extractFromPlainText(plainText);
    return { calls, invalid };
  }

  // ---------------------------------------------------------------- result formatting
  const FOOTER = 'Continue the task: call more tools with ```devspace blocks, or answer normally (no devspace block) when the task is done.';

  function oneLine(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function fmtArg(v) {
    if (typeof v === 'string') return /\s/.test(v) || v === '' ? JSON.stringify(oneLine(v, 60)) : oneLine(v, 60);
    if (v === null || typeof v !== 'object') return String(v);
    return oneLine(JSON.stringify(v), 60);
  }

  function callSummary(call) {
    if (!call) return '?';
    const tool = call.tool;
    const a = call.args || {};
    const parts = [tool];
    if (tool === 'run_shell') {
      parts.push('`' + oneLine(a.command, 80).replace(/`/g, "'") + '`');
      if (a.shell) parts.push('shell=' + a.shell);
      if (a.cwd) parts.push('cwd=' + fmtArg(a.cwd));
      if (a.background) parts.push('background');
      return parts.join(' ');
    }
    if (tool === 'apply_patch') {
      const files = [];
      String(a.patch || '').replace(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm, (_, f) => files.push(f.trim()));
      parts.push(files.length ? 'files=' + oneLine(files.join(','), 100) : '(patch)');
      return parts.join(' ');
    }
    const body = (TOOLS.get(tool) || {}).bodyParam;
    for (const k of Object.keys(a)) {
      if (k === body) continue;
      parts.push(k + '=' + fmtArg(a[k]));
      if (parts.length > 5) break;
    }
    if (tool === 'write_file' && typeof a.content === 'string') parts.push(`(${a.content.split('\n').length - (a.content.endsWith('\n') ? 1 : 0)} lines)`);
    if (tool === 'edit_file' && Array.isArray(a.edits)) parts.push(`(${a.edits.length} edit${a.edits.length === 1 ? '' : 's'})`);
    return parts.join(' ');
  }

  function fmtDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return null;
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function exitCodeOf(r) {
    if (typeof r.exitCode === 'number') return r.exitCode;
    if (!r.call || r.call.tool !== 'run_shell' || typeof r.output !== 'string') return null;
    const all = r.output.match(/\[exit (-?\d+)[^\]\n]*\]/g);
    if (!all) return null;
    return parseInt(/-?\d+/.exec(all[all.length - 1])[0], 10);
  }

  function statusText(r) {
    if (r.denied) return 'denied';
    if (r.cancelled) return 'cancelled';
    const parts = [];
    const exit = r.ok ? null : exitCodeOf(r);
    if (exit != null) parts.push('exit ' + exit);
    const d = fmtDuration(r.durationMs);
    if (d) parts.push(d);
    if (r.truncated) parts.push('output truncated');
    return (r.ok ? 'ok' : 'error') + (parts.length ? ` (${parts.join(', ')})` : '');
  }

  function longestBacktickRun(s) {
    let max = 0;
    const re = /`+/g;
    let m;
    while ((m = re.exec(s))) if (m[0].length > max) max = m[0].length;
    return max;
  }

  function fenceFor(s) {
    return '`'.repeat(Math.max(3, longestBacktickRun(s) + 1));
  }

  function truncMarker(n) {
    return `[… ${n} chars truncated — narrow the request or use offset/limit …]`;
  }

  function truncateTo(s, allowed) {
    if (s.length <= allowed) return s;
    let removed = s.length - Math.max(0, allowed);
    for (let k = 0; k < 3; k++) {
      const mk = '\n' + truncMarker(removed) + '\n';
      const keep = Math.max(0, allowed - mk.length);
      removed = s.length - keep;
    }
    const mk = truncMarker(removed);
    const keep = s.length - removed;
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    return s.slice(0, head) + '\n' + mk + '\n' + (tail > 0 ? s.slice(s.length - tail) : '');
  }

  /** Water-filling allocation: small outputs stay whole, large ones share the rest proportionally. */
  function allocate(lengths, budget) {
    const alloc = lengths.slice();
    const total = lengths.reduce((a, b) => a + b, 0);
    if (total <= budget) return alloc;
    let remaining = Math.max(0, budget);
    let idx = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);
    while (idx.length) {
      const share = Math.floor(remaining / idx.length);
      const i = idx[0];
      if (lengths[i] <= share) {
        alloc[i] = lengths[i];
        remaining -= lengths[i];
        idx.shift();
      } else {
        for (const j of idx) alloc[j] = share;
        break;
      }
    }
    return alloc;
  }

  function outputText(r) {
    let out = r.output;
    if (out == null || out === '') out = r.error ? String(r.error) : '(no output)';
    out = String(out).replace(/\r\n?/g, '\n').replace(/\n$/, '');
    return out;
  }

  /**
   * results: [{ call:{tool,args}, ok, output, durationMs?, truncated?, denied?, cancelled?, exitCode? }]
   * opts: { maxChars?: number, notes?: string[] }
   */
  function formatResults(results, opts) {
    opts = opts || {};
    const maxChars = opts.maxChars > 0 ? opts.maxChars : Infinity;
    const notes = (opts.notes || []).filter(Boolean);
    const n = results.length;
    const items = results.map((r, i) => ({
      header: `[DevSpace result ${i + 1}/${n}] ${callSummary(r.call)} — ${statusText(r)}`,
      output: outputText(r),
    }));
    const tailText = (notes.length ? notes.join('\n') + '\n' : '') + FOOTER;
    const compose = (outs) =>
      items
        .map((it, i) => {
          const f = fenceFor(outs[i]);
          return `${it.header}\n${f}text\n${outs[i]}\n${f}`;
        })
        .join('\n') + (items.length ? '\n' : '') + tailText;

    const full = items.map((it) => it.output);
    const msg = compose(full);
    if (msg.length <= maxChars) return msg;
    // Overhead with the (upper-bound) fences of the untruncated outputs.
    const overhead = items.reduce((a, it) => a + it.header.length + 2 * fenceFor(it.output).length + 8, 0) + tailText.length;
    const budget = Math.max(0, maxChars - overhead);
    const alloc = allocate(full.map((s) => s.length), budget);
    const outs = full.map((s, i) => truncateTo(s, alloc[i]));
    let res = compose(outs);
    if (res.length > maxChars) {
      // Last resort (headers alone exceed the cap): keep markers only.
      res = compose(full.map((s) => truncMarker(s.length)));
      if (res.length > maxChars) res = res.slice(0, Math.max(0, maxChars - 1)) + '…';
    }
    return res;
  }

  DSG.protocol = {
    TOOL_DEFS,
    FOOTER,
    resolveTool,
    isMutating,
    registerTool,
    knownTools: () => Array.from(TOOLS.keys()),
    toolDef: (name) => {
      const r = resolveTool(name);
      return r ? r.def : null;
    },
    parseJsonLenient,
    sanitizeJson,
    scanBalanced,
    normalizeCall,
    parseBlock,
    parseHeaderForm,
    parseSearchReplace,
    findFencedBlocks,
    extractFromPlainText,
    extractCalls,
    isDevspaceLang,
    callSummary,
    statusText,
    formatResults,
    fenceFor,
    longestBacktickRun,
    truncMarker,
    hashString,
    hashCalls,
    stableStringify,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
