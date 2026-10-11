import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts, plain } from './_load.mjs';

const ctx = loadScripts(['content/protocol.js']);
const P = ctx.DSG.protocol;
const parse = (text, lang = 'devspace') => plain(P.parseBlock(text, lang));
const calls = (text, lang) => parse(text, lang).calls;

test('loads without DOM and exposes the API', () => {
  assert.equal(typeof P.parseBlock, 'function');
  assert.equal(typeof P.formatResults, 'function');
  assert.deepEqual(plain(P.knownTools()).sort(), [
    'apply_patch', 'edit_file', 'fetch_url', 'find_files', 'list_dir', 'open_workspace',
    'read_file', 'run_shell', 'search', 'show_changes', 'write_file',
  ]);
});

test('JSON form: canonical', () => {
  assert.deepEqual(calls('{"tool": "read_file", "args": {"path": "src/app.ts", "offset": 1, "limit": 200}}'), [
    { tool: 'read_file', args: { path: 'src/app.ts', offset: 1, limit: 200 } },
  ]);
});

test('JSON form: name / tool_name / function.name and args synonyms', () => {
  const want = [{ tool: 'read_file', args: { path: 'a.txt' } }];
  assert.deepEqual(calls('{"name": "read_file", "arguments": {"path": "a.txt"}}'), want);
  assert.deepEqual(calls('{"tool_name": "read_file", "parameters": {"path": "a.txt"}}'), want);
  assert.deepEqual(calls('{"function": {"name": "read_file", "arguments": "{\\"path\\": \\"a.txt\\"}"}}'), want);
  assert.deepEqual(calls('{"tool": "read_file", "input": {"path": "a.txt"}}'), want);
  assert.deepEqual(calls('{"tool": "read_file", "arguments": "{\\"path\\": \\"a.txt\\"}"}'), want);
});

test('JSON form: args at top level', () => {
  assert.deepEqual(calls('{"tool": "list_dir", "path": "src", "depth": 2}'), [{ tool: 'list_dir', args: { path: 'src', depth: 2 } }]);
});

test('JSON form: array of calls and calls wrapper', () => {
  const t = '[{"tool":"read_file","args":{"path":"a"}}, {"tool":"ls","args":{"path":"."}}]';
  assert.deepEqual(calls(t), [
    { tool: 'read_file', args: { path: 'a' } },
    { tool: 'list_dir', args: { path: '.' } },
  ]);
  assert.deepEqual(calls('{"tool_calls": [{"name": "cat", "args": {"path": "x"}}]}'), [{ tool: 'read_file', args: { path: 'x' } }]);
});

test('JSON form: comments and trailing commas', () => {
  const t = `{
    // read the entry point
    "tool": "read_file", /* block comment */
    "args": { "path": "src/index.ts", "limit": 50, },
  }`;
  assert.deepEqual(calls(t), [{ tool: 'read_file', args: { path: 'src/index.ts', limit: 50 } }]);
});

test('JSON form: single backslashes in Windows paths', () => {
  assert.deepEqual(calls('{"tool": "open_workspace", "args": {"path": "C:\\Users\\x\\project"}}'), [
    { tool: 'open_workspace', args: { path: 'C:\\Users\\x\\project' } },
  ]);
  // \n and \t inside a drive path must stay literal, not become newline/tab
  assert.deepEqual(calls('{"tool": "list_dir", "args": {"path": "C:\\new\\temp"}}'), [
    { tool: 'list_dir', args: { path: 'C:\\new\\temp' } },
  ]);
  // properly escaped paths are untouched
  assert.deepEqual(calls('{"tool": "list_dir", "args": {"path": "C:\\\\Users\\\\x"}}'), [
    { tool: 'list_dir', args: { path: 'C:\\Users\\x' } },
  ]);
  // command strings with a drive path in the middle
  assert.deepEqual(calls('{"tool": "run_shell", "args": {"command": "dir D:\\work\\repo"}}'), [
    { tool: 'run_shell', args: { command: 'dir D:\\work\\repo' } },
  ]);
});

test('JSON form: normal escapes still decode, invalid escapes survive', () => {
  assert.deepEqual(calls('{"tool": "write_file", "args": {"path": "a.txt", "content": "line1\\nline2\\t\\"q\\""}}'), [
    { tool: 'write_file', args: { path: 'a.txt', content: 'line1\nline2\t"q"' } },
  ]);
  assert.deepEqual(calls('{"tool": "search", "args": {"query": "\\d+\\s", "regex": true}}'), [
    { tool: 'search', args: { query: '\\d+\\s', regex: true } },
  ]);
});

test('JSON form: raw newlines in strings, single quotes, Python literals', () => {
  assert.deepEqual(calls('{"tool": "run_shell", "args": {"command": "echo a\necho b"}}'), [
    { tool: 'run_shell', args: { command: 'echo a\necho b' } },
  ]);
  assert.deepEqual(calls("{'tool': 'list_dir', 'args': {'path': '.', 'all': True}}"), [
    { tool: 'list_dir', args: { path: '.', all: true } },
  ]);
});

test('JSON form: several objects in one block', () => {
  const t = '{"tool":"read_file","args":{"path":"a"}}\n{"tool":"read_file","args":{"path":"b"}}';
  assert.deepEqual(calls(t).map((c) => c.args.path), ['a', 'b']);
});

test('aliases map to canonical names; powershell sets shell', () => {
  const pairs = {
    open: 'open_workspace', cd: 'open_workspace', ls: 'list_dir', list: 'list_dir', glob: 'find_files', find: 'find_files',
    read: 'read_file', cat: 'read_file', view: 'read_file', write: 'write_file', create_file: 'write_file', edit: 'edit_file',
    str_replace: 'edit_file', patch: 'apply_patch', bash: 'run_shell', shell: 'run_shell', exec: 'run_shell', run: 'run_shell',
    grep: 'search', rg: 'search', git_diff: 'show_changes', diff: 'show_changes', git_status: 'show_changes',
    fetch: 'fetch_url', open_url: 'fetch_url', 'devspace.read_file': 'read_file', 'Read-File': 'read_file',
  };
  for (const [alias, canon] of Object.entries(pairs)) {
    assert.equal(P.resolveTool(alias).tool, canon, alias);
  }
  assert.deepEqual(calls('{"tool": "powershell", "args": {"command": "Get-ChildItem"}}'), [
    { tool: 'run_shell', args: { command: 'Get-ChildItem', shell: 'powershell' } },
  ]);
});

test('unknown tools and prose are rejected', () => {
  assert.deepEqual(calls('{"tool": "delete_everything", "args": {}}'), []);
  assert.match(parse('{"tool": "delete_everything", "args": {}}').error, /unknown tool "delete_everything"/);
  assert.deepEqual(calls('Here is how you would do it: run the tests.'), []);
  assert.deepEqual(calls('{"foo": 1}'), []);
  assert.deepEqual(calls('const x = {"tool": "read_file"};', 'js'), []);
  assert.deepEqual(calls('tool: frobnicate\npath: x'), []);
  assert.deepEqual(calls('def f():\n    return 1', 'python'), []);
});

test('language label is a hint, not a requirement', () => {
  assert.equal(calls('{"tool":"read_file","args":{"path":"a"}}', '').length, 1);
  assert.equal(calls('{"tool":"read_file","args":{"path":"a"}}', 'json').length, 1);
  assert.equal(calls('tool: read_file\npath: a', 'yaml').length, 1);
});

test('header form: key/value conversion and body after ---', () => {
  assert.deepEqual(calls('tool: write_file\npath: src/hello.py\n---\nprint("hi")\n'), [
    { tool: 'write_file', args: { path: 'src/hello.py', content: 'print("hi")\n' } },
  ]);
  assert.deepEqual(calls('tool: list_dir\npath: src\ndepth: 2\nall: true'), [
    { tool: 'list_dir', args: { path: 'src', depth: 2, all: true } },
  ]);
  assert.deepEqual(calls('tool: read_file\npath: "dir with space/a.txt"\noffset: -5'), [
    { tool: 'read_file', args: { path: 'dir with space/a.txt', offset: -5 } },
  ]);
});

test('header form: body keeps ``` and inner --- lines; command trimmed', () => {
  const body = '# Title\n\n```js\nconst a = 1;\n```\n---\nfooter\n';
  assert.deepEqual(calls('tool: write_file\npath: README.md\n---\n' + body), [
    { tool: 'write_file', args: { path: 'README.md', content: body } },
  ]);
  assert.deepEqual(calls('tool: run_shell\ntimeout: 300\n---\n  npm test -- --watch=false  \n'), [
    { tool: 'run_shell', args: { timeout: 300, command: 'npm test -- --watch=false' } },
  ]);
  assert.deepEqual(calls('tool: powershell\n---\nGet-Process | Select -First 3'), [
    { tool: 'run_shell', args: { shell: 'powershell', command: 'Get-Process | Select -First 3' } },
  ]);
});

test('header form: Windows path values are literal', () => {
  assert.deepEqual(calls('tool: open_workspace\npath: C:\\Users\\x\\new'), [
    { tool: 'open_workspace', args: { path: 'C:\\Users\\x\\new' } },
  ]);
});

test('header form: apply_patch body', () => {
  const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch';
  assert.deepEqual(calls('tool: apply_patch\n---\n' + patch + '\n\n'), [{ tool: 'apply_patch', args: { patch: patch + '\n' } }]);
});

test('header form without --- (lenient body for bodyParam tools)', () => {
  assert.deepEqual(calls('tool: run_shell\nls -la && git status'), [{ tool: 'run_shell', args: { command: 'ls -la && git status' } }]);
  assert.deepEqual(calls('tool: read_file\nthis is not key value'), []);
});

test('header form: body param given as a header with an empty --- body keeps the header (seen live on Gemini)', () => {
  assert.deepEqual(calls('tool: run_shell\ncommand: node -v\n---\n'), [{ tool: 'run_shell', args: { command: 'node -v' } }]);
  assert.deepEqual(calls('tool: write_file\npath: a.txt\ncontent: hi\n---\n'), [{ tool: 'write_file', args: { path: 'a.txt', content: 'hi' } }]);
  // an empty body without a header value still means "empty file"
  assert.deepEqual(calls('tool: write_file\npath: a.txt\n---\n'), [{ tool: 'write_file', args: { path: 'a.txt', content: '' } }]);
});

test('header form: edit_file with multiple SEARCH/REPLACE blocks', () => {
  const t = [
    'tool: edit_file',
    'path: src/app.ts',
    '---',
    '<<<<<<< SEARCH',
    'const a = 1;',
    '=======',
    'const a = 2;',
    '>>>>>>> REPLACE',
    '',
    '<<<<<<< SEARCH',
    'function f() {',
    '  return a;',
    '}',
    '=======',
    '>>>>>>> REPLACE',
    '<<<<<<<<< SEARCH',
    '',
    '=========',
    'added',
    '>>>>>>>>> REPLACE',
  ].join('\n');
  assert.deepEqual(calls(t), [
    {
      tool: 'edit_file',
      args: {
        path: 'src/app.ts',
        edits: [
          { old_text: 'const a = 1;', new_text: 'const a = 2;' },
          { old_text: 'function f() {\n  return a;\n}', new_text: '' },
          { old_text: '', new_text: 'added' },
        ],
      },
    },
  ]);
});

test('header form: replace_all applies to every edit; CRLF input', () => {
  const t = 'tool: edit\r\npath: a.txt\r\nreplace_all: true\r\n---\r\n<<<<<<< SEARCH\r\nfoo\r\n=======\r\nbar\r\n>>>>>>> REPLACE\r\n';
  assert.deepEqual(calls(t), [
    { tool: 'edit_file', args: { path: 'a.txt', edits: [{ old_text: 'foo', new_text: 'bar', replace_all: true }] } },
  ]);
});

test('header form: unterminated SEARCH block is an error', () => {
  const r = parse('tool: edit_file\npath: a\n---\n<<<<<<< SEARCH\nfoo\n=======\nbar\n');
  assert.deepEqual(r.calls, []);
  assert.match(r.error, /unterminated/);
});

test('rendered block that still contains the fence / language label', () => {
  assert.equal(calls('```devspace\n{"tool":"read_file","args":{"path":"a"}}\n```').length, 1);
  assert.equal(calls('devspace\n{"tool":"read_file","args":{"path":"a"}}').length, 1);
  assert.equal(calls('\u00a0{"tool":\u00a0"read_file","args":{"path":"a"}}\u200b').length, 1);
});

test('extractCalls: blocks win, invalid devspace blocks are reported', () => {
  const r = plain(P.extractCalls(
    [
      { text: '{"tool":"read_file","args":{"path":"a"}}', lang: 'devspace' },
      { text: 'npm install', lang: 'bash' },
      { text: '{"tool":"nope"}', lang: 'devspace' },
      { text: '{"tool": "read_file", "args": {', lang: 'devspace' },
    ],
    'ignored plain text {"tool":"ls","args":{}}'
  ));
  assert.deepEqual(r.calls, [{ tool: 'read_file', args: { path: 'a' } }]);
  assert.equal(r.invalid.length, 2);
  assert.match(r.invalid[0].error, /unknown tool "nope"/);
});

test('extractCalls: plain-text fallback finds balanced {"tool": ...} objects', () => {
  const text = 'I will read the file now.\n{"tool": "read_file", "args": {"path": "src/{weird}.ts"}} and then list {"tool":"ls","args":{"path":"."}}. Done {not json}.';
  const r = plain(P.extractCalls([], text));
  assert.deepEqual(r.calls, [
    { tool: 'read_file', args: { path: 'src/{weird}.ts' } },
    { tool: 'list_dir', args: { path: '.' } },
  ]);
  assert.deepEqual(plain(P.extractCalls([], 'No tools here. {"a": 1}')).calls, []);
});

test('extractCalls: plain-text fallback understands fenced blocks incl. 4-backtick bodies', () => {
  const text = [
    'Writing the README.',
    '````devspace',
    'tool: write_file',
    'path: README.md',
    '---',
    '# Demo',
    '```sh',
    'npm test',
    '```',
    '````',
    'Then run tests:',
    '```devspace',
    '{"tool": "run_shell", "args": {"command": "npm test"}}',
    '```',
  ].join('\n');
  const r = plain(P.extractCalls([], text));
  assert.deepEqual(r.calls, [
    { tool: 'write_file', args: { path: 'README.md', content: '# Demo\n```sh\nnpm test\n```\n' } },
    { tool: 'run_shell', args: { command: 'npm test' } },
  ]);
});

test('findFencedBlocks honours fence length and tildes', () => {
  const b = plain(P.findFencedBlocks('`````md\n````\ninner\n````\n`````\n~~~devspace\ntool: ls\n~~~'));
  assert.deepEqual(b, [
    { text: '````\ninner\n````', lang: 'md' },
    { text: 'tool: ls', lang: 'devspace' },
  ]);
});

test('hashCalls is order-insensitive for keys and distinguishes calls', () => {
  const a = P.hashCalls([{ tool: 'read_file', args: { path: 'a', limit: 1 } }]);
  const b = P.hashCalls([{ tool: 'read_file', args: { limit: 1, path: 'a' } }]);
  const c = P.hashCalls([{ tool: 'read_file', args: { path: 'b', limit: 1 } }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('callSummary formats', () => {
  assert.equal(P.callSummary({ tool: 'read_file', args: { path: 'src/app.ts' } }), 'read_file path=src/app.ts');
  assert.equal(P.callSummary({ tool: 'run_shell', args: { command: 'npm test' } }), 'run_shell `npm test`');
  assert.equal(P.callSummary({ tool: 'write_file', args: { path: 'a.py', content: 'x\ny\n' } }), 'write_file path=a.py (2 lines)');
  assert.equal(
    P.callSummary({ tool: 'edit_file', args: { path: 'a', edits: [{ old_text: 'a', new_text: 'b' }] } }),
    'edit_file path=a (1 edit)'
  );
  assert.equal(
    P.callSummary({ tool: 'apply_patch', args: { patch: '*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n*** End Patch' } }),
    'apply_patch files=a.ts,b.ts'
  );
});
