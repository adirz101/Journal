import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationEntries, messageDeliveryLabel, shortRunTitle, currentCompletionReport } from '../src/core/story/team-conversation.mjs';

test('conversation follows event order and includes only human messages and explicitly published updates', () => {
  const messages = [{ id: 'human', sender: 'desktop', text: 'Change scope', state: 'submitted', recipient: 'coordinator' }, { id: 'digest', sender: 'runtime:digest', text: 'internal', recipient: 'coordinator' }];
  const events = [{ id: 4, kind: 'coordinator.update', body: { summary: 'Working on it' } }, { id: 2, kind: 'message.queued', body: { messageId: 'human' } }, { id: 3, kind: 'message.queued', body: { messageId: 'digest' } }, { id: 5, kind: 'worker.progress', body: { summary: 'worker claim' } }];
  assert.deepEqual(conversationEntries(events, messages).map(item => [item.id, item.source, item.text]), [[2, 'user', 'Change scope'], [4, 'coordinator', 'Working on it']]);
  assert.match(messageDeliveryLabel('submitted'), /not acknowledged/i);
  assert.match(messageDeliveryLabel('acknowledged'), /receipt/i);
  assert.match(messageDeliveryLabel('uncertain'), /uncertain/i);
  assert.equal(shortRunTitle('A short goal'), 'A short goal');
  assert.ok(shortRunTitle('long '.repeat(80)).length <= 81);
});
test('completion cards never promote a previous launch or turn report', () => {
  const attempt = { launchId: 'launch', turnId: 'turn', reports: { result: { launchId: 'launch', turnId: 'turn', summary: 'Done' } } };
  assert.equal(currentCompletionReport(attempt).summary, 'Done');
  assert.equal(currentCompletionReport({ ...attempt, launchId: 'new' }), null);
  assert.equal(currentCompletionReport({ ...attempt, turnId: 'new' }), null);
  assert.equal(currentCompletionReport({ ...attempt, turnId: null }), null);
});
