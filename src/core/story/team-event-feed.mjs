// A single catch-up loop owns each run's cursor. New notifications request another
// pass without cancelling in-flight pages or rereading the persisted history.
export function createEventFeed(fetchPage, publish, onError) {
  let alive = true, pending = false, running = null, cursor = 0;
  const rows = new Map();
  async function catchUp() {
    try {
      while (alive && pending) {
        pending = false;
        while (alive) {
          const page = await fetchPage(cursor);
          if (!alive) return;
          const before = cursor;
          for (const row of page) if (row.id > cursor) rows.set(row.id, row);
          if (page.length) cursor = Math.max(cursor, ...page.map(row => row.id));
          if (cursor > before) publish([...rows.values()].sort((a, b) => a.id - b.id));
          if (page.length < 500 || cursor === before) break;
        }
      }
    } catch (error) { if (alive) onError(error); }
    finally { running = null; }
  }
  return {
    refresh() { if (!alive) return; pending = true; if (!running) running = catchUp(); },
    settled() { return running ?? Promise.resolve(); },
    dispose() { alive = false; pending = false; },
  };
}
