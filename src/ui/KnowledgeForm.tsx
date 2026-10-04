import { useRef, useState } from 'react';
import { api, type Memory, type Project, type StatusDraft } from './types';
import { category as categoryName, copy } from './copy';
import { useModalDialog } from './useModalDialog';

const placeholder = /\[describe[^\]]*\]/;

export function KnowledgeForm({ project, memory: revising, supersedes, initialCategory, draft, initialSource, onClose, onSaved }: { project: Project; memory?: Memory; supersedes?: Memory; initialCategory?: string; draft?: StatusDraft; initialSource?: { kind: 'file'; path: string; startLine: number; endLine: number; rootId?: string }; onClose: () => void; onSaved: () => void }) {
  // Replacing a claim starts from its content but saves a new claim that retires the old one on approval.
  const memory = revising ?? supersedes;
  const dialog = useRef<HTMLDialogElement>(null);
  const [statement, setStatement] = useState(draft?.statement ?? memory?.statement ?? ''); const [category, setCategory] = useState(draft ? 'brief' : memory?.category ?? initialCategory ?? 'constraint');
  const [scope, setScope] = useState(draft?.scope ?? memory?.scope ?? (initialCategory === 'brief' ? 'checkout' : project.branch ? 'branch' : 'checkout')); const [area, setArea] = useState(memory?.area ?? ''); const [environment, setEnvironment] = useState(memory?.environment ?? '');
  const [kind, setKind] = useState(draft ? 'git' : memory?.source.kind ?? initialSource?.kind ?? 'user');
  // A proposal or an existing Git-backed update can keep its commit range as evidence.
  const gitBase = draft ? draft.source.base : memory?.source.kind === 'git' ? memory.source.base ?? null : undefined;
  const memoryId = draft ? draft.memoryId ?? undefined : supersedes ? undefined : memory?.id; const [note, setNote] = useState(memory?.source.note ?? '');
  const [path, setPath] = useState(memory?.source.path ?? initialSource?.path ?? ''); const [rootId, setRootId] = useState((memory?.source as { rootId?: string } | undefined)?.rootId ?? initialSource?.rootId ?? ''); const [startLine, setStartLine] = useState(memory?.source.startLine ?? initialSource?.startLine ?? 1); const [endLine, setEndLine] = useState(memory?.source.endLine ?? initialSource?.endLine ?? 1);
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  useModalDialog(dialog);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if (placeholder.test(statement)) { setError('Replace the bracketed placeholders with the reviewed status before saving.'); return; }
    setSaving(true);
    try {
      await api('proposeMemory', { projectId: project.id, input: { memoryId, supersedes: supersedes?.id, statement, category, scope, area, environment,
        source: kind === 'file' ? { kind, path, startLine, endLine, ...(rootId ? { rootId } : {}) } : kind === 'git' ? { kind, base: gitBase ?? null } : { kind, note } } });
      onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save the note'); }
    finally { setSaving(false); }
  }
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="knowledge-title" className="knowledge-dialog">
    <form onSubmit={save}>
      <div className="dialog-heading"><div><span className="eyebrow">Project memory</span><h2 id="knowledge-title">{draft ? `Review: ${draft.scope === 'branch' ? copy.branchStands : copy.aboutProject}` : supersedes ? 'Replace note' : memory ? 'Revise note' : copy.addNote}</h2></div><button type="button" onClick={onClose} aria-label="Close note form" className="icon-button">×</button></div>
      {draft && <section className="draft-basis" aria-label="Draft basis"><p>Drafted from Git: {draft.basis.commitCount !== undefined ? `${draft.basis.commitCount} commit${draft.basis.commitCount === 1 ? '' : 's'} since ${draft.basis.label}` : `compared with ${draft.basis.label}`}{draft.basis.changedFiles !== undefined && ` · ${draft.basis.changedFiles} changed file${draft.basis.changedFiles === 1 ? '' : 's'}`}{draft.basis.uncommitted ? ` · ${draft.basis.uncommitted} uncommitted` : ''}.{draft.previousRevision ? ` Saving creates revision ${draft.previousRevision + 1} of the current update.` : ''} Nothing is saved until you choose Save for review, and agents get it only after you remember it.</p>
        {draft.basis.carried?.length ? <p>Carried over from the previous update: {draft.basis.carried.join(' and ')}. Confirm they still hold.</p> : null}
        {draft.basis.structureChanges?.length ? <p>Structure changes: {draft.basis.structureChanges.join(', ')}</p> : null}
        {draft.basis.notes.map(note => <p key={note}>{note}</p>)}</section>}
      <p className="muted">{category === 'brief' ? `${copy.aboutProject} and ${copy.branchStands} reach every session. Describe the repo purpose and structure, or the current branch progress and next step. Revise it when the state changes.` : 'Save a note and its source. Agents get it only after you remember it.'}</p>
      <label>Statement<textarea autoFocus required maxLength={2000} value={statement} onChange={e => setStatement(e.target.value)} placeholder={category === 'brief' ? 'Purpose: …\nStructure: …\nCurrent status: …\nNext step: …' : 'What should the next session know?'} rows={category === 'brief' ? 6 : 3} /></label>
      <div className="form-row"><label>Category<select value={category} onChange={e => { setCategory(e.target.value); if (e.target.value === 'brief') setArea(''); }}>{['brief', 'constraint', 'decision', 'convention', 'lesson', 'issue'].map(x => <option key={x} value={x}>{x === 'brief' ? `${copy.projectSummary} (${copy.aboutProject} or ${copy.branchStands})` : categoryName(x)}</option>)}</select></label>
      <label>Scope<select value={scope} onChange={e => setScope(e.target.value as 'branch' | 'checkout')}><option value="branch" disabled={!project.branch || !!rootId}>{category === 'brief' ? `${copy.branchStands} · ${copy.onlyOn(project.branch)}` : copy.onlyOn(project.branch)}</option><option value="checkout">{category === 'brief' ? `${copy.aboutProject} · ${copy.allBranches.toLowerCase()}` : copy.allBranches}</option></select></label></div>
      {category !== 'brief' && <label>Applies when <span className="optional">optional · for example "macOS only" or "with Docker running"</span><input value={environment} onChange={e => setEnvironment(e.target.value)} maxLength={200} /></label>}
      {category !== 'brief' && <label>Area path <span className="optional">optional</span><input value={area} onChange={e => setArea(e.target.value)} placeholder="Whole checkout, or e.g. src/runtime" maxLength={1024} /></label>}
      <label>Source type<select value={kind} onChange={e => setKind(e.target.value as 'user' | 'file' | 'git')}>{gitBase !== undefined && <option value="git">Git history{gitBase ? ` since ${gitBase.slice(0, 7)}` : ' at current HEAD'}</option>}<option value="user">My explicit statement</option><option value="file">Project file</option></select></label>
      {kind === 'git' ? <p className="muted git-source">Evidence records the commit range up to the current HEAD. Rewriting or resetting that history marks it out of date.</p>
        : kind === 'user' ? <label>{copy.sourceNote}<textarea required maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="Why is this a project rule or decision?" rows={2} /></label>
        : <>{(!!project.roots?.length || !!rootId) && <label>Folder<select value={rootId} onChange={e => { setRootId(e.target.value); if (e.target.value) setScope('checkout'); }}><option value="">Primary repository</option>{(project.roots ?? []).map(root => <option key={root.id} value={root.id}>{root.name}{root.kind === 'git' ? ' (Git)' : ' (folder)'}</option>)}{rootId && !(project.roots ?? []).some(root => root.id === rootId) && <option value={rootId}>(removed folder: choose another)</option>}</select></label>}<label>Source path<input required value={path} onChange={e => setPath(e.target.value)} placeholder="README.md" /></label><div className="form-row"><label>Start line<input type="number" min={1} value={startLine} onChange={e => setStartLine(Number(e.target.value))} /></label><label>End line<input type="number" min={startLine} max={startLine + 29} value={endLine} onChange={e => setEndLine(Number(e.target.value))} /></label></div></>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save for review'}</button></div>
    </form>
  </dialog>;
}
