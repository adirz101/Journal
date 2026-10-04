import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Memory } from './types';
import { finishedStale, focusStartsScan, seedStale, shownStale } from './memoryChecksModel';

const CHUNK = 50; const CAP = 1000;

// done: the latest scan finished (the count is final). settled: a finished result exists
// for this project, so the count can show while a rescan runs.
export interface MemoryChecks { stale: Set<string>; checked: number; total: number | null; done: boolean; settled: boolean }
type Finished = { stale: Set<string>; checked: number; total: number | null; at: number };

// App-wide, across mounts: the last finished result per project (a remounted panel shows
// it at once) and the tail of the scan queue. Each scan waits for the previous one, and a
// cancelled scan stops after its in-flight chunk, so at most one memoryChecks call is in
// flight in the whole window.
const finished = new Map<string, Finished>();
let tail: Promise<void> = Promise.resolve();

// One scan: chunks of 50 through memoryChecks, one call at a time, up to 1000 notes.
// null when cancelled. A failure keeps what was found (the next restart tries again).
async function scan(project: string, current: () => boolean, seeded: () => string[]): Promise<Finished | null> {
  const found = new Set<string>(); let offset = 0; let total: number | null = null; let complete = false;
  try {
    while (current() && (total === null || (offset < total && offset < CAP))) {
      const chunk = await api<{ checked: number; total: number; stale: string[] }>('memoryChecks', { projectId: project, offset, limit: CHUNK });
      if (!current()) return null;
      total = chunk.total; offset += chunk.checked; for (const id of chunk.stale) found.add(id);
      if (!chunk.checked) break;
    }
    complete = total !== null && offset >= total;
  } catch {
    // Unavailable now (a removed project, a closed worker).
  }
  if (!current()) return null;
  return { stale: finishedStale(found, seeded(), complete), checked: Math.min(offset, total ?? 0), total, at: Date.now() };
}

// The project-wide "Check needed" total (Phase 5, F16; decision 5): current notes
// whose source file changed. The visible page's current notes count at once (their
// items already carry a validation); the rest is checked in chunks of 50, so the
// storage worker never hashes more than one chunk while other requests wait.
// A scan runs while `active` and the window is visible, and restarts on a new version,
// a project switch, the window becoming visible again, and window focus (files change
// outside Journal) unless a scan is running or the last one finished under 5 s ago, so
// restoring a window starts one scan. Unmounting or a restart cancels the running scan
// at its next chunk boundary. While a rescan runs, the last finished count stays.
export function useMemoryChecks(projectId: string | null, seed: Memory[], active: boolean, version: number): MemoryChecks {
  const seeded = seedStale(seed, projectId).join('\n');
  const seededRef = useRef(seeded); seededRef.current = seeded;
  const projectRef = useRef(projectId); projectRef.current = projectId;
  const generation = useRef(0); const scanning = useRef(false);
  const [state, setState] = useState<{ projectId: string | null; last: Finished | null; scanning: boolean }>(() => ({ projectId, last: projectId ? finished.get(projectId) ?? null : null, scanning: false }));
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const [wake, setWake] = useState(0);
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible');
    const onFocus = () => {
      const project = projectRef.current;
      if (project && focusStartsScan(finished.get(project)?.at, Date.now(), scanning.current)) setWake(n => n + 1);
    };
    document.addEventListener('visibilitychange', onVisibility); window.addEventListener('focus', onFocus);
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('focus', onFocus); };
  }, []);
  const on = active && visible && !!projectId;
  useEffect(() => {
    if (!on || !projectId) return;
    const mine = ++generation.current; const project = projectId;
    const current = () => generation.current === mine;
    scanning.current = true;
    setState(previous => ({ projectId: project, last: previous.projectId === project && previous.last ? previous.last : finished.get(project) ?? null, scanning: true }));
    const job = tail.then(async () => {
      if (!current()) return;
      const result = await scan(project, current, () => seededRef.current ? seededRef.current.split('\n') : []);
      if (!result || !current()) return;
      finished.set(project, result); scanning.current = false;
      setState({ projectId: project, last: result, scanning: false });
    });
    tail = job.catch(() => undefined);
    // Unmount, a restart, a project switch or hiding: this scan stops at its next chunk boundary.
    return () => {
      generation.current++; scanning.current = false;
      setState(previous => previous.scanning ? { ...previous, scanning: false } : previous);
    };
  }, [on, projectId, version, wake]);
  return useMemo(() => {
    const last = state.projectId === projectId ? state.last : projectId ? finished.get(projectId) ?? null : null;
    const running = state.projectId === projectId && state.scanning;
    const stale = shownStale(last?.stale ?? null, seeded ? seeded.split('\n') : [], running);
    return { stale, checked: last?.checked ?? 0, total: last?.total ?? null, done: !!last && !running, settled: !!last };
  }, [state, projectId, seeded]);
}
