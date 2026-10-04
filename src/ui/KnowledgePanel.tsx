import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Memory, type MemoryPage, type Project, type Proposal, type Session, type StatusDraft, type Workspace } from './types';
import { noteActions } from './wrapUpModel'; // Phase 6 B8
import { category, copy, tip } from './copy';
import { NoteCard } from './NoteCard';
import { CATEGORY_ORDER, chipLabel } from './noteCardModel';
import { useNoteTrust, useOpenable } from './useNoteTrust';
import { useMemoryChecks } from './useMemoryChecks';

const PAGE = 50; const MAX_IDS = 200;

// The Memory tab's filters live for this app run (not stored). App keeps them, so
// switching tabs keeps them, and resets them when the project changes, so another
// project, and a return to this one, starts from the defaults (Phase 5, B4).
export type MemoryFilters = { filter: string; search: string; category: string; attention: 'check' | 'other' | null };
export const MEMORY_FILTER_DEFAULTS: MemoryFilters = { filter: 'all', search: '', category: 'all', attention: null };
type Filters = MemoryFilters; const DEFAULTS = MEMORY_FILTER_DEFAULTS;
// The last announced Check needed count per project, for this app run: a remounted
// panel (a tab switch) does not announce the same count again.
const announcedCounts = new Map<string, number>();
// Phase 8: the last palette request handled, so a remounted panel (a tab switch) never takes focus again.
let focusHandled = 0;

export function KnowledgePanel({ project, workspaces = [], version, trustVersion, busy, proposals: shared, sessions = [], filters: heldFilters, onFilters, onOpenSession, onEdit, onPropose, onChanged, onError, focus }: {
  // proposals: App's window-wide fetch (useProposals); when set, the panel does not fetch its own.
  // trustVersion: bumps with version and when a session starts running (a new delivery).
  // sessions: the loaded sessions; an origin links to its session only when App can select it.
  // filters, onFilters: App holds the filters (null: the defaults); without onFilters the panel keeps its own.
  // workspaces: Phase 6 B8, a note of another branch is remembered in a ready copy on it and never revised here.
  project: Project; workspaces?: Workspace[]; version: number; trustVersion?: number; busy: boolean; proposals?: Proposal[]; sessions?: Session[]; onOpenSession?: (sessionId: string) => void;
  filters?: MemoryFilters | null; onFilters?: (filters: MemoryFilters) => void;
  onEdit: (form: { memory?: Memory; supersedes?: Memory; initialCategory?: string; draft?: StatusDraft }) => void;
  onPropose: (scope: 'checkout' | 'branch') => void; onChanged: () => void; onError: (error: unknown) => void;
  // Phase 8: a note opened from the palette (seq increases per request).
  focus?: { id: string; seq: number } | null;
}) {
  const [ownFilters, setOwnFilters] = useState<{ projectId: string; filters: Filters }>({ projectId: project.id, filters: DEFAULTS });
  const [filtersFor, setFiltersFor] = useState(project.id);
  if (filtersFor !== project.id) { setFiltersFor(project.id); setOwnFilters({ projectId: project.id, filters: DEFAULTS }); }
  const filters = onFilters ? heldFilters ?? DEFAULTS : ownFilters.projectId === project.id ? ownFilters.filters : DEFAULTS;
  const change = (next: Partial<Filters>) => onFilters ? onFilters({ ...filters, ...next }) : setOwnFilters({ projectId: project.id, filters: { ...filters, ...next } });
  const { filter, search, category: chosen, attention } = filters;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState<MemoryPage | null>(null); const [items, setItems] = useState<Memory[]>([]); const [own, setOwn] = useState<Proposal[]>([]);
  const proposals = shared ?? own; const fetchOwn = !shared;
  // Check needed: the project-wide total of current notes whose file changed (decision 5).
  const checks = useMemoryChecks(project.id, items, true, version);
  // The Check needed list follows finished scans only, so it does not reload per chunk or per page.
  const [doneKey, setDoneKey] = useState<{ projectId: string; key: string }>({ projectId: project.id, key: '' });
  useEffect(() => { if (checks.done) setDoneKey({ projectId: project.id, key: [...checks.stale].slice(0, MAX_IDS).join(',') }); }, [checks.done, checks.stale, project.id]);
  const checkKey = attention === 'check' && doneKey.projectId === project.id ? doneKey.key : '';
  // Loads overlap (approvals, search, project switches). A response renders
  // only if it was requested after the one on screen, so an older response
  // can never replace newer data, and a newer one is never held back.
  // A "Show more" page is appended only to the list it was requested against.
  const issued = useRef(0); const applied = useRef(0); const resets = useRef(0); const [paging, setPaging] = useState(false);
  const pageRef = useRef<MemoryPage | null>(null); pageRef.current = page;
  const load = useCallback(async (offset = 0) => {
    const ticket = ++issued.current; const reset = offset === 0 ? ++resets.current : resets.current;
    const ids = attention === 'check' ? (checkKey ? checkKey.split(',') : []) : null;
    // Nothing needs a check: an empty list, without a request (a page needs at least one ID).
    const shown = pageRef.current;
    const next = ids && !ids.length ? { items: [], total: 0, offset: 0, limit: PAGE, counts: shown?.counts ?? {}, categoryCounts: Object.fromEntries(CATEGORY_ORDER.map(code => [code, 0])), otherBranch: shown?.otherBranch ?? 0 }
      : await api<MemoryPage>('memoryPage', { projectId: project.id, offset, limit: PAGE, filter, search, category: chosen, otherBranch: attention === 'other', ...(ids ? { ids } : {}) });
    if (ticket <= applied.current || (offset && reset !== resets.current)) return;
    applied.current = ticket;
    setPage(next); setItems(current => offset ? [...current, ...next.items] : next.items);
  }, [project.id, filter, search, chosen, attention, checkKey]);
  useEffect(() => { const timer = setTimeout(() => void load(0).catch(onError), search ? 150 : 0); return () => clearTimeout(timer); }, [load, version, search, onError]);
  useEffect(() => { if (!fetchOwn) return; let current = true; void api<Proposal[]>('proposals', { projectId: project.id }).then(next => { if (current) setOwn(next); }).catch(onError); return () => { current = false; }; }, [project.id, version, onError, fetchOwn]);
  const trust = useNoteTrust(project.id, items.map(item => item.id), trustVersion ?? version);
  const openable = useOpenable(sessions);
  // The final count is announced once per change and project, never per chunk or remount.
  // A first result of zero is not announced: opening the tab with nothing to check stays quiet.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    if (!checks.done) return;
    const n = checks.stale.size; const before = announcedCounts.get(project.id);
    if (before === n) return;
    if (before !== undefined || n > 0) setAnnounced(copy.trust.needCheck(n));
    announcedCounts.set(project.id, n);
  }, [checks.done, checks.stale, project.id]);
  // While an action and its reload are in flight, every action button is
  // disabled: the list on screen may be stale, and a second click on it
  // would act on an outdated item.
  const [pending, setPending] = useState(false);
  // optimistic: the action returns the updated note (remember, reject,
  // forget, pin), whose new status is shown at once. A null result means the
  // user cancelled a confirmation (Forget…): nothing changed, so no reload.
  const act = async (action: () => Promise<unknown>, { optimistic = false } = {}) => {
    setPending(true);
    try {
      const result = await action();
      if (result === null) return;
      if (optimistic && result && typeof result === 'object') { const updated = result as Memory; setItems(current => current.map(item => item.id === updated.id ? { ...item, status: updated.status, pinned: updated.pinned } : item)); }
      onChanged(); // the write succeeded; a failed reload below is reported separately
      try { await load(0); } catch (error) { onError(error); }
    } catch (error) { onError(error); } finally { setPending(false); }
  };
  // === Phase 8: a note opened from the palette ===
  // It is loaded by ID, shown first when the current list does not include it, scrolled into
  // view and focused once. The filters stay as the user left them.
  const [focusNote, setFocusNote] = useState<{ seq: number; note: Memory } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus || focus.seq <= focusHandled) return; let current = true;
    void api<MemoryPage>('memoryPage', { projectId: project.id, ids: [focus.id], filter: 'history', limit: 1, offset: 0 })
      .then(found => { if (current && found.items[0]) { focusHandled = focus.seq; setFocusNote({ seq: focus.seq, note: found.items[0] }); } }).catch(onError);
    return () => { current = false; };
  }, [focus, project.id, onError]);
  const shownItems = focusNote && focusNote.note.projectId === project.id && !items.some(item => item.id === focusNote.note.id) ? [focusNote.note, ...items] : items;
  const focusIndex = focusNote ? shownItems.findIndex(item => item.id === focusNote.note.id) : -1;
  useEffect(() => {
    const card = focusIndex < 0 ? null : list.current?.children[focusIndex] as HTMLElement | undefined;
    if (!card) return;
    card.tabIndex = -1; card.scrollIntoView({ block: 'nearest' }); card.focus({ preventScroll: true });
  }, [focusNote?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  // === End Phase 8 ===
  const counts = page?.counts ?? {}; const byCategory = page?.categoryCounts ?? {};
  // "…" only before the first result; a rescan keeps the last count (and its amber).
  const checkCount = checks.stale.size; const firstScan = !checks.settled;
  const rootName = (memory: Memory) => { const name = memory.source.rootId ? project.roots?.find(root => root.id === memory.source.rootId)?.name : undefined; return name ? `${name}/` : ''; };
  const empty = attention === 'check' ? checks.done ? copy.trust.noneNeedCheck : copy.trust.checkingNotes : attention === 'other' ? copy.trust.noneOtherBranch : search ? 'No matching notes' : filter === 'review' ? 'Nothing waiting for review' : 'Keep the useful parts.';
  return <div className="panel-content"><div className="section-heading"><div><h2>{copy.memory}</h2></div></div><p className="muted panel-intro">{copy.aboutProject} and {copy.branchStands} reach every session. Relevant decisions, rules and lessons are added for the task.</p>
    <div className="brief-actions"><button onClick={() => onEdit({ initialCategory: 'brief' })}>{copy.addSummary}</button><button disabled={busy || !project.branch} onClick={() => onPropose('branch')}>Propose branch update</button><button disabled={busy} onClick={() => onPropose('checkout')}>Propose overview</button></div>
    {proposals.length > 0 && <section className="proposal-inbox" aria-label={copy.suggestions}><span className="eyebrow">{copy.suggestions} · {proposals.length}</span>
      {proposals.map(proposal => <article key={proposal.id} className="proposal"><p dir="auto">{proposal.statement}</p><small className="muted">{proposal.kind === 'rule' ? 'You stated this rule in a task' : proposal.kind === 'test-command' ? 'Seen passing in your sessions' : 'Branch moved after a session'} · {category(proposal.category, proposal.scope)}{proposal.branch ? ` · ⑂ ${proposal.branch}` : ''}</small>
        <div className="memory-actions">{proposal.kind === 'branch-status' ? <button disabled={proposal.branch !== project.branch} title={proposal.branch !== project.branch ? `Switch to ${proposal.branch} to update it` : undefined} onClick={() => onPropose('branch')}>Propose branch update</button>
          : <button className="approve" disabled={pending} onClick={() => void act(() => api('acceptProposal', { id: proposal.id }))}>Add for review</button>}<button disabled={pending} onClick={() => void act(() => api('dismissProposal', { id: proposal.id }))}>Dismiss</button></div></article>)}
    </section>}
    <div className="memory-search"><input className="knowledge-search" aria-label={copy.searchMemory} placeholder={`${copy.searchMemory}…`} value={search} onChange={e => change({ search: e.target.value })} maxLength={200} /><button aria-label={copy.addNote} onClick={() => onEdit({})}>＋ Add</button></div>
    <div className="category-chips" role="group" aria-label={copy.trust.category}>{CATEGORY_ORDER.filter(code => (byCategory[code] ?? 0) > 0 || code === chosen).map(code =>
      <button key={code} aria-pressed={code === chosen} onClick={() => change({ category: code })}>{chipLabel(code)} <span>{byCategory[code] ?? 0}</span></button>)}</div>
    <div className="filter-tabs"><button aria-pressed={filter === 'all'} onClick={() => change({ filter: 'all' })}>Current</button><button aria-pressed={filter === 'review'} onClick={() => change({ filter: 'review' })}>{copy.needsReview} <span>{counts.candidate ?? 0}</span></button><button aria-pressed={filter === 'active'} onClick={() => change({ filter: 'active' })}>{copy.remembered}</button><button aria-pressed={filter === 'history'} onClick={() => change({ filter: 'history' })}>History</button>
      <span className="filter-gap" aria-hidden="true" />
      <button className={`attention-toggle${checkCount > 0 && !firstScan ? ' amber' : ''}`} aria-pressed={attention === 'check'} aria-busy={firstScan || undefined} onClick={() => change({ attention: attention === 'check' ? null : 'check' })}>{copy.checkNeeded} <span>{firstScan ? copy.trust.checking : checkCount}</span></button>
      <button className="attention-toggle" aria-pressed={attention === 'other'} onClick={() => change({ attention: attention === 'other' ? null : 'other' })}>{copy.trust.otherBranches} <span>{page?.otherBranch ?? 0}</span></button></div>
    <p className="visually-hidden" aria-live="polite">{announced}</p>
    {checks.done && checks.total !== null && checks.checked < checks.total && <p className="hint">{copy.trust.checked(checks.checked, checks.total)}</p>}
    {attention === 'check' && checks.stale.size > MAX_IDS && <p className="hint">{copy.trust.firstOnly(MAX_IDS)}</p>}
    <div className="memory-list" ref={list}>{shownItems.map(memory => {
      // A note of another branch is never revised here, and is remembered only when a
      // ready copy has that branch checked out (Phase 6 B8, noteActions).
      const allowed = noteActions(memory, project, workspaces);
      const elsewhere = attention === 'other' || !allowed.revise;
      const origin = trust[memory.id]?.origin; const sessionId = origin?.session?.id;
      return <NoteCard key={memory.id} note={memory} project={project} variant="memory" trust={trust[memory.id]} checkNeeded={checks.stale.has(memory.id)} onOpenSession={sessionId && openable.has(sessionId) ? onOpenSession : undefined}
        actions={<>{memory.status === 'candidate' && <>{allowed.approve && <button className="approve" disabled={(memory.validation !== 'current' && memory.validation !== 'wrong-branch') || busy || pending} title={tip.remember} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'active' }), { optimistic: true })}>{copy.remember}</button>}<button disabled={busy || pending} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'rejected' }), { optimistic: true })}>Reject</button></>}{memory.category === 'brief' && memory.status !== 'rejected' && memory.status !== 'archived' && (memory.scope === 'checkout' || memory.branch === project.branch) && <button disabled={busy} onClick={() => onPropose(memory.scope)}>Propose update</button>}{memory.status === 'active' && memory.category !== 'brief' && <button disabled={pending} onClick={() => void act(() => api('setPinned', { id: memory.id, pinned: !memory.pinned }), { optimistic: true })}>{memory.pinned ? 'Unpin' : 'Pin'}</button>}{memory.status === 'active' && memory.scope === 'branch' && memory.category !== 'brief' && <button disabled={pending} onClick={() => void act(() => api('proposePromotion', { id: memory.id }))}>Propose for all branches</button>}{!elsewhere && <button onClick={() => onEdit({ memory })}>Revise</button>}{memory.status === 'active' && memory.category !== 'brief' && (memory.scope === 'checkout' || memory.branch === project.branch) && <button onClick={() => onEdit({ supersedes: memory })}>Replace…</button>}{memory.status === 'active' && <button title={tip.forget} disabled={pending} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'archived' }), { optimistic: true })}>{copy.forget}</button>}</>}>
        {memory.category === 'brief' && memory.scope === 'branch' && (memory as Memory & { createdAt?: string }).createdAt ? <p className={memory.drift ? 'memory-drift' : 'memory-age'}>Updated {Math.max(0, Math.floor((Date.now() - Date.parse((memory as Memory & { createdAt: string }).createdAt)) / 86400000))} day(s) ago{memory.drift ? ` · ${memory.drift} commit${memory.drift === 1 ? '' : 's'} since` : ''}</p> : memory.drift ? <p className="memory-drift">{memory.drift} commit{memory.drift === 1 ? '' : 's'} since this update</p> : null}
        {memory.status === 'candidate' && memory.conflicts?.length ? <div className="memory-conflict" role="note"><strong>Possible conflict</strong>{memory.conflicts.map(c => <span key={c.id}>r{c.revision}: {c.statement}</span>)}</div> : null}
        <button className="source-button" aria-expanded={expanded === memory.id} title={memory.source.kind === 'file' ? `${rootName(memory)}${memory.source.path}:${memory.source.startLine}` : undefined} onClick={() => setExpanded(expanded === memory.id ? null : memory.id)}>{expanded === memory.id ? copy.trust.hideSource : copy.trust.showSource} <span aria-hidden="true">{expanded === memory.id ? '−' : '+'}</span></button>
        {expanded === memory.id && <div className="evidence-details"><pre dir="auto">{memory.source.kind === 'git' ? `Commits ${memory.source.base ?? 'up to'} → ${memory.source.head}${memory.source.commitCount != null ? ` (${memory.source.commitCount} at capture)` : ''}` : memory.source.excerpt ?? memory.source.note}</pre>{memory.source.contentHash && <small>Source fingerprint {memory.source.contentHash.slice(0, 12)}</small>}<small>Revision {memory.revisionId}</small></div>}
      </NoteCard>;
    })}{page && !items.length && <div className="knowledge-empty"><span>◇</span><h3>{empty}</h3>{!attention && <><p>Add a decision, a rule or a lesson.<br />Agents get it once you remember it.</p>{!search && <button onClick={() => onEdit({})}>{copy.addNote}</button>}</>}</div>}</div>
    {page && items.length < page.total && <button className="load-more" disabled={paging || pending} onClick={() => { setPaging(true); void load(items.length).catch(onError).finally(() => setPaging(false)); }}>Show more ({page.total - items.length} remaining)</button>}
  </div>;
}
