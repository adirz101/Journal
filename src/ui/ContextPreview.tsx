import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { composer, copy, excludedReason } from './copy';
import { NoteCard } from './NoteCard';
import { evidenceLine } from './noteCardModel';
import { BYTE_LIMIT, meterText, NOTE_LIMIT, type PreviewItem, type PreviewView } from './composerModel';
import type { Project } from './types';

// One note in the preview or the hover card: Phase 5's NoteCard with the task
// words FTS matched. Until the sources are checked, a file note says where it is
// based and that it is checked when you start, never that the file is unchanged.
export function PreviewNote({ item, project, variant, checked, onLeaveOut }: { item: PreviewItem; project: Project; variant: 'hover' | 'preview'; checked: boolean; onLeaveOut?(): void }) {
  const terms = item.selection?.terms ?? [];
  const rootName = item.source.rootId ? project.roots?.find(root => root.id === item.source.rootId)?.name : undefined;
  const evidence = checked ? null : evidenceLine({ ...item, validation: 'current' }, rootName);
  // NoteCard reads evidence from file sources only; an unchecked note's line is written here instead.
  const note: PreviewItem = checked ? { ...item, validation: 'current' } : evidence ? { ...item, source: { kind: 'user', note: item.source.note } } : item;
  return <NoteCard note={note} project={project} variant={variant} matched={terms} onLeaveOut={onLeaveOut}>
    {evidence && <div className="note-line note-evidence" title={evidence.title}>{copy.trust.basedOn(evidence.title)} · {composer.checkedWhenYouStart.toLowerCase()}</div>}
  </NoteCard>;
}

// A list with one tab stop: arrows move between notes, Backspace or Delete
// leaves the focused note out and focus moves to the next one.
function NoteList({ label, items, render, onLeaveOut, onEmpty }: { label: string; items: PreviewItem[]; render(item: PreviewItem): ReactNode; onLeaveOut(id: string): void; onEmpty(): void }) {
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  const [active, setActive] = useState(0); const pending = useRef<number | null>(null);
  const index = Math.min(active, Math.max(0, items.length - 1));
  useLayoutEffect(() => {
    if (pending.current === null) return;
    const next = Math.min(pending.current, items.length - 1); pending.current = null;
    if (next < 0) onEmpty(); else { setActive(next); rows.current[next]?.focus(); }
  });
  const move = (to: number) => { const next = Math.max(0, Math.min(items.length - 1, to)); setActive(next); rows.current[next]?.focus(); };
  const keys = (event: KeyboardEvent<HTMLLIElement>, at: number) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); move(at + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(at - 1); }
    else if (event.key === 'Home') { event.preventDefault(); move(0); }
    else if (event.key === 'End') { event.preventDefault(); move(items.length - 1); }
    else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); pending.current = at; onLeaveOut(items[at].id); }
  };
  return <ul className="preview-list" aria-label={label}>{items.map((item, at) =>
    <li key={item.id} ref={el => { rows.current[at] = el; }} tabIndex={at === index ? 0 : -1} onFocus={() => setActive(at)} onKeyDown={event => keys(event, at)}>{render(item)}</li>)}</ul>;
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  return <><span>{label}</span><span className="meter-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)} aria-valuetext={text}>
    <i style={{ width: `${Math.min(100, (value / max) * 100)}%` }} /></span><span className="meter-value">{text}</span></>;
}

// "What the agent will know" (board B5): the meter, the notes every session
// gets, the notes this task picks, what was left out and why. The list is
// replaced in place as replies arrive; nothing animates.
export function ContextPreview({ view, error, taskNotes, project, mac, onLeaveOut, onRestore, onInspect }: {
  view: PreviewView | null; error: string | null; taskNotes: number | null; project: Project; mac: boolean;
  onLeaveOut(id: string): void; onRestore(): void; onInspect(): void;
}) {
  const aside = useRef<HTMLElement>(null);
  const checked = !!view?.checked;
  const note = (variant: 'preview') => (item: PreviewItem) => <PreviewNote item={item} project={project} variant={variant} checked={checked} onLeaveOut={() => onLeaveOut(item.id)} />;
  const meter = view ? meterText(view) : null;
  const relevantEmpty = taskNotes === 0;
  return <aside ref={aside} className="context-preview" aria-label="Context preview" tabIndex={-1}>
    <h2 className="preview-heading">{copy.willKnow}<span className="preview-live">{composer.updatesAsYouType}</span></h2>
    {error && <p className="preview-error" role="status">{composer.previewFailed(error)}</p>}
    {view && meter && <>
      <div className="meter">
        <Meter label={composer.notes} value={view.notes} max={NOTE_LIMIT} text={meter.notes} />
        <Meter label={composer.size} value={view.bytes} max={BYTE_LIMIT} text={meter.size} />
      </div>
      <p className={`preview-checked ${checked ? 'is-checked' : ''}`}>{checked ? composer.checked : composer.notChecked}</p>
      {view.always.length > 0 && <section className="preview-group" aria-label={copy.everySession}>
        <h3>{copy.everySession}</h3>
        <NoteList label={copy.everySession} items={view.always} render={note('preview')} onLeaveOut={onLeaveOut} onEmpty={() => aside.current?.focus()} />
      </section>}
      <section className="preview-group" aria-label={copy.relevant}>
        <h3>{copy.relevant}</h3>
        {view.relevant.length > 0 ? <NoteList label={copy.relevant} items={view.relevant} render={note('preview')} onLeaveOut={onLeaveOut} onEmpty={() => aside.current?.focus()} />
          : relevantEmpty ? <p className="preview-empty">{composer.relevantEmpty}</p>
          : <p className="muted preview-none">{composer.relevantNone}</p>}
      </section>
      <div className="preview-excluded">
        {view.notIncluded.length > 0 && <span className="preview-excluded-label">{copy.notIncluded}</span>}
        {view.notIncluded.map(({ reason, count }) => <span key={reason} className={`chip ${reason === 'stale' ? 'chip-amber' : ''}`}>
          {composer.notIncludedChip(count, excludedReason(reason))}{reason === 'left-out-for-task' && <> · <button type="button" className="link" onClick={onRestore}>{composer.restore}</button></>}</span>)}
        <button type="button" className="link preview-inspect" onClick={onInspect}>{composer.inspectAll}</button>
      </div>
    </>}
    <p className="preview-tip">{composer.leaveOutTip(mac)}</p>
  </aside>;
}
