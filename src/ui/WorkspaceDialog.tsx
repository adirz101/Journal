import { useEffect, useRef, useState } from 'react';
import { api, type Project, type WorkspaceList } from './types';
import { useModalDialog } from './useModalDialog';

// Managed worktrees: created from an explicit base, never forced or stashed;
// removed only when clean and idle; imported worktrees are never deleted.
export function WorkspaceDialog({ project, onClose, onChanged }: { project: Project; onClose: () => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [list, setList] = useState<WorkspaceList | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [branch, setBranch] = useState(''); const [base, setBase] = useState(project.branch ?? 'HEAD');
  const [plan, setPlan] = useState<{ id: string; path: string; notices: string[]; base: string } | null>(null);
  const [blockers, setBlockers] = useState<Record<string, string[]>>({});
  const load = async () => setList(await api<WorkspaceList>('workspaces', { projectId: project.id }));
  useModalDialog(dialog);
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await load(); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  async function preview() { setError(''); setPlan(null); try { setPlan(await api('planWorkspace', { projectId: project.id, branch, base })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="workspace-title" className="knowledge-dialog workspace-dialog">
    <div className="dialog-heading"><div><span className="eyebrow">ISOLATION</span><h2 id="workspace-title">Workspaces</h2></div><button type="button" onClick={onClose} aria-label="Close workspaces" className="icon-button">×</button></div>
    <p className="muted">Run sessions in the current checkout or in a separate Git worktree. Journal never stashes, copies or force-removes your work.</p>
    <section aria-label="Create a worktree" className="workspace-create">
      <div className="form-row"><label>New branch<input value={branch} onChange={e => { setBranch(e.target.value); setPlan(null); }} placeholder="journal/feature-name" maxLength={200} /></label>
        <label>Base branch or commit<input value={base} onChange={e => { setBase(e.target.value); setPlan(null); }} maxLength={200} /></label></div>
      {plan && <div className="draft-basis"><p>Creates <code>{branch}</code> from {base} ({plan.base.slice(0, 7)}) at <code>{plan.path}</code>.</p>{plan.notices.map(n => <p key={n}>{n}</p>)}</div>}
      <div className="dialog-actions">{!plan ? <button disabled={busy || !branch.trim()} onClick={() => void preview()}>Review</button>
        : <button className="primary" disabled={busy} onClick={() => void act(async () => { await api('createWorkspace', { projectId: project.id, branch, base, baseCommit: plan.base, planId: plan.id }); setBranch(''); setPlan(null); })}>Create worktree</button>}</div>
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <ul className="workspace-list" aria-label="Workspaces">
      {list && <li><strong>Current checkout</strong><span className="muted">⑂ {list.checkout.branch ?? 'detached HEAD'}</span><code>{list.checkout.path}</code></li>}
      {list?.workspaces.map(ws => <li key={ws.id}>
        <strong>⑂ {ws.branch ?? 'detached'}</strong><span className={`badge state-${ws.state}`}>{ws.kind} · {ws.state}</span><code>{ws.path}</code>
        {ws.error && <span className="hint">{ws.error}</span>}
        {blockers[ws.id!]?.length ? <span className="hint">{blockers[ws.id!].join(' ')}</span> : null}
        <span className="workspace-actions">
          {ws.kind === 'managed' && ws.state === 'ready' && <button disabled={busy} onClick={() => void act(async () => {
            const reasons = await api<string[]>('workspaceRemovalBlockers', { id: ws.id });
            if (reasons.length) { setBlockers(current => ({ ...current, [ws.id!]: reasons })); return; }
            await api('removeWorkspace', { id: ws.id });
          })}>Remove worktree</button>}
          {(ws.kind === 'imported' || ws.state !== 'ready') && <button disabled={busy} onClick={() => void act(() => api('forgetWorkspace', { id: ws.id }))}>Forget (keep files)</button>}
        </span>
      </li>)}
      {list?.importable.map(entry => <li key={entry.path}><strong>⑂ {entry.branch ?? 'detached'}</strong><span className="badge">existing worktree</span><code>{entry.path}</code>
        <span className="workspace-actions"><button disabled={busy} onClick={() => void act(() => api('importWorkspace', { projectId: project.id, path: entry.path }))}>Import</button></span></li>)}
    </ul>
    <div className="dialog-actions"><button onClick={onClose}>Done</button></div>
  </dialog>;
}
