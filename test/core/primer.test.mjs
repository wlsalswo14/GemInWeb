import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildPrimer, contextBlock, PROTOCOL_MARKER, staticPrimer } from '../../core/primer.mjs';
import { parseSearchReplace, resolveToolName, TOOL_DEFS } from '../../core/tools.mjs';
import { call, REPO_ROOT, sandbox, sandboxEngine } from './helpers.mjs';

/** Extract fenced code blocks (any fence length ≥ 3) → [{ lang, body }]. */
function fencedBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})(\w*)\s*$/.exec(lines[i]);
    if (!open) continue;
    const fence = open[1];
    const body = [];
    let j = i + 1;
    while (j < lines.length && lines[j] !== fence) body.push(lines[j++]);
    if (j >= lines.length) continue;
    blocks.push({ lang: open[2], body: body.join('\n') });
    i = j;
  }
  return blocks;
}

/** Minimal reference implementation of the spec's protocol parser (JSON form + header form). */
function parseCall(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    const def = resolveToolName(obj.tool ?? obj.name);
    return { tool: def?.name, args: obj.args ?? obj.arguments ?? {} };
  }
  const lines = body.split('\n');
  const sep = lines.indexOf('---');
  const headerLines = sep === -1 ? lines : lines.slice(0, sep);
  const args = {};
  let tool;
  for (const line of headerLines) {
    if (!line.trim()) continue;
    const m = /^([\w-]+):\s?(.*)$/.exec(line);
    assert.ok(m, `bad header line: ${line}`);
    let v = m[2].trim();
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^-?\d+$/.test(v)) v = Number(v);
    if (m[1] === 'tool') tool = v;
    else args[m[1]] = v;
  }
  const def = resolveToolName(tool);
  assert.ok(def, `unknown tool ${tool}`);
  if (sep !== -1) {
    const bodyText = lines.slice(sep + 1).join('\n');
    if (def.name === 'edit_file') {
      args.edits = parseSearchReplace(bodyText);
    } else {
      args[def.bodyParam] = bodyText;
    }
  }
  return { tool: def.name, args };
}

describe('primer', () => {
  let sb;
  before(() => {
    sb = sandbox();
  });
  after(() => sb.cleanup());

  it('static primer starts with the marker, documents every tool and rule', () => {
    const p = staticPrimer();
    assert.equal(p.split('\n')[0], PROTOCOL_MARKER);
    for (const def of TOOL_DEFS) assert.ok(p.includes(`- ${def.name}(`), def.name);
    for (const needle of ['STOP and wait', 'Batch independent read-only', 'NO devspace block', "user's language", 'Git Bash', '````devspace', '<<<<<<< SEARCH', '>>>>>>> REPLACE', '---']) {
      assert.ok(p.includes(needle), needle);
    }
  });

  it('examples in the primer parse under the protocol and are valid calls', async () => {
    const blocks = fencedBlocks(staticPrimer()).filter((b) => b.lang === 'devspace');
    assert.ok(blocks.length >= 3);
    const calls = blocks.map((b) => parseCall(b.body));
    assert.deepEqual(calls[0], { tool: 'read_file', args: { path: 'src/app.py', offset: 1, limit: 200 } });
    assert.deepEqual(calls[1], { tool: 'write_file', args: { path: 'src/hello.py', content: 'print("hello")' } });
    assert.deepEqual(calls[2], { tool: 'edit_file', args: { path: 'src/hello.py', edits: [{ old_text: 'print("hello")', new_text: 'print("hello, world")' }] } });
    // and they actually run, in order, against the core
    const engine = sandboxEngine(sb);
    sb.write('src/app.py', 'print("app")\n');
    const w = await call(engine, calls[1].tool, calls[1].args);
    assert.equal(w.ok, true, w.output);
    const e = await call(engine, calls[2].tool, calls[2].args);
    assert.equal(e.ok, true, e.output);
    const r = await call(engine, calls[0].tool, calls[0].args);
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /print\("app"\)/);
    const h = await call(engine, 'read_file', { path: 'src/hello.py' });
    assert.match(h.output, /print\("hello, world"\)/);
  });

  it('full primer stays ≤ 6000 chars even with a huge AGENTS.md; excerpt ≤ 1500', async () => {
    sb.write('AGENTS.md', `# Rules\n${'Always write tests. '.repeat(600)}`);
    const info = { workspace: sb.ws, allowedRoots: [sb.ws], shell: { kind: 'bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe' } };
    for (const site of ['aistudio', 'gemini', 'generic']) {
      const { text, marker } = await buildPrimer({ mode: 'full', site, info });
      assert.equal(marker, PROTOCOL_MARKER);
      assert.ok(text.length <= 6000, `${site}: ${text.length}`);
      assert.ok(text.startsWith(`${PROTOCOL_MARKER}\n`));
      assert.match(text, /\[DevSpace context\]/);
      assert.match(text, /Project instructions \(AGENTS\.md, excerpt\):\n# Rules/);
    }
    const ctx = await contextBlock(info);
    const excerpt = ctx.split('excerpt):\n')[1];
    assert.ok(excerpt.length <= 1500 + 20, String(excerpt.length));
    assert.match(ctx, /^\[DevSpace context\]\nTime: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(ctx, /OS: .+ · shell: /);
    assert.match(ctx, /Allowed roots: /);
  });

  it('context mode returns only the context block', async () => {
    const { text, marker } = await buildPrimer({ mode: 'context', site: 'gemini', info: { workspace: null, workspaceError: 'x', allowedRoots: [], shell: null } });
    assert.equal(marker, '[DevSpace context]');
    assert.doesNotMatch(text, /protocol v1/);
    assert.match(text, /call open_workspace/);
  });

  it('gem/GEM_INSTRUCTIONS.md contains the current static primer', () => {
    const md = readFileSync(join(REPO_ROOT, 'gem', 'GEM_INSTRUCTIONS.md'), 'utf8');
    assert.ok(md.includes(staticPrimer()), 'run npm run gen:gem');
    assert.match(md, /New Gem/);
    assert.match(md, /System instructions/);
  });
});
