import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Proposal, type Session, type SessionSummary, type StaleCatch } from './types';
import { LOOKING_MS } from './wrapUpModel';

// The out-of-date catch reads Git and hashes files, so it is kept per session for this
// app run (keyed by the end snapshot). It is dropped for a session when one of its notes
// is resolved here (Still true, Update note, Forget), for every session when notes change
// (knowledgeVersion), and refetched when asked (a refused Still true). A reply that was
// requested before a drop is shown but not cached (generation).
const staleCache = new Map<string, StaleCatch>();
let generation = 0;
const staleKey = (session: Session) => `${session.id}:${session.changeStats?.at ?? ''}`;
export const forgetStaleCatch = (sessionId: string) => { generation++; for (const key of [...staleCache.keys()]) if (key.startsWith(`${sessionId}:`)) staleCache.delete(key); };
export const forgetAllStaleCatches = () => { generation++; staleCache.clear(); };

// Data for one ended session's wrap-up: the summary (SQL only), its suggestions (this
// session and its resume chain) and the out-of-date catch. A reply for another session,
// or one superseded by a newer request, is dropped.
// knowledgeVersion: App's counter of note changes; a change drops every cached catch (the
// view on screen keeps its own copy, so resolved cards stay in place).
export function useWrapUp(session: Session, onError: (error: unknown) => void, knowledgeVersion = 0) {
  const id = session.id; const projectId = session.projectId;
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [stale, setStale] = useState<StaleCatch | null>(() => staleCache.get(staleKey(session)) ?? null);
  // "Looking for suggestions…" while the session ended under 3 s ago and its proposals event has not arrived.
  const endedAgo = session.endedAt ? Date.now() - Date.parse(session.endedAt) : Infinity;
  const [looking, setLooking] = useState(() => Number.isFinite(endedAgo) && endedAgo >= 0 && endedAgo < LOOKING_MS);
  const tickets = useRef({ summary: 0, proposals: 0, stale: 0 });
  const errorRef = useRef(onError); errorRef.current = onError;

  const loadSummary = useCallback(() => {
    const ticket = ++tickets.current.summary;
    void api<SessionSummary>('sessionSummary', { id }).then(next => { if (ticket === tickets.current.summary) setSummary(next); }, error => { if (ticket === tickets.current.summary) errorRef.current(error); });
  }, [id]);
  // settled: runs once this reply is on screen (the placeholder ends with the list it announces).
  const loadProposals = useCallback((settled?: () => void) => {
    const ticket = ++tickets.current.proposals;
    void api<Proposal[]>('proposals', { projectId, sessionId: id }).then(next => { if (ticket === tickets.current.proposals) { setProposals(next); settled?.(); } },
      error => { if (ticket === tickets.current.proposals) { settled?.(); errorRef.current(error); } });
  }, [id, projectId]);
  const key = staleKey(session);
  const loadStale = useCallback((force = false) => {
    const cached = staleCache.get(key);
    if (cached && !force) { setStale(cached); return; }
    const ticket = ++tickets.current.stale; const asked = generation;
    void api<StaleCatch>('staleNotes', { sessionId: id }).then(next => { if (asked === generation) staleCache.set(key, next); if (ticket === tickets.current.stale) setStale(next); },
      error => { if (ticket === tickets.current.stale) { setStale({ available: false, notes: [], truncated: false }); errorRef.current(error); } });
  }, [id, key]);

  // A newer end snapshot (status events carry changeStats) refetches the summary only.
  useEffect(() => { loadSummary(); }, [loadSummary, session.status, session.changeStats?.at, session.nativeIdConfirmed, session.nativeId]);
  useEffect(() => { loadProposals(); }, [loadProposals]);
  useEffect(() => { loadStale(); }, [loadStale]);
  const seenVersion = useRef(knowledgeVersion);
  useEffect(() => { if (seenVersion.current !== knowledgeVersion) { seenVersion.current = knowledgeVersion; forgetAllStaleCatches(); } }, [knowledgeVersion]);
  // The proposals event for this session (any count) ends the placeholder and refetches.
  useEffect(() => window.journal?.onEvent(event => {
    if (event.type === 'proposals' && event.sessionId === id) loadProposals(() => setLooking(false));
  }), [id, loadProposals]);
  useEffect(() => {
    if (!looking) return;
    const timer = setTimeout(() => loadProposals(() => setLooking(false)), Math.max(0, LOOKING_MS - endedAgo));
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount: the end time does not change
  }, [looking]);
  return { summary, proposals, stale, looking, reloadProposals: () => loadProposals(), reloadStale: () => { forgetStaleCatch(id); loadStale(true); } };
}
