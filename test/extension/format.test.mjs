import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScripts } from './_load.mjs';

const P = loadScripts(['content/protocol.js']).DSG.protocol;

const rRead = { call: { tool: 'read_file', args: { path: 'src/app.ts' } }, ok: true, output: '     1\thello\n', durationMs: 15 };
const rShell = {
  call: { tool: 'run_shell', args: { command: 'npm test' } },
  ok: false,
  output: '$ npm test\n[cwd: C:\\x · shell: bash]\nFAIL\n[exit 1 · 3.2s]',
  durationMs: 3200,
};

test('result message layout matches the spec', () => {
  const msg = P.formatResults([rRead, rShell]);
  assert.equal(
    msg,
    [
      '[DevSpace result 1/2] read_file path=src/app.ts — ok (15 ms)',
      '```text',
      '     1\thello',
      '```',
      '[DevSpace result 2/2] run_shell `npm test` — error (exit 1, 3.2 s)',
      '```text',
      '$ npm test',
      '[cwd: C:\\x · shell: bash]',
      'FAIL',
      '[exit 1 · 3.2s]',
      '```',
      'Continue the task: call more tools with ```devspace blocks, or answer normally (no devspace block) when the task is done.',
    ].join('\n')
  );
});

test('status variants: denied, cancelled, truncated, empty output, notes', () => {
  const msg = P.formatResults(
    [
      { call: { tool: 'run_shell', args: { command: 'rm -rf /' } }, ok: false, denied: true, output: 'The user denied this call.' },
      { call: { tool: 'run_shell', args: { command: 'sleep 99' } }, ok: false, cancelled: true, output: '' },
      { call: { tool: 'read_file', args: { path: 'big' } }, ok: true, truncated: true, output: 'x', durationMs: 1500 },
    ],
    { notes: ['[DevSpace note] something'] }
  );
  assert.match(msg, /^\[DevSpace result 1\/3\] run_shell `rm -rf \/` — denied\n/);
  assert.match(msg, /\[DevSpace result 2\/3\] run_shell `sleep 99` — cancelled\n```text\n\(no output\)\n```/);
  assert.match(msg, /— ok \(1\.5 s, output truncated\)/);
  assert.match(msg, /\n\[DevSpace note\] something\nContinue the task:/);
});

test('notes only (no results)', () => {
  const msg = P.formatResults([], { notes: ['[DevSpace note] bad block'] });
  assert.equal(msg, '[DevSpace note] bad block\n' + P.FOOTER);
});

test('fence is longer than the longest backtick run in the output', () => {
  const out = 'before\n```js\ncode\n```\nand ````` five';
  const msg = P.formatResults([{ call: { tool: 'read_file', args: { path: 'a.md' } }, ok: true, output: out, durationMs: 1 }]);
  assert.ok(msg.includes('``````text\n' + out + '\n``````\n'), msg);
  assert.equal(P.fenceFor('no ticks'), '```');
  assert.equal(P.fenceFor('a `b` c'), '```');
  assert.equal(P.fenceFor('````'), '`````');
});

test('message cap truncates proportionally with a marker and respects the limit', () => {
  const big = 'A'.repeat(50000);
  const mid = 'B'.repeat(20000);
  const small = 'small output';
  const results = [
    { call: { tool: 'read_file', args: { path: 'big' } }, ok: true, output: big, durationMs: 1 },
    { call: { tool: 'read_file', args: { path: 'mid' } }, ok: true, output: mid, durationMs: 1 },
    { call: { tool: 'read_file', args: { path: 'small' } }, ok: true, output: small, durationMs: 1 },
  ];
  const max = 24000;
  const msg = P.formatResults(results, { maxChars: max });
  assert.ok(msg.length <= max, `length ${msg.length}`);
  assert.ok(msg.length > max - 400, `budget mostly used: ${msg.length}`);
  assert.ok(msg.includes('```text\nsmall output\n```'), 'small output kept whole');
  const markers = msg.match(/\[… (\d+) chars truncated — narrow the request or use offset\/limit …\]/g);
  assert.equal(markers.length, 2);
  // Each truncated output keeps head + tail and reports the exact number removed.
  const bigPart = msg.split('[DevSpace result 2/3]')[0];
  const keptA = (bigPart.match(/A/g) || []).length;
  const removedA = Number(/\[… (\d+) chars truncated/.exec(bigPart)[1]);
  assert.equal(keptA + removedA, big.length);
  assert.ok(msg.endsWith(P.FOOTER));
});

test('under the cap nothing is truncated', () => {
  const msg = P.formatResults([rRead], { maxChars: 1000 });
  assert.ok(!msg.includes('truncated'));
});

test('tiny cap still produces a bounded message', () => {
  const msg = P.formatResults([{ ...rRead, output: 'x'.repeat(5000) }], { maxChars: 300 });
  assert.ok(msg.length <= 300, String(msg.length));
});

test('fence is computed after truncation and never broken by it', () => {
  const out = 'x'.repeat(10000) + '\n`````\n' + 'y'.repeat(10000);
  const msg = P.formatResults([{ call: { tool: 'read_file', args: { path: 'a' } }, ok: true, output: out, durationMs: 1 }], {
    maxChars: 3000,
  });
  const m = /\n(`{3,})text\n/.exec(msg);
  const fence = m[1];
  const inner = msg.slice(m.index + m[0].length, msg.lastIndexOf('\n' + fence + '\n'));
  assert.ok(P.longestBacktickRun(inner) < fence.length);
  assert.ok(msg.length <= 3000);
});
