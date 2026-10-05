import { useEffect, useRef, useState } from 'react';
import { api, type ProjectDetails } from './types';
import { copy } from './copy';
import { useModalDialog } from './useModalDialog';

// Journal-side project settings. Nothing here renames, moves or deletes files.
export function ManageProjectDialog({ projectId, onClose, onChanged, onRemoved }: { projectId: string; onClose: () => void; onChanged: () => void; onRemoved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [details, setDetails] = useState<ProjectDetails | null>(null); const [name, setName] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = async () => { const next = await api<ProjectDetails>('projectDetails', { id: projectId }); setDetails(next); setName(next.project.displayName ?? ''); };
  useModalDialog(dialog);
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  // reload=false after removal: the project no longer exists to load.
  const act = async (action: () => Promise<unknown>, reload = true) => { setBusy(true); setError(''); try { await action(); if (reload) { await load(); onChanged(); } } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const project = details?.project;
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="manage-title" className="knowledge-dialog manage-dialog">
    <div className="dialog-heading"><div><span className="eyebrow">Project</span><h2 id="manage-title">Manage {project?.name ?? 'project'}</h2></div><button type="button" onClick={onClose} aria-label="Close project settings" className="icon-button">×</button></div>
    {details?.missing && <p className="hint" role="status">The primary folder {project?.root} is missing or no longer the same repository. You can still remove the project from Journal; reopen the folder from its new location to keep using it.</p>}
    {project && <>
      <form className="manage-name" onSubmit={event => { event.preventDefault(); void act(() => api('renameProject', { id: projectId, name: name.trim() || null })); }}>
        <label>Display name<input value={name} onChange={e => setName(e.target.value)} placeholder={project.folderName} maxLength={120} /></label>
        <div className="dialog-actions"><button type="button" disabled={busy || !project.displayName} onClick={() => void act(() => api('renameProject', { id: projectId, name: null }))}>Use folder name ({project.folderName})</button><button className="primary" disabled={busy || (name.trim() || null) === (project.displayName ?? null)}>Save name</button></div>
        <p className="muted small-print">Only Journal's label changes. The folder on disk keeps its name.</p>
      </form>
      <label className="inline-check manage-pin"><input type="checkbox" checked={!!project.pinned} disabled={busy || details.missing} onChange={e => void act(() => api('setProjectPinned', { id: projectId, pinned: e.target.checked }))} /> Pin to the top of the project list</label>
      <section aria-label="Folders" className="manage-section"><span className="eyebrow">Folders</span>
        <ul className="workspace-list" aria-label="Project folders">
          <li><strong>Primary repository</strong><span className="badge">⑂ {project.branch ?? 'detached'}</span><code>{project.root}</code><span className="muted small-print">Sessions run here by default. Journal never modifies files here.</span>
            <span className="workspace-actions"><button disabled={busy} onClick={() => void act(() => api('revealProject', { id: projectId }))}>Reveal</button><button disabled={busy} onClick={() => void act(() => api('copyProjectPath', { id: projectId }))}>Copy Path</button></span></li>
          {details.roots.map(root => <li key={root.id}><strong>{root.name}</strong><span className="badge">{root.kind === 'git' ? `${root.gitRoot === root.path ? 'separate Git repository' : `inside Git repository ${root.gitRoot?.split(/[\\/]/).pop()}`}${root.currentBranch ? ` · ⑂ ${root.currentBranch}` : ''}` : 'folder (no Git)'}{root.nested ? ' · inside primary' : ''}{root.exists === false ? ' · missing' : ''}</span><code>{root.path}</code>
            <span className="muted small-print">Context source{root.knowledge ? ` · ${root.knowledge} note${root.knowledge === 1 ? '' : 's'}` : ''}. Choose it under Workspace to run a session there.</span>
            <span className="workspace-actions"><button disabled={busy} onClick={() => void act(() => api('removeProjectFolder', { id: projectId, rootId: root.id }))}>Remove folder from project</button></span></li>)}
        </ul>
        <div className="dialog-actions"><button disabled={busy || details.missing} onClick={() => void act(() => api('addProjectFolder', { id: projectId }))}>Add folder…</button></div>
      </section>
      <dl className="receipt-facts manage-section"><dt>{copy.memoryTab}</dt><dd>{details.counts.knowledge} notes · {details.counts.proposals} open suggestions</dd>
        <dt>Sessions</dt><dd>{details.counts.sessions} recorded · {details.counts.liveSessions} running · {details.counts.worktrees} Journal worktrees</dd></dl>
      <section className="manage-danger" aria-label="Remove project"><strong>Remove from Journal</strong><p className="muted small-print">Your files will not be deleted. You choose next whether to keep Journal's data for this project (restored if you open the folder again) or delete it.</p>
        <button disabled={busy || details.counts.liveSessions > 0} title={details.counts.liveSessions ? 'Stop running sessions first' : undefined} onClick={() => void act(async () => { const result = await api('removeProject', { id: projectId }); if (result) onRemoved(); else await load(); }, false)}>Remove from Journal…</button></section>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button onClick={onClose}>Done</button></div>
  </dialog>;
}
