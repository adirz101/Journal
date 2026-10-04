import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Memory, type MemoryPage, type Project, type Proposal, type StatusDraft, type Workspace } from './types';
import { noteActions } from './wrapUpModel'; // Phase 6 B8
import { category, copy, memoryState, tip } from './copy';

const PAGE = 50;

export function KnowledgePanel({ project, workspaces = [], version, busy, proposals: shared, onEdit, onPropose, onChanged, onError }: {
  // proposals: App's window-wide fetch (useProposals); when set, the panel does not fetch its own.
  // workspaces: Phase 6 B8, a note of another branch is remembered in a ready copy on it and never revised here.
  project: Project; workspaces?: Workspace[]; version: number; busy: boolean; proposals?: Proposal[]; onEdit: (form: { memory?: Memory; supersedes?: Memory; initialCategory?: string; draft?: StatusDraft }) => void;
  onPropose: (scope: 'checkout' | 'branch') => void; onChanged: () => void; onError: (error: unknown) => void;
}) {
  const [filter, setFilter] = useState('all'); const [search, setSearch] = useState(''); const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState<MemoryPage | null>(null); const [items, setItems] = useState<Memory[]>([]); const [own, setOwn] = useState<Proposal[]>([]);
  const proposals = shared ?? own; const fetchOwn = !shared;
  // Loads overlap (approvals, search, project switches). A response renders
  // only if it was requested after the one on screen, so an older response
  // can never replace newer data, and a newer one is never held back.
  // A "Show more" page is appended only to the list it was requested against.
  const issued = useRef(0); const applied = useRef(0); const resets = useRef(0); const [paging, setPaging] = useState(false);
  const load = useCallback(async (offset = 0) => {
    const ticket = ++issued.current; const reset = offset === 0 ? ++resets.current : resets.current;
    const next = await api<MemoryPage>('memoryPage', { projectId: project.id, offset, limit: PAGE, filter, search });
    if (ticket <= applied.current || (offset && reset !== resets.current)) return;
    applied.current = ticket;
    setPage(next); setItems(current => offset ? [...current, ...next.items] : next.items);
  }, [project.id, filter, search]);
  useEffect(() => { const timer = setTimeout(() => void load(0).catch(onError), search ? 150 : 0); return () => clearTimeout(timer); }, [load, version, search, onError]);
  useEffect(() => { if (!fetchOwn) return; let current = true; void api<Proposal[]>('proposals', { projectId: project.id }).then(next => { if (current) setOwn(next); }).catch(onError); return () => { current = false; }; }, [project.id, version, onError, fetchOwn]);
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
  const counts = page?.counts ?? {};
  return <div className="panel-content"><div className="section-heading"><div><h2>{copy.memory}</h2></div><button className="icon-button" aria-label={copy.addNote} onClick={() => onEdit({})}>＋</button></div><p className="muted panel-intro">{copy.aboutProject} and {copy.branchStands} reach every session. Relevant decisions, rules and lessons are added for the task.</p>
    <div className="brief-actions"><button onClick={() => onEdit({ initialCategory: 'brief' })}>{copy.addSummary}</button><button disabled={busy || !project.branch} onClick={() => onPropose('branch')}>Propose branch update</button><button disabled={busy} onClick={() => onPropose('checkout')}>Propose overview</button></div>
    {proposals.length > 0 && <section className="proposal-inbox" aria-label={copy.suggestions}><span className="eyebrow">{copy.suggestions} · {proposals.length}</span>
      {proposals.map(proposal => <article key={proposal.id} className="proposal"><p dir="auto">{proposal.statement}</p><small className="muted">{proposal.kind === 'rule' ? 'You stated this rule in a task' : proposal.kind === 'test-command' ? 'Seen passing in your sessions' : 'Branch moved after a session'} · {category(proposal.category, proposal.scope)}{proposal.branch ? ` · ⑂ ${proposal.branch}` : ''}</small>
        <div className="memory-actions">{proposal.kind === 'branch-status' ? <button disabled={proposal.branch !== project.branch} title={proposal.branch !== project.branch ? `Switch to ${proposal.branch} to update it` : undefined} onClick={() => onPropose('branch')}>Propose branch update</button>
          : <button className="approve" disabled={pending} onClick={() => void act(() => api('acceptProposal', { id: proposal.id }))}>Add for review</button>}<button disabled={pending} onClick={() => void act(() => api('dismissProposal', { id: proposal.id }))}>Dismiss</button></div></article>)}
    </section>}
    <input className="knowledge-search" aria-label={copy.searchMemory} placeholder={`${copy.searchMemory}…`} value={search} onChange={e => setSearch(e.target.value)} maxLength={200} />
    <div className="filter-tabs"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Current</button><button aria-pressed={filter === 'review'} onClick={() => setFilter('review')}>{copy.needsReview} <span>{counts.candidate ?? 0}</span></button><button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>{copy.remembered}</button><button aria-pressed={filter === 'history'} onClick={() => setFilter('history')}>History</button></div>
    <div className="memory-list">{items.map(memory => <article className="memory-card" key={memory.id}><div className="memory-meta"><span>{category(memory.category, memory.scope)}{memory.pinned ? ' · pinned' : ''}{memory.promotedFrom ? ` · from ⑂ ${memory.promotedFrom.branch}` : ''}</span><span className={`memory-state ${memory.validation !== 'current' ? 'stale' : memory.status}`}>{memoryState(memory)}</span></div><p dir="auto">{memory.statement}</p><div className="memory-scope">{memory.scope === 'branch' ? `⑂ ${copy.onlyOn(memory.branch)}` : copy.allBranches}{memory.area && ` · ${memory.area}`}{memory.environment && ` · applies when: ${memory.environment}`} · r{memory.revision}</div>
      {memory.category === 'brief' && memory.scope === 'branch' && (memory as Memory & { createdAt?: string }).createdAt ? <p className={memory.drift ? 'memory-drift' : 'memory-age'}>Updated {Math.max(0, Math.floor((Date.now() - Date.parse((memory as Memory & { createdAt: string }).createdAt)) / 86400000))} day(s) ago{memory.drift ? ` · ${memory.drift} commit${memory.drift === 1 ? '' : 's'} since` : ''}</p> : memory.drift ? <p className="memory-drift">{memory.drift} commit{memory.drift === 1 ? '' : 's'} since this update</p> : null}
      {memory.status === 'candidate' && memory.conflicts?.length ? <div className="memory-conflict" role="note"><strong>Possible conflict</strong>{memory.conflicts.map(c => <span key={c.id}>r{c.revision}: {c.statement}</span>)}</div> : null}
      <button className="source-button" aria-expanded={expanded === memory.id} onClick={() => setExpanded(expanded === memory.id ? null : memory.id)}>{memory.source.kind === 'file' ? `↗ ${memory.source.rootId ? `${project.roots?.find(root => root.id === memory.source.rootId)?.name ?? '(removed folder)'}/` : ''}${memory.source.path}:${memory.source.startLine}` : memory.source.kind === 'git' ? `↗ Git ${memory.source.base ? `${memory.source.base.slice(0, 7)}..` : ''}${memory.source.head?.slice(0, 7)}` : '↗ Your statement'} <span>{expanded === memory.id ? '−' : '+'}</span></button>
      {expanded === memory.id && <div className="evidence-details"><pre dir="auto">{memory.source.kind === 'git' ? `Commits ${memory.source.base ?? 'up to'} → ${memory.source.head}${memory.source.commitCount != null ? ` (${memory.source.commitCount} at capture)` : ''}` : memory.source.excerpt ?? memory.source.note}</pre>{memory.source.contentHash && <small>Source fingerprint {memory.source.contentHash.slice(0, 12)}</small>}<small>Revision {memory.revisionId}</small></div>}
      <div className="memory-actions">{memory.status === 'candidate' && <>{noteActions(memory, project, workspaces).approve && <button className="approve" disabled={(memory.validation !== 'current' && memory.validation !== 'wrong-branch') || busy || pending} title={tip.remember} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'active' }), { optimistic: true })}>{copy.remember}</button>}<button disabled={busy || pending} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'rejected' }), { optimistic: true })}>Reject</button></>}{memory.category === 'brief' && memory.status !== 'rejected' && memory.status !== 'archived' && (memory.scope === 'checkout' || memory.branch === project.branch) && <button disabled={busy} onClick={() => onPropose(memory.scope)}>Propose update</button>}{memory.status === 'active' && memory.category !== 'brief' && <button disabled={pending} onClick={() => void act(() => api('setPinned', { id: memory.id, pinned: !memory.pinned }), { optimistic: true })}>{memory.pinned ? 'Unpin' : 'Pin'}</button>}{memory.status === 'active' && memory.scope === 'branch' && memory.category !== 'brief' && <button disabled={pending} onClick={() => void act(() => api('proposePromotion', { id: memory.id }))}>Propose for all branches</button>}{noteActions(memory, project, workspaces).revise && <button onClick={() => onEdit({ memory })}>Revise</button>}{memory.status === 'active' && memory.category !== 'brief' && (memory.scope === 'checkout' || memory.branch === project.branch) && <button onClick={() => onEdit({ supersedes: memory })}>Replace…</button>}{memory.status === 'active' && <button title={tip.forget} disabled={pending} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'archived' }), { optimistic: true })}>{copy.forget}</button>}</div>
    </article>)}{page && !items.length && <div className="knowledge-empty"><span>◇</span><h3>{search ? 'No matching notes' : filter === 'review' ? 'Nothing waiting for review' : 'Keep the useful parts.'}</h3><p>Add a decision, a rule or a lesson.<br />Agents get it once you remember it.</p>{!search && <button onClick={() => onEdit({})}>{copy.addNote}</button>}</div>}</div>
    {page && items.length < page.total && <button className="load-more" disabled={paging || pending} onClick={() => { setPaging(true); void load(items.length).catch(onError).finally(() => setPaging(false)); }}>Show more ({page.total - items.length} remaining)</button>}
  </div>;
}
