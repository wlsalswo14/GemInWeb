// Runs the real site adapters with the real DSG.SELECTORS (agent C) against the
// HTML fixtures in test/fixtures/, using the zero-dependency mini DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXT, loadScripts, plain } from './_load.mjs';
import { parseHTML, makeWindow } from './_minidom.mjs';

const FIX = join(EXT, '..', 'test', 'fixtures');
const have = existsSync(join(EXT, 'content', 'selectors.js')) && existsSync(join(FIX, 'gemini-chat.html'));
const opts = { skip: have ? false : 'selectors.js / fixtures not present' };

function load(site, file, href) {
  const doc = parseHTML(readFileSync(join(FIX, file), 'utf8'));
  const ctx = loadScripts(['content/selectors.js', 'content/protocol.js', 'content/sites.js', 'content/agent.js']);
  const win = makeWindow(doc, href);
  const adapter = ctx.DSG.createSiteAdapter(site, { win, doc, sleep: async () => {} });
  return { doc, ctx, adapter, win, DSG: ctx.DSG };
}
const tpl = (doc, id) => doc.querySelectorAllIncludingTemplates('template').find((t) => t.id === id).content.cloneNode(true);
const firstEl = (frag) => frag.childNodes.find((n) => n.nodeType === 1);

// ------------------------------------------------------------------ Gemini
test('gemini fixture: turns, blocks, text, completion', opts, () => {
  const { adapter, DSG } = load('gemini', 'gemini-chat.html', 'https://gemini.google.com/app/0123456789abcdef');
  const turns = adapter.getTurns();
  assert.deepEqual(plain(turns.map((t) => t.role)), ['user', 'model']);
  const model = turns[1].el;
  const blocks = plain(adapter.getModelBlocks(model));
  assert.deepEqual(blocks, [{ text: '{"tool":"list_dir","args":{"path":"."}}\n', lang: '코드 스니펫' }]);
  const text = adapter.turnText(model);
  assert.ok(!text.includes('코드 스니펫'), 'code header excluded');
  assert.ok(!text.includes('Gemini의 응답'), 'screen-reader label excluded');
  const ex = plain(DSG.protocol.extractCalls(blocks, text));
  assert.deepEqual(ex.calls, [{ tool: 'list_dir', args: { path: '.' } }]);
  assert.equal(adapter.isGenerating(), false);
  assert.equal(adapter.isTurnComplete(model), true);
  assert.equal(adapter.conversationKey(), 'gemini:0123456789abcdef');
  assert.equal(adapter.isNewChat(), false);
  // the user's pasted example is only in the user turn, which is never scanned for calls
  assert.ok(adapter.turnText(turns[0].el).includes('USER_PASTED_EXAMPLE'));
});

test('gemini fixture: thoughts are excluded from blocks and text', opts, () => {
  const { doc, adapter, DSG } = load('gemini', 'gemini-chat.html', 'https://gemini.google.com/app/0123456789abcdef');
  doc.querySelector('model-response .response-content').prepend(firstEl(tpl(doc, 'tpl-model-thoughts')));
  const model = adapter.getTurns()[1].el;
  const blocks = plain(adapter.getModelBlocks(model));
  const text = adapter.turnText(model);
  assert.equal(blocks.length, 1);
  assert.ok(!text.includes('THOUGHT'), text);
  const ex = plain(DSG.protocol.extractCalls(blocks, text));
  assert.deepEqual(ex.calls.map((c) => c.tool), ['list_dir']);
});

test('gemini fixture: streaming turn is generating and not complete; send slot states', opts, () => {
  const { doc, adapter } = load('gemini', 'gemini-chat.html', 'https://gemini.google.com/app/0123456789abcdef');
  doc.querySelector('div.conversation-container').appendChild(firstEl(tpl(doc, 'tpl-model-response-streaming')));
  const turns = adapter.getTurns();
  assert.deepEqual(plain(turns.map((t) => t.role)), ['user', 'model', 'model']);
  assert.equal(adapter.isGenerating(), true, 'aria-busy / animating');
  assert.equal(adapter.isTurnComplete(turns[2].el), false);

  // input + send slot
  const input = adapter.getInput();
  assert.ok(input && input.classList.contains('ql-editor'));
  const slot = doc.querySelector('.input-buttons-wrapper-bottom');
  assert.equal(adapter._internal.q('sendButton'), null, 'no send slot while empty');
  slot.appendChild(firstEl(tpl(doc, 'tpl-send-slot-idle')));
  assert.equal(adapter._internal.q('sendButton').getAttribute('aria-label'), '메시지 보내기');
  assert.equal(adapter._internal.q('stopButton'), null);
  slot.querySelector('[data-test-id="send-button-container"]').remove();
  slot.appendChild(firstEl(tpl(doc, 'tpl-send-slot-generating')));
  assert.equal(adapter._internal.q('sendButton'), null, 'stop state is not a send button');
  assert.equal(adapter._internal.q('stopButton').getAttribute('aria-label'), '대답 생성 중지');
});

test('gemini fixture: new chat URL and gem URLs', opts, () => {
  assert.equal(load('gemini', 'gemini-chat.html', 'https://gemini.google.com/app').adapter.isNewChat(), true);
  const g = load('gemini', 'gemini-chat.html', 'https://gemini.google.com/gem/my-gem/4b07f16c074c5252').adapter;
  assert.equal(g.conversationKey(), 'gemini:4b07f16c074c5252');
});

test('gemini fixture: agent end-to-end — history baselined, streamed reply runs once complete', opts, async () => {
  const { doc, adapter, DSG } = load('gemini', 'gemini-chat.html', 'https://gemini.google.com/app/0123456789abcdef');
  const clock = { t: 0, now: () => clock.t, sleep: async (ms) => void (clock.t += ms) };
  const calls = [];
  const sent = [];
  // DOM input/sending is exercised live; here the agent's transport to the page is faked.
  const a = Object.assign({}, adapter, {
    setInput: async (t) => ((a._input = t), true),
    getInputText: () => a._input || '',
    send: async () => (sent.push(a._input), (a._input = ''), true),
  });
  const agent = DSG.createAgent({
    adapter: a,
    protocol: DSG.protocol,
    clock,
    settings: { approval: 'auto' },
    rpc: {
      newId: () => 'id' + calls.length,
      call: async (tool, args) => (calls.push({ tool, args: plain(args) }), { ok: true, output: 'listing', durationMs: 3 }),
      cancel: async () => {},
      primer: async () => ({ text: 'P' }),
    },
  });
  await agent.init();
  await agent.setOn(true);
  const step = async (ms = 600) => {
    clock.t += ms;
    await agent.tick();
    await agent.whenIdle();
  };
  for (let i = 0; i < 5; i++) await step();
  assert.equal(calls.length, 0, 'completed historic turn is not executed');

  const conv = doc.querySelector('div.conversation-container');
  // the user sends a new message (ends the baseline), then a reply streams in
  const uq = doc.createElement('user-query');
  uq.textContent = 'list the files';
  conv.appendChild(uq);
  await step();
  assert.equal(agent.getState().baseline, false);
  const streaming = firstEl(tpl(doc, 'tpl-model-response-streaming'));
  conv.appendChild(streaming);
  await step();
  assert.equal(agent.getState().status, 'waiting');
  // stream ends: busy flags clear, but the footer is not complete yet (stop button gone ~3.5 s early)
  const md = streaming.querySelector('.markdown');
  md.setAttribute('aria-busy', 'false');
  md.classList.remove('animate');
  streaming.querySelector('response-element').classList.remove('animating');
  streaming.querySelector('code').textContent = '{"tool":"read_file","args":{"path":"README.md"}}\n';
  for (let i = 0; i < 6; i++) await step();
  assert.equal(calls.length, 0, 'waits for turnComplete');
  streaming.querySelector('.response-footer').classList.add('complete');
  await step();
  assert.equal(calls.length, 0, 'waits ≥ 1.5 s of stable text');
  for (let i = 0; i < 4; i++) await step();
  assert.deepEqual(calls, [{ tool: 'read_file', args: { path: 'README.md' } }]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^\[DevSpace result 1\/1\] read_file path=README\.md — ok \(3 ms\)/);
  for (let i = 0; i < 5; i++) await step();
  assert.equal(calls.length, 1, 'processed once');
});

// ------------------------------------------------------------------ AI Studio
test('aistudio fixture: turns, blocks (katex + thoughts excluded), language attr', opts, () => {
  const { adapter, DSG } = load('aistudio', 'aistudio-chat.html', 'https://aistudio.google.com/prompts/1AbCdEfGhIjK');
  const turns = adapter.getTurns();
  assert.deepEqual(plain(turns.map((t) => [t.role, t.key])), [
    ['user', 'id:turn-00000000-0000-0000-0000-000000000001'],
    ['model', 'id:turn-00000000-0000-0000-0000-000000000002'],
  ]);
  const model = turns[1].el;
  const blocks = plain(adapter.getModelBlocks(model));
  assert.deepEqual(blocks, [{ text: '{"tool":"list_dir","args":{"path":"."}}', lang: 'devspace' }]);
  const text = adapter.turnText(model);
  assert.ok(!text.includes('THOUGHT'), 'thought excluded');
  assert.ok(!text.includes('content_copy'), 'toolbar ligatures excluded');
  assert.ok(text.includes('MODEL_ANSWER_PLACEHOLDER'));
  assert.deepEqual(plain(DSG.protocol.extractCalls(blocks, text)).calls, [{ tool: 'list_dir', args: { path: '.' } }]);
  assert.equal(adapter.isGenerating(), false);
  assert.equal(adapter.isTurnComplete(model), true, 'no turnComplete key → complete');
  assert.equal(adapter.conversationKey(), 'aistudio:1AbCdEfGhIjK');
});

test('aistudio fixture: generating state, input, run button, system instructions', opts, async () => {
  const { doc, adapter } = load('aistudio', 'aistudio-chat.html', 'https://aistudio.google.com/prompts/new_chat');
  assert.equal(adapter.isNewChat(), true);
  const input = adapter.getInput();
  assert.equal(input.localName, 'textarea');
  assert.equal(await adapter.setInput('hello world'), true);
  assert.equal(adapter.getInputText(), 'hello world');
  assert.ok(input._events.some((e) => e.type === 'input'));
  const run = adapter._internal.q('sendButton');
  assert.equal(run.getAttribute('aria-label'), 'Run');

  doc.querySelector('ms-run-button').replaceWith(firstEl(tpl(doc, 'tpl-run-button-generating')));
  assert.equal(adapter.isGenerating(), true);

  // system instructions: card opens a panel containing the textarea
  const card = adapter._internal.q('systemInstructionsOpen');
  assert.ok(card.hasAttribute('data-test-system-instructions-card'));
  card.onclick = () => doc.body.appendChild(firstEl(tpl(doc, 'tpl-system-instructions-open')));
  assert.equal(await adapter.setSystemInstructions('[GemInWeb protocol v1] …'), true);
  assert.equal(doc.querySelector('textarea.in-run-settings').value, '[GemInWeb protocol v1] …');
});
