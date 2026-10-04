import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { queryTermSpans } from '../src/core/retrieval.mjs';

async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'mirror-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL('../src/ui/taskMirror.ts', import.meta.url), 'utf8');
  writeFileSync(join(dir, 'taskMirror.mjs'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  return import(pathToFileURL(join(dir, 'taskMirror.mjs')).href);
}
const joined = (parts, pad) => parts.map(part => part.text).join('').replace(new RegExp(`${pad}$`), '');
const marked = parts => parts.filter(part => part.term).map(part => [part.text, part.term]);

test('segments cover the text exactly once', async t => {
  const { segments, MIRROR_PAD } = await load(t);
  const text = 'Fix createRefund in src/payments/retry.mjs, then refund worktree removal';
  for (const matched of [new Set(), new Set(['refund']), new Set(['createrefund', 'refund', 'payments', 'retry', 'worktree', 'removal'])]) {
    const parts = segments(text, queryTermSpans(text), matched);
    assert.equal(joined(parts, MIRROR_PAD), text);
    assert.ok(parts.every(part => part.text.length > 0));
  }
  assert.deepEqual(segments('', [], new Set()), []);
});

test('a matched whole word is underlined as one mark; only matched camelCase parts otherwise', async t => {
  const { segments } = await load(t);
  const text = 'Fix createRefund in src/payments/retry.mjs, then refund again';
  const spans = queryTermSpans(text);
  assert.deepEqual(marked(segments(text, spans, new Set(['createrefund', 'refund']))), [['createRefund', 'createrefund'], ['refund', 'refund']]);
  assert.deepEqual(marked(segments(text, spans, new Set(['refund']))), [['Refund', 'refund'], ['refund', 'refund']]);
  assert.deepEqual(marked(segments(text, spans, new Set(['payments', 'retry']))), [['payments', 'payments'], ['retry', 'retry']]);
  assert.deepEqual(marked(segments(text, spans, new Set(['unrelated']))), []);
  // Overlaps resolve left to right and the longest span wins.
  assert.deepEqual(marked(segments('abcdef', [{ term: 'cd', start: 2, end: 4, whole: false }, { term: 'bcde', start: 1, end: 5, whole: true }, { term: 'ef', start: 4, end: 6, whole: false }], new Set(['cd', 'bcde', 'ef']))), [['bcde', 'bcde']]);
});

test('a trailing newline keeps the mirror height', async t => {
  const { segments, MIRROR_PAD } = await load(t);
  const text = 'worktree removal\n';
  const parts = segments(text, queryTermSpans(text), new Set(['worktree']));
  assert.equal(parts.at(-1).text, MIRROR_PAD); assert.equal(MIRROR_PAD, '​');
  assert.equal(joined(parts, MIRROR_PAD), text);
  assert.notEqual(segments('worktree', queryTermSpans('worktree'), new Set()).at(-1).text, MIRROR_PAD);
});

test('Unicode offsets match the textarea', async t => {
  const { segments, MIRROR_PAD } = await load(t);
  // An astral emoji before a word, a combining mark, CJK and Hebrew (right to left).
  const text = '\u{1F680} café 漢字 שלום retryPolicy';
  const spans = queryTermSpans(text);
  const matched = new Set(spans.map(span => span.term));
  const parts = segments(text, spans, matched);
  assert.equal(joined(parts, MIRROR_PAD), text);
  let at = 0;
  for (const part of parts) {
    if (part.term) assert.equal(text.slice(at, at + part.text.length).toLowerCase(), part.text.toLowerCase());
    at += part.text.length;
  }
  const words = marked(parts).map(([word]) => word);
  assert.ok(words.includes('漢字'), 'CJK is marked whole');
  assert.ok(words.includes('שלום'), 'Hebrew is marked whole');
  assert.ok(words.includes('retryPolicy'), 'a matched identifier is one mark');
});
