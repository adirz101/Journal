import { useEffect, useRef, useState } from 'react';
import { api, type Memory, type Project } from './types';

export function KnowledgeForm({ project, memory, onClose, onSaved }: { project: Project; memory?: Memory; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [statement, setStatement] = useState(memory?.statement ?? ''); const [category, setCategory] = useState(memory?.category ?? 'constraint');
  const [scope, setScope] = useState(memory?.scope ?? (project.branch ? 'branch' : 'checkout')); const [area, setArea] = useState(memory?.area ?? '');
  const [kind, setKind] = useState(memory?.source.kind ?? 'user'); const [note, setNote] = useState(memory?.source.note ?? '');
  const [path, setPath] = useState(memory?.source.path ?? ''); const [startLine, setStartLine] = useState(memory?.source.startLine ?? 1); const [endLine, setEndLine] = useState(memory?.source.endLine ?? 1);
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(''); setSaving(true);
    try {
      await api('proposeMemory', { projectId: project.id, input: { memoryId: memory?.id, statement, category, scope, area,
        source: kind === 'file' ? { kind, path, startLine, endLine } : { kind, note } } });
      onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save knowledge'); }
    finally { setSaving(false); }
  }
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="knowledge-title" className="knowledge-dialog">
    <form onSubmit={save}>
      <div className="dialog-heading"><div><span className="eyebrow">PROJECT KNOWLEDGE</span><h2 id="knowledge-title">{memory ? 'Revise knowledge' : 'Add knowledge'}</h2></div><button type="button" onClick={onClose} aria-label="Close knowledge form" className="icon-button">×</button></div>
      <p className="muted">Save a claim and its source. Review it before either agent receives it.</p>
      <label>Statement<textarea autoFocus required maxLength={2000} value={statement} onChange={e => setStatement(e.target.value)} placeholder="What should the next session know?" rows={3} /></label>
      <div className="form-row"><label>Category<select value={category} onChange={e => setCategory(e.target.value)}>{['constraint', 'decision', 'convention', 'lesson', 'issue'].map(x => <option key={x}>{x}</option>)}</select></label>
      <label>Scope<select value={scope} onChange={e => setScope(e.target.value as 'branch' | 'checkout')}><option value="branch" disabled={!project.branch}>This branch</option><option value="checkout">This checkout</option></select></label></div>
      <label>Area path <span className="optional">optional</span><input value={area} onChange={e => setArea(e.target.value)} placeholder="Whole checkout, or e.g. src/runtime" maxLength={1024} /></label>
      <label>Source type<select value={kind} onChange={e => setKind(e.target.value as 'user' | 'file')}><option value="user">My explicit statement</option><option value="file">Tracked project file</option></select></label>
      {kind === 'user' ? <label>Source note<textarea required maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="Why is this a project rule or decision?" rows={2} /></label>
        : <><label>Source path<input required value={path} onChange={e => setPath(e.target.value)} placeholder="README.md" /></label><div className="form-row"><label>Start line<input type="number" min={1} value={startLine} onChange={e => setStartLine(Number(e.target.value))} /></label><label>End line<input type="number" min={startLine} max={startLine + 29} value={endLine} onChange={e => setEndLine(Number(e.target.value))} /></label></div></>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save for review'}</button></div>
    </form>
  </dialog>;
}
