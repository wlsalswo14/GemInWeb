import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { findGit } from '../../core/shell.mjs';
import { htmlToText } from '../../core/tools.mjs';
import { call, sandbox, sandboxEngine } from './helpers.mjs';

const GIT = findGit();

describe('show_changes', { skip: !GIT && 'git not installed' }, () => {
  let sb;
  let engine;
  before(() => {
    sb = sandbox();
    engine = sandboxEngine(sb);
    const git = (...args) => execFileSync(GIT, args, { cwd: sb.ws, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.autocrlf', 'false');
    sb.write('tracked.txt', 'one\ntwo\n');
    sb.write('other.txt', 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });
  after(() => sb.cleanup());

  it('reports a clean tree', async () => {
    const r = await call(engine, 'show_changes');
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /branch main/);
    assert.match(r.output, /Working tree clean/);
  });

  it('shows status, diff stat, diff and untracked files', async () => {
    sb.write('tracked.txt', 'one\nTWO\n');
    sb.write('fresh.txt', 'new\n');
    const r = await call(engine, 'git_diff');
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /## git status --short\n M tracked\.txt\n\?\? fresh\.txt/);
    assert.match(r.output, /## git diff --stat\n tracked\.txt \| 2 \+-/);
    assert.match(r.output, /## git diff\n[\s\S]*-two\n\+TWO/);
    assert.match(r.output, /## untracked files \(1\)\nfresh\.txt/);
    const scoped = await call(engine, 'diff', { path: 'other.txt' });
    assert.match(scoped.output, /Working tree clean/);
  });

  it('open_workspace shows the branch and changes', async () => {
    const r = await call(engine, 'open', { path: sb.ws });
    assert.match(r.output, /Git: branch main — 2 changed\/untracked/);
  });

  it('fails outside a repository', async () => {
    const sb2 = sandbox();
    try {
      const e2 = sandboxEngine(sb2);
      const r = await call(e2, 'show_changes');
      assert.equal(r.ok, false);
      assert.match(r.output, /Not a git repository/);
    } finally {
      sb2.cleanup();
    }
  });
});

describe('fetch_url (local server)', () => {
  let sb;
  let engine;
  let server;
  let base;
  before(async () => {
    sb = sandbox();
    engine = sandboxEngine(sb);
    server = createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Demo &amp; Page</title><style>.x{color:red}</style>
          <script>var secret = 1;</script></head><body><nav>Menu Home About</nav>
          <h1>Hello&nbsp;World</h1><p>First   paragraph &lt;b&gt; &#xD55C;&#44544;</p>
          <ul><li>one</li><li>two</li></ul></body></html>`);
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/page' });
        res.end();
      } else if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"a":1}');
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('z'.repeat(50000));
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 5000);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    sb.cleanup();
  });

  it('converts HTML to readable text with a header line', async () => {
    const r = await call(engine, 'fetch_url', { url: `${base}/page` });
    assert.equal(r.ok, true, r.output);
    const [header] = r.output.split('\n');
    assert.equal(header, `HTTP 200 ${base}/page (text/html; charset=utf-8)`);
    assert.match(r.output, /Title: Demo & Page/);
    assert.match(r.output, /# Hello World/);
    assert.match(r.output, /First paragraph <b> 한글/);
    assert.match(r.output, /- one\n- two/);
    assert.doesNotMatch(r.output, /secret|color:red|Menu Home/);
  });

  it('follows redirects and reports the final URL', async () => {
    const r = await call(engine, 'fetch', { url: `${base}/redirect` });
    assert.match(r.output, new RegExp(`^HTTP 200 ${base}/page `));
  });

  it('returns non-HTML bodies as-is, caps with max_chars, flags HTTP errors', async () => {
    const j = await call(engine, 'open_url', { url: `${base}/json` });
    assert.match(j.output, /\n\n\{"a":1\}$/);
    const big = await call(engine, 'fetch_url', { url: `${base}/big`, max_chars: 1000 });
    assert.equal(big.truncated, true);
    assert.ok(big.output.length < 1300);
    const nf = await call(engine, 'fetch_url', { url: `${base}/missing` });
    assert.equal(nf.ok, false);
    assert.match(nf.output, /^HTTP 404 /);
  });

  it('rejects non-http schemes and can be cancelled', async () => {
    const f = await call(engine, 'fetch_url', { url: 'file:///C:/Windows/win.ini' });
    assert.equal(f.ok, false);
    const pending = engine.handle({ id: 'slow-1', type: 'call', tool: 'fetch_url', args: { url: `${base}/slow` } });
    await new Promise((r) => setTimeout(r, 200));
    await engine.handle({ id: 'cx', type: 'cancel', target: 'slow-1' });
    const res = await pending;
    assert.equal(res.result.ok, false);
    assert.equal(res.result.cancelled, true);
  });

  it('htmlToText decodes entities and drops scripts', () => {
    assert.equal(htmlToText('<p>a&amp;b</p><script>x</script><p>c&#39;d</p>'), 'a&b\n\nc\'d');
    assert.equal(htmlToText('<ul><li>x</li><li>y</li></ul>'), '- x\n- y');
  });
});
