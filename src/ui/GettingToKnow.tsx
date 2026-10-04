import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { FirstRunDrafts, StatusDraft } from './types';
import { cardMeta, draftLines, factsLine, hasPlaceholder, previewStatement, type FieldKey, type Fields } from './firstRunModel';
import { copy, firstRun } from './copy';

export type DraftParts = { overview: string | null; branch: string | null };
const FIELD_LABEL: Record<FieldKey, string> = { currentWork: firstRun.workingOn, next: firstRun.next, constraints: firstRun.rulesToKeep };

// Board 2, once per project (D10): Git-only drafts of "About this project" and "Where this
// branch stands", with the lines only the user can write as fields. The whole statement is
// on screen (D1); Remember saves exactly what the card shows, in one action. Nothing here
// animates: it is text the user reads and edits.
export function GettingToKnow({ drafts, branch, mark, mac, onRemember, onSkip, onEdit }: {
  drafts: FirstRunDrafts; branch: string | null; mark: string; mac: boolean;
  onRemember(parts: DraftParts): Promise<void>; onSkip(): Promise<void>; onEdit(scope: 'checkout' | 'branch', statement: string): void;
}) {
  const [fields, setFields] = useState<{ checkout: Fields; branch: Fields }>({ checkout: {}, branch: {} });
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const cards = ([['checkout', drafts.overview], ['branch', drafts.branch]] as const).filter((entry): entry is ['checkout' | 'branch', StatusDraft] => !!entry[1]);
  const statements = Object.fromEntries(cards.map(([scope, draft]) => [scope, previewStatement(draft.statement, fields[scope])])) as Partial<Record<'checkout' | 'branch', string>>;
  const blocked = cards.some(([scope]) => hasPlaceholder(statements[scope]!));
  const facts = factsLine(drafts.overview?.basis.facts);
  const keys = mac ? '⌘↵' : 'Ctrl+Enter';

  async function remember(event?: FormEvent) {
    event?.preventDefault();
    if (saving || blocked || !cards.length) return;
    setSaving(true); setError('');
    try { await onRemember({ overview: statements.checkout ?? null, branch: statements.branch ?? null }); }
    catch (failure) { setError(firstRun.rememberFailed(failure instanceof Error ? failure.message : String(failure))); }
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
      <div className="know-header"><img src={mark} alt="" width={40} height={40} /><div><h2 id="know-title">{firstRun.knowTitle}</h2>{facts && <p className="muted">{facts}</p>}</div></div>
      {drafts.overview ? <DraftCard scope="checkout" draft={drafts.overview} branch={branch} fields={fields.checkout} statement={statements.checkout!}
        onField={(key, value) => setFields(current => ({ ...current, checkout: { ...current.checkout, [key]: value } }))} onEdit={() => onEdit('checkout', previewStatement(drafts.overview!.statement, fields.checkout, { keepEmpty: true }))} />
        : drafts.overviewSkipped && <p className="muted know-skipped">{firstRun.noProject.failed}</p>}
      {drafts.branch ? <DraftCard scope="branch" draft={drafts.branch} branch={drafts.branchName} fields={fields.branch} statement={statements.branch!}
        onField={(key, value) => setFields(current => ({ ...current, branch: { ...current.branch, [key]: value } }))} onEdit={() => onEdit('branch', previewStatement(drafts.branch!.statement, fields.branch, { keepEmpty: true }))} />
        : drafts.branchSkipped && <p className="muted know-skipped">{firstRun.noBranch[drafts.branchSkipped]}</p>}
      <div className="know-actions">
        <button type="submit" className="primary" disabled={saving || blocked || !cards.length} aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}>{cards.length > 1 ? firstRun.rememberBoth : firstRun.rememberOne}<kbd aria-hidden="true">{keys}</kbd></button>
        <button type="button" disabled={saving} onClick={() => { setError(''); void onSkip().catch(failure => setError(failure instanceof Error ? failure.message : String(failure))); }}>{firstRun.skip}</button>
        <span className="muted">{firstRun.editLater}</span>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
    <aside className="know-how" aria-labelledby="know-how-title">
      <h2 id="know-how-title">{firstRun.howTitle}</h2>
      <ol>{firstRun.howSteps.map(step => <li key={step.title}><strong>{step.title}</strong><span>{step.body}</span></li>)}</ol>
    </aside>
  </div>;
}

function DraftCard({ scope, draft, branch, fields, statement, onField, onEdit }: {
  scope: 'checkout' | 'branch'; draft: StatusDraft; branch: string | null; fields: Fields; statement: string;
  onField(key: FieldKey, value: string): void; onEdit(): void;
}) {
  const id = useId(); const meta = cardMeta(draft);
  const title = scope === 'checkout' ? firstRun.aboutProject : firstRun.branchStands;
  const lines = draftLines(draft.statement);
  const hasWorkFields = lines.some(line => line.kind === 'field' && line.key !== 'constraints');
  return <section className="draft-card" aria-labelledby={`${id}-title`}>
    <div className="draft-tags"><span id={`${id}-title`} className="draft-title">{title}</span><span>{scope === 'checkout' ? copy.allBranches : copy.onlyOn(branch)}</span><span className="chip draft-badge">{meta.badge}</span><span className={`draft-source${scope === 'checkout' ? ' mono' : ''}`}>{meta.source}</span></div>
    <div className="draft-lines">{lines.map((line, index) => line.kind === 'field'
      ? <label key={index} className="draft-field"><span className="draft-label">{FIELD_LABEL[line.key]}{line.key === 'constraints' && <span className="optional">{firstRun.optional}</span>}</span>
        <input value={fields[line.key] ?? ''} maxLength={500} onChange={event => onField(line.key, event.target.value)} /></label>
      : line.label ? <div key={index} className="draft-row"><span className="draft-label">{line.label}</span><span dir="auto">{line.value}</span></div>
      : <div key={index} className="draft-verbatim" dir="auto">{line.value}</div>)}</div>
    {hasWorkFields && <p className="muted">{firstRun.onlyYou}</p>}
    {hasPlaceholder(statement) && <p className="hint">{firstRun.needsEdit}</p>}
    {draft.basis.notes.map(note => <p key={note} className="muted draft-note">{note}</p>)}
    <div><button type="button" className="text-button" aria-label={`${firstRun.edit} “${title}”`} onClick={onEdit}>{firstRun.edit}</button></div>
  </section>;
}
