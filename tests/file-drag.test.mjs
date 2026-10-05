import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertion, isFileDrag, JOURNAL_FILE, readJournalFile } from '../src/ui/fileDrag.ts';

test('the terminal accepts Files tab rows and OS files, nothing else', () => {
  assert.equal(isFileDrag([JOURNAL_FILE]), true);
  assert.equal(isFileDrag(['Files']), true);
  assert.equal(isFileDrag(['text/plain', 'text/uri-list']), false, 'Dragged text or links are not files');
  assert.equal(isFileDrag(undefined), false);
});

test('a Files tab drag carries a root and a relative path; anything else is ignored', () => {
  assert.deepEqual(readJournalFile(JSON.stringify({ rootKey: 'checkout', path: 'src/a b.ts' })), { rootKey: 'checkout', path: 'src/a b.ts' });
  assert.deepEqual(readJournalFile(JSON.stringify({ rootKey: 'checkout', path: 'x', extra: 1 })), { rootKey: 'checkout', path: 'x' });
  for (const bad of ['', 'nope', '{}', JSON.stringify({ rootKey: 'checkout', path: '' }), JSON.stringify({ rootKey: 1, path: 'x' }), 'null']) assert.equal(readJournalFile(bad), null, bad);
});

test('dropped references are separated by spaces and never end in a newline', () => {
  assert.equal(insertion(['@src/a.ts']), '@src/a.ts ');
  assert.equal(insertion(['@src/a.ts', '"my docs/b.md"']), '@src/a.ts "my docs/b.md" ');
  assert.equal(insertion([]), '');
  assert.doesNotMatch(insertion(['a', 'b']), /[\r\n]/);
});
