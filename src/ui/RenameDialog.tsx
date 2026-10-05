import { useRef, useState } from 'react';
import { useModalDialog } from './useModalDialog';

// Renames only Journal's label; the default is restored by saving empty or "Use default".
export function RenameDialog({ title, label, value, fallback, note, onSave, onClose }: { title: string; label: string; value: string | null | undefined; fallback: string; note: string; onSave: (name: string | null) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(value ?? ''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useModalDialog(dialog);
  const save = async (next: string | null) => { setBusy(true); setError(''); try { await onSave(next); onClose(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="rename-title" className="knowledge-dialog rename-dialog">
    <form onSubmit={event => { event.preventDefault(); void save(name.trim() || null); }}>
      <div className="dialog-heading"><div><span className="eyebrow">Rename</span><h2 id="rename-title">{title}</h2></div><button type="button" onClick={onClose} aria-label="Close rename" className="icon-button">×</button></div>
      <label>{label}<input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={fallback} maxLength={120} /></label>
      <p className="muted small-print">{note}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy || !value} onClick={() => void save(null)}>Use default ({fallback})</button><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save</button></div>
    </form>
  </dialog>;
}
