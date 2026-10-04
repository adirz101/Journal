import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isLive, type Changes, type Session, type TimelineEvent } from './types';
import { mergeEvents } from './sessionView';

const NONE: TimelineEvent[] = [];

// One sessionEvents fetch per session, merged with the live events; the
// inspector's lists and the reference list all read this. A new revision
// (the session's status, the runtime connection) fetches again: a restarted
// runtime records its recovery before this window is listening.
export function useSessionEvents(sessionId: string | null, live: TimelineEvent[], revision = '') {
  const [stored, setStored] = useState<{ id: string; events: TimelineEvent[] } | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    setError(''); if (!sessionId) return;
    let cancelled = false;
    void api<TimelineEvent[]>('sessionEvents', { id: sessionId }).then(events => { if (!cancelled) setStored({ id: sessionId, events }); }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [sessionId, revision]);
  const own = stored?.id === sessionId ? stored.events : NONE;
  const events = useMemo(() => sessionId ? mergeEvents(own, live.filter(e => e.sessionId === sessionId), sessionId) : [], [own, live, sessionId]);
  return { events, error };
}

const POLL_MS = 10_000;

// One sessionChanges source for the status bar, the Files tab and its badge.
// Claude's file and command-end events refresh it; Codex and Cursor report none, so a live
// session of theirs is polled every 10 s while the window is visible.
export function useSessionChanges(session: Session | null, fileEvents: number) {
  const [changes, setChanges] = useState<{ id: string; value: Changes } | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const ticket = useRef(0); const id = session?.id ?? null;
  const refresh = useCallback(() => {
    if (!id) return;
    const mine = ++ticket.current; setLoading(true); setError('');
    // A reply that arrives after a newer request (or a session switch) is dropped.
    void api<Changes>('sessionChanges', { id }).then(value => { if (mine === ticket.current) setChanges({ id, value }); })
      .catch(e => { if (mine === ticket.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (mine === ticket.current) setLoading(false); });
  }, [id]);
  useEffect(() => { refresh(); return () => { ticket.current++; }; }, [refresh]);
  useEffect(() => { if (!fileEvents) return; const timer = setTimeout(refresh, 500); return () => clearTimeout(timer); }, [fileEvents, refresh]);
  const poll = !!session && isLive(session) && session.provider !== 'claude';
  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [poll, refresh]);
  return { changes: changes?.id === id ? changes.value : null, loading, error, refresh };
}
