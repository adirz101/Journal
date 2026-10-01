import { useEffect, useRef, useState } from 'react';
import { api, type Project } from './types';

interface StorageInfo { database: number; wal: number; tables: Record<string, number>; freeBytes: number | null; lowDisk: boolean | null; }
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function DataDialog({ project, onClose, onChanged }: { project: Project | null; onClose: () => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<StorageInfo | null>(null); const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); void api<StorageInfo>('storageInfo').then(setInfo).catch(e => setError(e.message)); }, []);
  const act = async (action: () => Promise<string | null>) => { setBusy(true); setError(''); setMessage(''); try { const text = await action(); if (text) setMessage(text); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="data-title" className="knowledge-dialog">
    <div className="dialog-heading"><div><span className="eyebrow">LOCAL DATA</span><h2 id="data-title">Data and backups</h2></div><button type="button" onClick={onClose} aria-label="Close data" className="icon-button">×</button></div>
    <p className="muted">Everything stays on this device. Terminal output is never stored; timelines of sessions that ended more than 90 days ago are trimmed automatically. Knowledge is never pruned.</p>
    {info && <dl className="receipt-facts"><dt>Database</dt><dd>{mb(info.database)} + {mb(info.wal)} write-ahead log</dd>
      <dt>Records</dt><dd>{info.tables.memories} claims · {info.tables.sessions} sessions · {info.tables.events} timeline events · {info.tables.receipts} receipts</dd>
      <dt>Free space</dt><dd>{info.freeBytes === null ? 'unknown' : mb(info.freeBytes)}{info.lowDisk ? ' · low: free space to keep saving' : ''}</dd></dl>}
    <div className="brief-actions">
      <button disabled={busy} onClick={() => void act(async () => { const r = await api<{ path: string; bytes: number } | null>('backupData'); return r ? `Backup saved (${mb(r.bytes)}, integrity checked): ${r.path}` : null; })}>Back up all data…</button>
      {project && <button disabled={busy} onClick={() => void act(async () => { const r = await api<{ path: string; memories: number } | null>('exportBrain', { projectId: project.id }); return r ? `Exported ${r.memories} claims to ${r.path} (and a Markdown copy).` : null; })}>Export {project.name} knowledge…</button>}
      {project && <button disabled={busy} onClick={() => void act(async () => { const r = await api<{ imported: number; skipped: unknown[] } | null>('importBrain', { projectId: project.id }); return r ? `Imported ${r.imported} claims for review; skipped ${r.skipped.length}. Imported claims wait in Needs review.` : null; })}>Import knowledge…</button>}
    </div>
    <p className="muted small-print">Restore a backup with Journal closed: <code>npm run data:restore -- &lt;backup.sqlite&gt;</code>. The current database is kept beside the restored one.</p>
    {message && <p className="hint" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button onClick={onClose}>Done</button></div>
  </dialog>;
}
