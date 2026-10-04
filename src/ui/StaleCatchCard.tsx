import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type DiffLine, type Memory, type NoteTrust, type Project, type StaleNote } from './types';
import { copy, tip, wrapUp } from './copy';
import { NoteCard } from './NoteCard';
import { forgetStaleCatch } from './useWrapUp';
import { hunkCounts, validRange, type StagedActions } from './wrapUpModel';

const fileName = (path: string) => path.split('/').pop() || path;
type Resolution = null | 'staged' | 'checked' | 'updated' | 'forgotten';

// The out-of-date catch for one note (board 14): which file this session changed, the note
// that cites it, what changed under its lines, then Update note… / Still true / Forget….
// Still true is staged for 10 s with Undo and saves only the file content that was shown
// (expectedHash). A resolved card collapses to one line in place, with no animation; the
// wrap-up's live region announces it. The parent keys the card by note and file hash, so a
// reloaded catch (the file changed again) starts with nothing shown or staged.
// live: false once the wrap-up is gone; a staged commit that fails then reports to onError.
// notice / onRefused: a refused Still true, kept by the parent so it survives the reload's remount.
export function StaleCatchCard({ item, sessionId, project, sameFile, trust, staged, live, notice, onUpdate, onChanged, onReload, onRefused, onError, onAnnounce }: {
  item: StaleNote; sessionId: string; project: Project; sameFile: number; trust?: NoteTrust; staged: StagedActions; live: { readonly current: boolean }; notice?: string;
  onUpdate(note: Memory, done: () => void): void; onChanged(): void; onReload(): void; onRefused(text: string): void; onError(error: unknown): void; onAnnounce(text: string): void;
}) {
  const note = item.note; const source = note.source;
  const saved = { startLine: source.startLine ?? 1, endLine: source.endLine ?? source.startLine ?? 1 };
  const suggested = item.suggestedRange && (item.suggestedRange.startLine !== saved.startLine || item.suggestedRange.endLine !== saved.endLine) ? item.suggestedRange : null;
  const [resolution, setResolution] = useState<Resolution>(null);
  const [range, setRange] = useState<{ startLine: number; endLine: number } | null>(null);
  const [error, setError] = useState('');
  // The whole change from the note's own base (staleNoteDiff), with the file hash it was read from.
  const [whole, setWhole] = useState<{ state: 'loading' | 'shown' | 'blocked'; text: string; reason?: string; contentHash?: string | null } | null>(null);
  const key = `check:${note.id}`;
  // The user must not confirm a change they were only partly shown (B5 amendment): a cut
  // change needs the whole diff on screen, taken from the same file content Still true sends.
  const wholeShown = whole?.state === 'shown' && !!whole.contentHash && whole.contentHash === item.contentHash;
  const canCheck = item.reaffirm.allowed && !!item.contentHash && (!item.truncated || wholeShown);
  const resolvedText = (value: Exclude<Resolution, null>) => value === 'forgotten' ? wrapUp.resolvedForgotten : value === 'updated' ? wrapUp.resolvedUpdated : wrapUp.resolvedStillTrue;
  // Announced once per choice (staged, updated, forgotten); the commit of a staged check is not news.
  useEffect(() => { if (resolution && resolution !== 'checked') onAnnounce(resolvedText(resolution)); }, [resolution]); // eslint-disable-line react-hooks/exhaustive-deps
  const message = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);
  // Focus follows the card: the button that was pressed is replaced by the resolved line (focus
  // moves to its Undo, or to the line itself), and Undo brings back the card with Still true focused.
  const resolvedRef = useRef<HTMLDivElement>(null); const stillTrueRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'resolved' | 'card' | null>(null);
  const orphaned = () => !document.activeElement || document.activeElement === document.body;
  useLayoutEffect(() => {
    const target = focusAfter.current; focusAfter.current = null;
    if (target === 'resolved' && orphaned()) (resolvedRef.current?.querySelector<HTMLElement>('button') ?? resolvedRef.current)?.focus();
    if (target === 'card' && orphaned()) stillTrueRef.current?.focus();
  }, [resolution]);
  useEffect(() => { if (resolution === 'checked' && orphaned()) resolvedRef.current?.focus(); }, [resolution]);

  function stage(lines: { startLine: number; endLine: number }) {
    setError(''); setRange(null); focusAfter.current = 'resolved'; setResolution('staged'); if (notice) onRefused('');
    staged.stage(key, () => {
      // Dropped before the write, so a wrap-up opened meanwhile reads the catch again.
      forgetStaleCatch(sessionId);
      void api('reaffirmMemory', { id: note.id, startLine: lines.startLine, endLine: lines.endLine, workspaceId: item.workspaceId, expectedHash: item.contentHash })
        .then(() => { forgetStaleCatch(sessionId); if (live.current) setResolution('checked'); onChanged(); },
          (failure: unknown) => {
            const text = wrapUp.checkFailed(message(failure));
            if (!live.current) { onError(new Error(text)); return; } // committed on leaving: the banner reports it
            setResolution(null); onRefused(text); onReload();
          });
    });
  }
  async function showWhole() {
    setWhole({ state: 'loading', text: '' });
    try {
      const diff = await api<{ available: boolean; reason: string | null; text: string | null; contentHash: string | null }>('staleNoteDiff', { projectId: project.id, memoryId: note.id, sessionId });
      if (diff.available && diff.text !== null && diff.contentHash === item.contentHash) setWhole({ state: 'shown', text: diff.text, contentHash: diff.contentHash });
      else if (diff.available) { setWhole({ state: 'blocked', text: '', reason: wrapUp.wholeChangeAgain }); onReload(); } // a newer file than the catch
      else setWhole({ state: 'blocked', text: '', reason: diff.reason === 'hidden' ? wrapUp.wholeChangeHidden : diff.reason === 'too-large' ? wrapUp.wholeChangeTooLarge
        : diff.reason === 'changed' ? wrapUp.wholeChangeAgain : wrapUp.wholeChangeFailed });
    } catch { setWhole({ state: 'blocked', text: '', reason: wrapUp.wholeChangeFailed }); }
  }
  async function forget() {
    setError('');
    try { const result = await api('setMemoryStatus', { id: note.id, status: 'archived' }); if (result === null) return; forgetStaleCatch(sessionId); focusAfter.current = 'resolved'; setResolution('forgotten'); onChanged(); }
    catch (failure) { setError(message(failure)); }
  }
  const update = () => onUpdate({ ...note, source: { ...source, ...(item.suggestedRange ?? saved) } }, () => { forgetStaleCatch(sessionId); focusAfter.current = 'resolved'; setResolution('updated'); onChanged(); });

  if (resolution) {
    const text = resolvedText(resolution);
    return <div ref={resolvedRef} tabIndex={-1} className={`wrap-resolved${resolution === 'forgotten' ? '' : ' ok'}`}>
      <span>{text}</span>
      {resolution === 'staged' && <button type="button" className="wrap-small" onClick={() => { if (staged.undo(key)) { focusAfter.current = 'card'; setResolution(null); } }}>{wrapUp.undo}</button>}
    </div>;
  }
  const shownName = fileName(item.path); const counts = hunkCounts(item.hunks);
  const firstLine = item.hunks?.flatMap(hunk => hunk.lines).find(line => line.kind !== ' ')?.old ?? item.shownRange?.startLine ?? saved.startLine;
  const headingId = `catch-${note.id}`;
  return <section className="stale-catch" aria-labelledby={headingId}>
    <div className="stale-lead">
      <h3 id={headingId}>{wrapUp.staleHead(shownName, sameFile)}</h3>
      <p>{wrapUp.staleBody}</p>
    </div>
    <div className="stale-body">
      <div className="stale-note"><NoteCard note={note} project={project} variant="memory" trust={trust} checkNeeded /></div>
      <div className="stale-change">
        {item.renamedTo ? <p className="stale-where">{wrapUp.renamedTo(item.renamedTo)}</p>
          : item.hunks ? <>
            <p className="stale-where"><span>{wrapUp.whatChanged('')}</span><code title={item.path}>{shownName}:{firstLine}</code><span className="stale-counts"><span className="t-g">+{counts.added}</span> <span className="t-r">−{counts.removed}</span></span></p>
            <DiffTable hunks={item.hunks} label={wrapUp.whatChanged(item.path)} />
          </> : <>
            {item.before && <><p className="stale-where">{wrapUp.savedLines}</p><Lines block={item.before} /></>}
            {item.after && <><p className="stale-where">{wrapUp.now}</p><Lines block={item.after} /></>}
          </>}
        {item.truncated && <div className="stale-whole">
          {!whole && <><p className="hint">{wrapUp.wholeChangeNeeded}</p><button type="button" className="wrap-small" onClick={() => void showWhole()}>{wrapUp.showWholeChange}</button></>}
          {whole?.state === 'loading' && <p className="hint">…</p>}
          {whole?.reason && <p className="hint" role="note">{whole.reason}</p>}
          {whole?.state === 'shown' && <pre className="stale-whole-diff" dir="ltr" tabIndex={0} aria-label={wrapUp.wholeChange}>{whole.text}</pre>}
        </div>}
      </div>
    </div>
    {range && <div className="stale-range" role="group" aria-label={wrapUp.linesMoved}>
      <span>{wrapUp.linesMoved}</span>
      <input type="number" min={1} aria-label={wrapUp.rangeLabel('First')} value={range.startLine} onChange={e => setRange({ ...range, startLine: Number(e.target.value) })} />
      <span>{wrapUp.linesTo}</span>
      <input type="number" min={1} aria-label={wrapUp.rangeLabel('Last')} value={range.endLine} onChange={e => setRange({ ...range, endLine: Number(e.target.value) })} />
      <button type="button" className="primary wrap-small" disabled={!validRange(range.startLine, range.endLine)} onClick={() => stage(range)}>{wrapUp.stillTrue}</button>
      <button type="button" className="wrap-small" onClick={() => setRange(null)}>{wrapUp.cancel}</button>
      {!validRange(range.startLine, range.endLine) && <span className="form-error">{wrapUp.rangeInvalid}</span>}
    </div>}
    {(error || notice) && <p className="form-error stale-error" role="alert">{error || notice}</p>}
    <div className="stale-actions">
      <button type="button" className="primary" onClick={update}>{wrapUp.updateNote}</button>
      {item.reaffirm.allowed ? <button ref={stillTrueRef} type="button" disabled={!canCheck || !!range} onClick={() => suggested ? setRange({ ...suggested }) : stage(saved)}>{wrapUp.stillTrue}</button>
        : <span className="stale-reason">{item.reaffirm.reason === 'separate-copy' ? wrapUp.separateCopyOnly : item.reaffirm.reason === 'file-missing' ? wrapUp.fileMissing : copy.otherBranch}</span>}
      <button type="button" className="ghost" title={tip.forget} onClick={() => void forget()}>{copy.forget}</button>
      {item.reaffirm.allowed && <span className="stale-help">{wrapUp.stillTrueHelp}</span>}
    </div>
  </section>;
}

// The hunks in the note's own line numbers: old, new, mark, text. Screen readers hear
// "removed" or "added" instead of the sign.
function DiffTable({ hunks, label }: { hunks: { lines: DiffLine[] }[]; label: string }) {
  return <table className="stale-diff" dir="ltr" aria-label={label}>
    <thead className="visually-hidden"><tr><th scope="col">{wrapUp.savedLineHeader}</th><th scope="col">{wrapUp.lineNowHeader}</th><th scope="col">{wrapUp.changeHeader}</th><th scope="col">{wrapUp.textHeader}</th></tr></thead><tbody>
    {hunks.map((hunk, index) => [index > 0 && <tr key={`gap-${index}`} className="gap"><td colSpan={4}>…</td></tr>,
      ...hunk.lines.map((line, row) => <tr key={`${index}-${row}`} className={line.kind === '-' ? 'del' : line.kind === '+' ? 'add' : 'ctx'}>
        <td className="num">{line.old ?? ''}</td><td className="num">{line.new ?? ''}</td>
        <td className="mark"><span aria-hidden="true">{line.kind === ' ' ? '' : line.kind === '-' ? '−' : '+'}</span></td>
        <td className="code">{line.kind !== ' ' && <span className="visually-hidden">{line.kind === '-' ? wrapUp.removedLine : wrapUp.addedLine} </span>}{line.text}</td>
      </tr>)])}
  </tbody></table>;
}

function Lines({ block }: { block: { startLine: number; lines: string[] } }) {
  return <table className="stale-diff" dir="ltr"><thead className="visually-hidden"><tr><th scope="col">{wrapUp.lineHeader}</th><th scope="col">{wrapUp.textHeader}</th></tr></thead><tbody>{block.lines.map((text, index) => <tr key={index} className="ctx"><td className="num">{block.startLine + index}</td><td className="code">{text}</td></tr>)}</tbody></table>;
}
