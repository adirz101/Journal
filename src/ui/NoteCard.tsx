import type { ReactNode } from 'react';
import type { Memory, NoteTrust, Project } from './types';
import { category, composer, copy, memoryState, selectionReason } from './copy';
import { evidenceLine, originLine, sentLine, shownNote, stateClass, type NoteCardVariant } from './noteCardModel';

export type { NoteCardVariant } from './noteCardModel';

// One note with its trust lines (Phase 5, F15): used by the Memory tab, the Session
// tab's delivered notes, the composer's hover card and context previews.
// Rows: meta (category · matched words · pinned; status or why it was selected), the
// statement, scope, where it came from, what it is based on, how many conversations it
// was sent to, then children and actions. hover and preview keep one line each (the
// full text is in the title); memory and receipt wrap. No animation: cards re-render
// with typing and terminal events.
export function NoteCard({ note, project, variant, trust, matched, checkNeeded, onOpenSession, onLeaveOut, actions, children }: {
  note: Memory;                              // current note (memory, hover, preview) or a delivered snapshot (receipt)
  project: Project;                          // root names for folder evidence, current branch
  variant: NoteCardVariant;
  trust?: NoteTrust;
  matched?: string[];                        // matched task words → "matches a b"
  checkNeeded?: boolean;                     // overrides validation (a receipt shows freshness at launch only)
  onOpenSession?(sessionId: string): void;   // the "›" link; omitted → plain text
  onLeaveOut?(): void;                       // preview and hover: "Leave out ⌫"
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const compact = variant === 'hover' || variant === 'preview';
  const shown = shownNote(note, checkNeeded, variant);
  const label = category(note.category, note.scope);
  const rootName = note.source.rootId ? project.roots?.find(root => root.id === note.source.rootId)?.name ?? copy.folderRemoved.toLowerCase() : undefined;
  const origin = originLine(note, trust?.origin, Date.now());
  const evidence = evidenceLine(shown, rootName, variant);
  const sent = sentLine(trust?.sent);
  const scope = `${note.scope === 'branch' ? `⑂ ${copy.onlyOn(note.branch)}` : copy.allBranches}${note.area ? ` · ${note.area}` : ''}${note.environment ? ` · applies when: ${note.environment}` : ''} · r${note.revision}`;
  // One-line rows carry their full text as a tooltip.
  const full = (text: string) => compact ? text : undefined;
  const side = variant === 'memory' ? <span className={`memory-state ${stateClass(shown)}`}>{memoryState(shown)}</span>
    : variant === 'hover' ? null : <span>{selectionReason(note.selection?.reason, note.area)}{note.selection ? ` · ${note.selection.bytes} B` : ''}</span>;
  return <article className={`note-card ${variant}${variant === 'memory' ? ' memory-card' : ''}`} aria-label={`${label}: ${note.statement.slice(0, 80)}`}>
    <div className="memory-meta note-meta"><span>{label}{matched?.length ? ` · ${composer.matches} ${matched.join(' ')}` : ''}{note.pinned ? ' · pinned' : ''}</span>{side}</div>
    <p className="note-statement" dir="auto" title={full(note.statement)}>{note.statement}</p>
    <div className="memory-scope note-scope" title={full(scope)}>{scope}</div>
    {origin && <div className="note-line note-origin" title={full(origin.text)}>{origin.sessionId && onOpenSession
      ? <button type="button" className="link" onClick={() => onOpenSession(origin.sessionId!)}>{origin.text} <span aria-hidden="true">›</span></button> : origin.text}</div>}
    {evidence && <div className={`note-line note-evidence${evidence.tone === 'amber' ? ' amber' : ''}`} title={evidence.title}>{evidence.text}</div>}
    {sent && <div className="note-line note-sent" title={copy.trust.sentTip}>{sent}</div>}
    {children}
    {(actions || onLeaveOut) && <div className="memory-actions">{actions}{onLeaveOut && <button type="button" onClick={onLeaveOut} aria-keyshortcuts="Backspace Delete">{composer.leaveOutShort} <kbd aria-hidden="true">⌫</kbd></button>}</div>}
  </article>;
}
