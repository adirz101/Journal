import { useCallback, useEffect, useState } from 'react';
import { api, type Changes, type Session } from './types';

// fileEvents: count of observed file edits; a change refreshes the list.
export function ChangesPanel({ session, fileEvents = 0 }: { session: Session; fileEvents?: number }) {
  const [changes, setChanges] = useState<Changes | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null); const [diff, setDiff] = useState<{ path: string; text: string; hidden: boolean; truncated?: boolean } | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { setChanges(await api<Changes>('sessionChanges', { id: session.id })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
  }, [session.id]);
  useEffect(() => { setChanges(null); setOpen(null); setDiff(null); void refresh(); }, [refresh]);
  useEffect(() => { if (!fileEvents) return; const timer = setTimeout(() => void refresh(), 500); return () => clearTimeout(timer); }, [fileEvents, refresh]);
  async function toggle(path: string) {
    if (open === path) { setOpen(null); setDiff(null); return; }
    setOpen(path); setDiff(null);
    try { setDiff(await api('sessionFileDiff', { id: session.id, path })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return <div className="panel-content changes-content">
    <div className="section-heading"><div><span className="eyebrow">SINCE THIS SESSION STARTED</span><h2>Changes</h2></div><button onClick={() => void refresh()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
    <p className="muted panel-intro">Working tree compared with the commit checked out when the session started ({(changes?.base ?? session.head ?? '').slice(0, 7) || 'none'}). Other sessions and editors in this checkout can contribute changes too.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {changes && !changes.available && <p className="hint">{changes.reason}</p>}
    {changes?.available && <>
      <div className="receipt-meta"><span>{changes.files.length} file{changes.files.length === 1 ? '' : 's'}</span><span className="additions">+{changes.additions}</span><span className="deletions">−{changes.deletions}</span>{changes.commitsSince ? <span>{changes.commitsSince} new commit{changes.commitsSince === 1 ? '' : 's'}{(changes as { folderPrefix?: string | null }).folderPrefix ? ' in the repository' : ''}</span> : null}</div>
      {!!changes.preexistingCount && <p className="hint">{changes.preexistingCount} file{changes.preexistingCount === 1 ? ' was' : 's were'} already modified when the session started; they are marked “before”.</p>}
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
