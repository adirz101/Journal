import { useEffect, useState } from 'react';
import { api, type Changes, type Session } from './types';
import { shell } from './copy';

// The Files tab's Changed view. The data comes from useSessionChanges, which
// the status bar and the Files badge share; showing the view refreshes it.
export function ChangesPanel({ session, changes, loading, error: loadError, refresh }: { session: Session; changes: Changes | null; loading: boolean; error: string; refresh: () => void }) {
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null); const [diff, setDiff] = useState<{ path: string; text: string; hidden: boolean; truncated?: boolean } | null>(null);
  useEffect(() => { setOpen(null); setDiff(null); setError(''); }, [session.id]);
  // Opening the view reads the working tree again: shell commands change files without a file event.
  useEffect(() => { refresh(); }, [refresh]);
  async function toggle(path: string) {
    if (open === path) { setOpen(null); setDiff(null); return; }
    setOpen(path); setDiff(null);
    try { setDiff(await api('sessionFileDiff', { id: session.id, path })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return <div className="panel-content changes-content">
    <div className="section-heading"><div><h2>{shell.changesSinceStart}</h2><small className="muted">base {(changes?.base ?? session.head ?? '').slice(0, 7) || 'none'}</small></div><button onClick={refresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
    <p className="muted panel-intro">Working tree compared with the commit checked out when the session started. Other sessions and editors in this checkout can contribute changes too.</p>
    {(error || loadError) && <p className="form-error" role="alert">{error || loadError}</p>}
    {changes && !changes.available && <p className="hint">{changes.reason}</p>}
    {changes?.available && <>
      <div className="receipt-meta"><span>{changes.files.length} file{changes.files.length === 1 ? '' : 's'}</span><span className="additions">+{changes.additions}</span><span className="deletions">−{changes.deletions}</span>{changes.commitsSince ? <span>{changes.commitsSince} new commit{changes.commitsSince === 1 ? '' : 's'}{(changes as { folderPrefix?: string | null }).folderPrefix ? ' in the repository' : ''}</span> : null}</div>
      {!!changes.preexistingCount && <p className="hint">{changes.preexistingCount} file{changes.preexistingCount === 1 ? ' was' : 's were'} already modified when the session started; they are marked “before”.</p>}
      {changes.trees?.map(tree => <p key={tree.path} className="hint change-tree">{shell.otherTree(tree.path, tree.branch, tree.files, tree.commitsSince, tree.base.slice(0, 7))}</p>)}
      {changes.truncated && <p className="hint">Showing the first 500 files.</p>}
      <ul className="change-list">{changes.files.map(file => <li key={file.path}>
        <button className="change-row" aria-expanded={open === file.path} onClick={() => void toggle(file.path)}>
          <span className="change-path" title={file.path}>{file.from ? `${file.from} → ` : ''}{file.path}</span>
          <span className="change-badges">{file.untracked && <span className="badge">new</span>}{file.preexisting && <span className="badge">before</span>}{file.binary ? <span className="badge">binary</span> : <><span className="additions">+{file.additions ?? 0}</span><span className="deletions">−{file.deletions ?? 0}</span></>}</span>
        </button>
        {open === file.path && <div className="file-diff">
          <button className="text-button" onClick={() => void api('openPath', { id: session.id, path: file.path }).catch(e => setError(e.message))}>Open or reveal ↗</button>
          {!diff ? <p className="muted">Loading diff…</p> : diff.hidden ? <p className="hint">Content hidden for a sensitive filename.</p> : <pre aria-label={`Diff for ${file.path}`}>{diff.text || 'No textual difference.'}{diff.truncated ? '\n… diff truncated' : ''}</pre>}
        </div>}
      </li>)}</ul>
      {!changes.files.length && <div className="knowledge-empty"><h3>No changes yet</h3><p>Edits in this checkout appear here.</p></div>}
    </>}
  </div>;
}
