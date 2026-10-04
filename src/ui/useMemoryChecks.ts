import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Memory } from './types';

const CHUNK = 50; const CAP = 1000;

export interface MemoryChecks { stale: Set<string>; checked: number; total: number | null; done: boolean }
const IDLE: MemoryChecks = { stale: new Set(), checked: 0, total: null, done: false };

// The project-wide "Check needed" total (Phase 5, F16; decision 5): current notes
// whose source file changed. The visible page counts at once (seed: its items
// already carry a validation); the rest is checked in chunks of 50 through
// memoryChecks, one call at a time, so the storage worker never hashes more than
// one chunk while other requests wait. It stops at 1000 notes.
// A scan runs while `active` and the window is visible, and restarts on a new
// version, a project switch, the tab or window becoming visible again and window
// focus (files change outside Journal). At most one scan runs: a restart takes
// effect at the next chunk boundary, and the next scan waits for the running one.
// Until a scan finishes, the notes found so far are added to the last result.
export function useMemoryChecks(projectId: string | null, seed: Memory[], active: boolean, version: number): MemoryChecks {
  const [result, setResult] = useState<MemoryChecks & { projectId: string | null }>({ ...IDLE, projectId: null });
  const generation = useRef(0); const running = useRef<Promise<void>>(Promise.resolve());
  const seedRef = useRef(seed); seedRef.current = seed;
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const [focus, setFocus] = useState(0);
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible');
    const onFocus = () => setFocus(n => n + 1);
    document.addEventListener('visibilitychange', onVisibility); window.addEventListener('focus', onFocus);
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('focus', onFocus); };
  }, []);
  const scan = useCallback(async (mine: number, project: string) => {
    const current = () => generation.current === mine;
    const found = new Set(seedRef.current.filter(note => note.validation === 'stale').map(note => note.id));
    setResult(previous => ({ ...(previous.projectId === project ? previous : IDLE), projectId: project, done: false, stale: new Set([...(previous.projectId === project ? previous.stale : []), ...found]) }));
    let offset = 0; let total: number | null = null;
    try {
      while (current() && (total === null || (offset < total && offset < CAP))) {
        const chunk = await api<{ checked: number; total: number; stale: string[] }>('memoryChecks', { projectId: project, offset, limit: CHUNK });
        if (!current()) return;
        total = chunk.total; offset += chunk.checked; for (const id of chunk.stale) found.add(id);
        if (!chunk.checked) break;
        const checked = Math.min(offset, total); const partial = new Set(found);
        setResult(previous => ({ ...previous, projectId: project, checked, total, stale: new Set([...previous.stale, ...partial]) }));
      }
      if (current()) setResult({ projectId: project, stale: found, checked: Math.min(offset, total ?? 0), total, done: true });
    } catch {
      // Unavailable now (a removed project, a closed worker): keep what was found; the next restart tries again.
      if (current()) setResult(previous => ({ ...previous, done: true }));
    }
  }, []);
  const on = active && visible && !!projectId;
  useEffect(() => {
    if (!on || !projectId) { generation.current++; return; }
    const mine = ++generation.current;
    running.current = running.current.then(() => generation.current === mine ? scan(mine, projectId) : undefined);
  }, [on, projectId, version, focus, scan]);
  // While a scan runs, the visible page's own results count at once.
  const seeded = seed.filter(note => note.validation === 'stale').map(note => note.id).join('\n');
  return useMemo(() => {
    if (result.projectId !== projectId) return IDLE;
    if (result.done || !seeded) return result;
    return { ...result, stale: new Set([...result.stale, ...seeded.split('\n')]) };
  }, [result, projectId, seeded]);
}
