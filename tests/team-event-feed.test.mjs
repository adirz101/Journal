import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventFeed } from '../src/core/story/team-event-feed.mjs';

test('pagination coalesces refresh and appends without rereading or duplicating events', async () => {
  const rows = Array.from({ length: 1100 }, (_, i) => ({ id: i + 1 }));
  const cursors = []; let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  let rendered = [];
  const feed = createEventFeed(async after => {
    cursors.push(after);
    if (!after) await gate;
    return rows.filter(row => row.id > after).slice(0, 500);
  }, next => { rendered = next; }, error => { throw error; });
  feed.refresh(); rows.push({ id: 1101 }); feed.refresh(); unblock();
  await feed.settled();
  assert.equal(rendered.length, 1101);
  assert.deepEqual(cursors, [0, 500, 1000, 1101]);
  rows.push({ id: 1102 }); feed.refresh(); await feed.settled();
  assert.equal(rendered.at(-1).id, 1102);
  assert.equal(new Set(rendered.map(row => row.id)).size, rendered.length);
  assert.equal(cursors.at(-1), 1101);
});

test('disposed old run cannot publish after a new run starts', async () => {
  let resolve; const gate = new Promise(done => { resolve = done; });
  const rendered = [];
  const old = createEventFeed(() => gate, rows => rendered.push(rows), assert.fail);
  old.refresh(); old.dispose();
  const next = createEventFeed(async () => [{ id: 20 }], rows => rendered.push(rows), assert.fail);
  next.refresh(); await next.settled(); resolve([{ id: 10 }]); await old.settled();
  assert.deepEqual(rendered, [[{ id: 20 }]]);
});
