import { useEffect, useState } from 'react';
import { api, type Session } from './types';
import { runRows, type TreeRun } from './runTreeModel';
import './team.css';
export function RunNavigation({ projectId, sessions, onSelect, onOpenRun, onRuns }: { projectId: string; sessions: Session[]; onSelect(session: Session): void; onOpenRun(runId: string): void; onRuns(ids: Set<string>): void }) {
  const [runs, setRuns] = useState<TreeRun[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('journal.runCollapsed') ?? '[]')); } catch { return new Set(); } });
  useEffect(() => {
    let active = true; let pending = false;
    const refresh = async () => { if (pending) return; pending = true; try { const next = await api<TreeRun[]>('runsTree', { projectId }); if (active) { setRuns(next); onRuns(new Set(next.map(run => run.id))); } } catch { /* Older runtimes preserve ordinary navigation. */ } finally { pending = false; } };
    void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => { active = false; clearInterval(timer); };
  }, [projectId, onRuns]);
  const toggle = (id: string, close = !collapsed.has(id)) => setCollapsed(previous => { const next = new Set(previous); if (close) next.add(id); else next.delete(id); try { localStorage.setItem('journal.runCollapsed', JSON.stringify([...next])); } catch { /* storage is optional */ } return next; });
  if (!runs.length) return null;
  const rows = runRows(runs, collapsed);
  return <div className="run-navigation" aria-label="Coordinated runs"><div className="side-heading">Teams</div>{rows.map((row, index) => <div key={row.id} className={`run-nav-row ${row.kind}`}>
    {row.kind === 'run' && <button className="run-collapse" aria-label={`${collapsed.has(row.id) ? 'Expand' : 'Collapse'} ${row.title}`} aria-expanded={!collapsed.has(row.id)} onClick={() => toggle(row.id)}>{collapsed.has(row.id) ? '▸' : '▾'}</button>}
    <button id={`run-row-${row.id}`} className={`session-select${row.attention ? ' attention' : ''}`} onClick={() => { const session = sessions.find(item => item.id === row.sessionId); if (row.kind === 'run' || !session) onOpenRun(row.runId); else onSelect(session); }}
      onKeyDown={event => { if (event.key === 'ArrowLeft') { event.preventDefault(); if (row.kind === 'run') toggle(row.id, true); else document.getElementById(`run-row-${row.runId}`)?.focus(); } else if (event.key === 'ArrowRight' && row.kind === 'run') { event.preventDefault(); toggle(row.id, false); } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]; if (next) document.getElementById(`run-row-${next.id}`)?.focus(); } }}>
      <span className="session-title">{row.title}</span><span className="session-line">{row.state}{row.presence ? ` · ${row.presence}` : ''}</span>{row.detail && <span className="session-line">{row.detail}</span>} </button></div>)}</div>;
}
