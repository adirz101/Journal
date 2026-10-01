import { useCallback, useEffect, useState } from 'react';
import { api, type Memory, type MemoryPage, type Project, type StatusDraft } from './types';

const PAGE = 50;

export function KnowledgePanel({ project, version, busy, onEdit, onPropose, onChanged, onError }: {
  project: Project; version: number; busy: boolean; onEdit: (form: { memory?: Memory; initialCategory?: string; draft?: StatusDraft }) => void;
  onPropose: (scope: 'checkout' | 'branch') => void; onChanged: () => void; onError: (error: unknown) => void;
}) {
  const [filter, setFilter] = useState('all'); const [search, setSearch] = useState(''); const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState<MemoryPage | null>(null); const [items, setItems] = useState<Memory[]>([]);
  const load = useCallback(async (offset = 0) => {
    const next = await api<MemoryPage>('memoryPage', { projectId: project.id, offset, limit: PAGE, filter, search });
    setPage(next); setItems(current => offset ? [...current, ...next.items] : next.items);
  }, [project.id, filter, search]);
  useEffect(() => { const timer = setTimeout(() => void load(0).catch(onError), search ? 150 : 0); return () => clearTimeout(timer); }, [load, version, search, onError]);
  const act = async (action: () => Promise<unknown>) => { try { await action(); onChanged(); } catch (error) { onError(error); } };
  const counts = page?.counts ?? {};
  return <div className="panel-content"><div className="section-heading"><div><span className="eyebrow">A SHARED FOUNDATION</span><h2>Project knowledge</h2></div><button className="icon-button" aria-label="Add knowledge" onClick={() => onEdit({})}>＋</button></div><p className="muted panel-intro">A repo overview and current branch update orient every session. Relevant decisions and lessons add task context.</p>
    <div className="brief-actions"><button onClick={() => onEdit({ initialCategory: 'brief' })}>Add project brief</button><button disabled={busy || !project.branch} onClick={() => onPropose('branch')}>Propose branch update</button><button disabled={busy} onClick={() => onPropose('checkout')}>Propose overview</button></div>
    <input className="knowledge-search" aria-label="Search knowledge" placeholder="Search knowledge…" value={search} onChange={e => setSearch(e.target.value)} maxLength={200} />
    <div className="filter-tabs"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Current</button><button aria-pressed={filter === 'review'} onClick={() => setFilter('review')}>Needs review <span>{counts.candidate ?? 0}</span></button><button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>Approved</button><button aria-pressed={filter === 'history'} onClick={() => setFilter('history')}>History</button></div>
    <div className="memory-list">{items.map(memory => <article className="memory-card" key={memory.id}><div className="memory-meta"><span>{memory.category}</span><span className={`memory-state ${memory.validation !== 'current' ? 'stale' : memory.status}`}>{memory.validation !== 'current' ? memory.validation : memory.status === 'active' ? 'approved' : memory.status === 'candidate' ? 'needs review' : memory.status}</span></div><p dir="auto">{memory.statement}</p><div className="memory-scope">{memory.scope === 'branch' ? `⑂ ${memory.branch}` : 'This checkout'}{memory.area && ` · ${memory.area}`} · r{memory.revision}</div>
      {memory.drift ? <p className="memory-drift">{memory.drift} commit{memory.drift === 1 ? '' : 's'} since this update</p> : null}
      {memory.status === 'candidate' && memory.conflicts?.length ? <div className="memory-conflict" role="note"><strong>Possible conflict</strong>{memory.conflicts.map(c => <span key={c.id}>r{c.revision}: {c.statement}</span>)}</div> : null}
      <button className="source-button" aria-expanded={expanded === memory.id} onClick={() => setExpanded(expanded === memory.id ? null : memory.id)}>{memory.source.kind === 'file' ? `↗ ${memory.source.path}:${memory.source.startLine}` : memory.source.kind === 'git' ? `↗ Git ${memory.source.base ? `${memory.source.base.slice(0, 7)}..` : ''}${memory.source.head?.slice(0, 7)}` : '↗ Your statement'} <span>{expanded === memory.id ? '−' : '+'}</span></button>
      {expanded === memory.id && <div className="evidence-details"><pre dir="auto">{memory.source.kind === 'git' ? `Commits ${memory.source.base ?? 'up to'} → ${memory.source.head}${memory.source.commitCount != null ? ` (${memory.source.commitCount} at capture)` : ''}` : memory.source.excerpt ?? memory.source.note}</pre>{memory.source.contentHash && <small>Source fingerprint {memory.source.contentHash.slice(0, 12)}</small>}<small>Revision {memory.revisionId}</small></div>}
      <div className="memory-actions">{memory.status === 'candidate' && <><button className="approve" disabled={memory.validation !== 'current' || busy} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'active' }))}>Approve</button><button disabled={busy} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'rejected' }))}>Reject</button></>}{memory.category === 'brief' && memory.status !== 'rejected' && memory.status !== 'archived' && (memory.scope === 'checkout' || memory.branch === project.branch) && <button disabled={busy} onClick={() => onPropose(memory.scope)}>Propose update</button>}<button onClick={() => onEdit({ memory })}>Revise</button>{memory.status === 'active' && <button onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'archived' }))}>Withdraw</button>}</div>
    </article>)}{page && !items.length && <div className="knowledge-empty"><span>◇</span><h3>{search ? 'No matching knowledge' : filter === 'review' ? 'Nothing waiting for review' : 'Keep the useful parts.'}</h3><p>Add a decision, a constraint, or a lesson.<br />It becomes shared knowledge after you approve it.</p>{!search && <button onClick={() => onEdit({})}>Add knowledge</button>}</div>}</div>
    {page && items.length < page.total && <button className="load-more" onClick={() => void load(items.length).catch(onError)}>Show more ({page.total - items.length} remaining)</button>}
  </div>;
}
