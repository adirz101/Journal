import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { FirstRunDrafts, StatusDraft } from './types';
import { cardMeta, draftLines, factsLine, previewStatement, type FieldKey, type Fields } from './firstRunModel';
import { copy, firstRun } from './copy';

export type DraftParts = { overview: string | null; branch: string | null };
// Remember refused because the project moved (App checked the checkout): Draft again is offered.
export class DraftsMoved extends Error { constructor() { super(firstRun.moved); } }
const FIELD_LABEL: Record<FieldKey, string> = { purpose: firstRun.purpose, currentWork: firstRun.workingOn, next: firstRun.next, constraints: firstRun.rulesToKeep };

// Board 2, once per project (D10): Git-only drafts of "About this project" and "Where this
// branch stands", with the lines only the user can write as fields. The whole statement is
// on screen (D1); Remember saves exactly what the card shows, in one action. Nothing here
// animates: it is text the user reads and edits.
// On entry the heading takes focus, so ⌘↵ / Ctrl+Enter works at once; once the screen has
// painted, onShown tells main it was seen (a reply never painted is offered again).
export function GettingToKnow({ drafts, branch, mark, mac, onRemember, onSkip, onEdit, onRedraft, onShown }: {
  drafts: FirstRunDrafts; branch: string | null; mark: string; mac: boolean;
  onRemember(parts: DraftParts): Promise<void>; onSkip(): Promise<void>; onEdit(scope: 'checkout' | 'branch', statement: string): void;
  onRedraft(): Promise<void>; onShown(projectId: string): void;
}) {
  const [fields, setFields] = useState<{ checkout: Fields; branch: Fields }>({ checkout: {}, branch: {} });
  const [error, setError] = useState<{ message: string; moved: boolean } | null>(null); const [saving, setSaving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(onShown); shown.current = onShown;
  const projectId = drafts.projectId;
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    // After the next paint: a frame callback runs just before it; a task queued from there runs after it.
    let timer = 0; const frame = requestAnimationFrame(() => { timer = window.setTimeout(() => shown.current(projectId), 0); });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [projectId]);
  const cards = ([['checkout', drafts.overview], ['branch', drafts.branch]] as const).filter((entry): entry is ['checkout' | 'branch', StatusDraft] => !!entry[1]);
  const statements = Object.fromEntries(cards.map(([scope, draft]) => [scope, previewStatement(draft.statement, fields[scope])])) as Partial<Record<'checkout' | 'branch', string>>;
  const facts = factsLine(drafts.overview?.basis.facts);
  const keys = mac ? '⌘↵' : 'Ctrl+Enter';

  async function remember(event?: FormEvent) {
    event?.preventDefault();
    if (saving || !cards.length) return;
    setSaving(true); setError(null);
    try { await onRemember({ overview: statements.checkout ?? null, branch: statements.branch ?? null }); }
    catch (failure) {
      const moved = failure instanceof DraftsMoved;
      setError({ message: moved ? failure.message : firstRun.rememberFailed(failure instanceof Error ? failure.message : String(failure)), moved });
    } finally { setSaving(false); }
  }
  async function redraft() {
    if (saving) return;
    setSaving(true);
    try { await onRedraft(); setError(null); heading.current?.focus({ preventScroll: true }); }
    catch (failure) { setError({ message: failure instanceof Error ? failure.message : String(failure), moved: true }); }
    finally { setSaving(false); }
  }
  // ⌘↵ / Ctrl+Enter anywhere in the form remembers; Enter in a field moves to the next one.
  function keyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) { event.preventDefault(); void remember(); return; }
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      const inputs = [...event.currentTarget.querySelectorAll('input')]; inputs[inputs.indexOf(target) + 1]?.focus();
    }
  }

  return <div className="get-to-know">
    <form className="get-to-know-main" onSubmit={remember} onKeyDown={keyDown} aria-labelledby="know-title">
      <div className="know-header"><img src={mark} alt="" width={40} height={40} /><div><h2 id="know-title" ref={heading} tabIndex={-1}>{firstRun.knowTitle}</h2>{facts && <p className="muted">{facts}</p>}</div></div>
      {drafts.overview ? <DraftCard scope="checkout" draft={drafts.overview} branch={branch} fields={fields.checkout}
        onField={(key, value) => setFields(current => ({ ...current, checkout: { ...current.checkout, [key]: value } }))} onEdit={() => onEdit('checkout', previewStatement(drafts.overview!.statement, fields.checkout, { keepEmpty: true }))} />
        : drafts.overviewSkipped && <p className="muted know-skipped">{firstRun.noProject.failed}</p>}
      {drafts.branch ? <DraftCard scope="branch" draft={drafts.branch} branch={drafts.branchName} fields={fields.branch}
        onField={(key, value) => setFields(current => ({ ...current, branch: { ...current.branch, [key]: value } }))} onEdit={() => onEdit('branch', previewStatement(drafts.branch!.statement, fields.branch, { keepEmpty: true }))} />
        : drafts.branchSkipped && <p className="muted know-skipped">{firstRun.noBranch[drafts.branchSkipped]}</p>}
      <div className="know-actions">
        <button type="submit" className="primary" disabled={saving || !cards.length} aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}>{cards.length > 1 ? firstRun.rememberBoth : firstRun.rememberOne}<kbd aria-hidden="true">{keys}</kbd></button>
        <button type="button" disabled={saving} onClick={() => { setError(null); void onSkip().catch(failure => setError({ message: failure instanceof Error ? failure.message : String(failure), moved: false })); }}>{firstRun.skip}</button>
        <span className="muted">{firstRun.editLater}</span>
      </div>
      {error && <div className="know-error"><p className="form-error" role="alert">{error.message}</p>
        {error.moved && <button type="button" disabled={saving} onClick={() => void redraft()}>{firstRun.draftAgain}</button>}</div>}
    </form>
    <aside className="know-how" aria-labelledby="know-how-title">
      <h2 id="know-how-title">{firstRun.howTitle}</h2>
      <ol>{firstRun.howSteps.map(step => <li key={step.title}><strong>{step.title}</strong><span>{step.body}</span></li>)}</ol>
    </aside>
  </div>;
}

function DraftCard({ scope, draft, branch, fields, onField, onEdit }: {
  scope: 'checkout' | 'branch'; draft: StatusDraft; branch: string | null; fields: Fields;
  onField(key: FieldKey, value: string): void; onEdit(): void;
}) {
  const id = useId(); const meta = cardMeta(draft);
  const title = scope === 'checkout' ? firstRun.aboutProject : firstRun.branchStands;
  const lines = draftLines(draft.statement);
  const hasWorkFields = lines.some(line => line.kind === 'field' && (line.key === 'currentWork' || line.key === 'next'));
  return <section className="draft-card" aria-labelledby={`${id}-title`}>
    <div className="draft-tags"><h3 id={`${id}-title`} className="draft-title">{title}</h3><span>{scope === 'checkout' ? copy.allBranches : copy.onlyOn(branch)}</span><span className="chip draft-badge">{meta.badge}</span><span className={`draft-source${scope === 'checkout' ? ' mono' : ''}`}>{meta.source}</span></div>
    <div className="draft-lines">{lines.map((line, index) => line.kind === 'field'
      ? <label key={index} className="draft-field"><span className="draft-label">{FIELD_LABEL[line.key]}{line.key === 'constraints' && <span className="optional">{firstRun.optional}</span>}</span>
        <input value={fields[line.key] ?? ''} maxLength={500} onChange={event => onField(line.key, event.target.value)} /></label>
      : line.label ? <div key={index} className="draft-row"><span className="draft-label">{line.label}</span><span dir="auto">{line.value}</span></div>
      : <div key={index} className="draft-verbatim" dir="auto">{line.value}</div>)}</div>
    {hasWorkFields && <p className="muted">{firstRun.onlyYou}</p>}
    {draft.basis.notes.map(note => <p key={note} className="muted draft-note">{note}</p>)}
    <div><button type="button" className="text-button" aria-label={`${firstRun.edit} “${title}”`} onClick={onEdit}>{firstRun.edit}</button></div>
  </section>;
}
