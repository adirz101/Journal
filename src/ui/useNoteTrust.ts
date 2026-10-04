import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type MemoryOrigin, type NoteTrust } from './types';

const BATCH = 200;
const EMPTY: Record<string, NoteTrust> = {};

// Origins and "Sent to" counts for the notes on screen (Phase 5, F15). Fetches only
// IDs missing from its cache, in batches of at most 200, origins and counts in
// parallel. The cache belongs to one project and one version: App bumps the
// version on note changes and when a session starts running (a new delivery).
// A reply for another project or version is dropped; after a version bump the
// previous lines stay until their refetch lands, so cards do not jump. A failure
// leaves those lines blank (null) without an error per card; the next version tries again.
export function useNoteTrust(projectId: string | null, ids: string[], version: number): Record<string, NoteTrust> {
  const [cache, setCache] = useState<{ projectId: string | null; key: string; trust: Record<string, NoteTrust> }>({ projectId: null, key: '', trust: EMPTY });
  const key = `${projectId ?? ''}:${version}`;
  const requested = useRef<{ key: string; ids: Set<string> }>({ key: '', ids: new Set() });
  const wanted = useMemo(() => [...new Set(ids)].sort().join('\n'), [ids]);
  useEffect(() => {
    if (!projectId) return;
    if (requested.current.key !== key) requested.current = { key, ids: new Set() };
    const asked = requested.current.ids;
    const missing = wanted ? wanted.split('\n').filter(id => !asked.has(id)) : [];
    if (!missing.length) return;
    for (const id of missing) asked.add(id);
    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      void Promise.all([api<Record<string, MemoryOrigin>>('memoryOrigins', { projectId, ids: batch }), api<Record<string, number>>('deliveryCounts', { projectId, ids: batch })])
        .then(([origins, counts]) => Object.fromEntries(batch.map(id => [id, { origin: origins[id] ?? null, sent: counts[id] ?? null }])),
          () => Object.fromEntries(batch.map(id => [id, { origin: null, sent: null }])))
        .then(found => setCache(current => requested.current.key !== key ? current : { projectId, key, trust: { ...(current.projectId === projectId ? current.trust : EMPTY), ...found } }));
    }
  }, [projectId, key, wanted]);
  return cache.projectId === projectId ? cache.trust : EMPTY;
}

// The loaded session IDs as a Set (origin links open only these). Its identity changes
// only when the IDs change, not on every session event.
export function useOpenable(sessions: readonly { id: string }[]): Set<string> {
  const key = sessions.map(session => session.id).join('\n');
  return useMemo(() => new Set(key ? key.split('\n') : []), [key]);
}
