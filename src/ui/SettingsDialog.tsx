import { useEffect, useRef, useState } from 'react';
import { api, type Preferences, type Project, type UpdateState } from './types';
import { UpdateSettings } from './UpdateNotice';
import { useModalDialog } from './useModalDialog';
import { shell } from './copy';
import type { Appearance } from './theme';

interface StorageInfo { database: number; wal: number; tables: Record<string, number>; freeBytes: number | null; lowDisk: boolean | null; }
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Appearance, notifications, updates and local data in one dialog (footer
// Settings, the Settings… menu item, ⌘, / Ctrl+,).
export function SettingsDialog({ appearance, onAppearance, update, project, onClose, onDataChanged }: {
  appearance: Appearance; onAppearance(appearance: Appearance): void; update: UpdateState | null; project: Project | null; onClose(): void; onDataChanged(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<StorageInfo | null>(null); const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useModalDialog(dialog);
  const failed = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  useEffect(() => { void api<StorageInfo>('storageInfo').then(setInfo).catch(failed); void api<Preferences>('preferences').then(setPreferences).catch(failed); }, []);
  // Shown at once; main's stored values replace it, or the previous ones come back on failure.
  const prefer = (key: keyof Preferences, value: boolean) => {
    const before = preferences; setError(''); setPreferences(current => current && { ...current, [key]: value });
    void api<Preferences>('setPreference', { key, value }).then(setPreferences).catch(e => { setPreferences(before); failed(e); });
  };
  const act = async (action: () => Promise<string | null>) => { setBusy(true); setError(''); setMessage(''); try { const text = await action(); if (text) setMessage(text); onDataChanged(); } catch (e) { failed(e); } finally { setBusy(false); } };
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="settings-title" className="knowledge-dialog settings-dialog">
    <div className="dialog-heading"><h2 id="settings-title">{shell.settings}</h2><button type="button" onClick={onClose} aria-label="Close settings" className="icon-button">×</button></div>
    <section className="settings-section" aria-labelledby="settings-appearance"><h3 id="settings-appearance">{shell.appearance}</h3>
      <div role="radiogroup" aria-labelledby="settings-appearance" className="settings-choices">
        {(['dark', 'light'] as const).map(value => <label key={value} className="inline-check"><input type="radio" name="appearance" checked={appearance === value} onChange={() => onAppearance(value)} /> {value === 'dark' ? shell.dark : shell.light}</label>)}
      </div></section>
    <section className="settings-section" aria-labelledby="settings-notifications"><h3 id="settings-notifications">{shell.notifications}</h3>
      {/* Shown once the stored values are known, never as a guessed state. */}
      {preferences ? <><label className="inline-check"><input type="checkbox" checked={preferences.notifications} onChange={e => prefer('notifications', e.target.checked)} /> {shell.notifyApproval}</label>
        <label className="inline-check"><input type="checkbox" disabled={!preferences.notifications} checked={preferences.notificationCommand} onChange={e => prefer('notificationCommand', e.target.checked)} aria-describedby="settings-command-hint" /> {shell.notifyCommand}</label></>
        : <p className="muted">Loading…</p>}
      <p className="muted small-print" id="settings-command-hint">{shell.notifyCommandHint}</p></section>
    {/* Its own section, headed Updates. */}
    <UpdateSettings state={update} />
    <section className="settings-section" aria-labelledby="settings-data"><h3 id="settings-data">{shell.dataAndBackups}</h3>
      <p className="muted">Everything stays on this device. Terminal output is never stored; timelines of sessions that ended more than 90 days ago are trimmed automatically. Project memory is never pruned.</p>
      {info && <dl className="receipt-facts"><dt>Database</dt><dd>{mb(info.database)} + {mb(info.wal)} write-ahead log</dd>
        <dt>Records</dt><dd>{info.tables.memories} notes · {info.tables.sessions} sessions · {info.tables.events} timeline events · {info.tables.receipts} records of what was sent</dd>
        <dt>Free space</dt><dd>{info.freeBytes === null ? 'unknown' : mb(info.freeBytes)}{info.lowDisk ? ' · low: free space to keep saving' : ''}</dd></dl>}
      <div className="brief-actions">
        <button disabled={busy} onClick={() => void act(async () => { const r = await api<{ path: string; bytes: number } | null>('backupData'); return r ? `Backup saved (${mb(r.bytes)}, integrity checked): ${r.path}` : null; })}>Back up all data…</button>
        {project && <button disabled={busy} onClick={() => void act(async () => { const r = await api<{ path: string; memories: number; markdown: string | null } | null>('exportBrain', { projectId: project.id }); return r ? `Exported ${r.memories} remembered notes to ${r.path}${r.markdown ? ' and a Markdown copy' : ' (Markdown copy skipped: a file with that name exists)'}.` : null; })}>Export {project.name} memory…</button>}
        {project && <button disabled={busy} onClick={() => void act(async () => { const r = await api<{ imported: number; skipped: unknown[] } | null>('importBrain', { projectId: project.id }); return r ? `Imported ${r.imported} notes for review; skipped ${r.skipped.length}. They wait in Needs review.` : null; })}>Import notes…</button>}
      </div>
      <p className="muted small-print">Restore a backup with Journal closed: <code>npm run data:restore -- &lt;backup.sqlite&gt;</code>. The current database is kept beside the restored one. Add <code>--force</code> only if Journal crashed and left a lock behind.</p>
    </section>
    {message && <p className="hint" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button onClick={onClose}>Done</button></div>
  </dialog>;
}
