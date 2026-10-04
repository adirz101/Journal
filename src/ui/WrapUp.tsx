import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { api, PROVIDER_NAMES, type AgentInfo, type Memory, type MemoryOrigin, type NoteTrust, type Project, type Proposal, type Provider, type Receipt, type Session, type TimelineEvent, type Workspace } from './types';
import { category, composer, copy, count, tip, wrapUp } from './copy';
import { ProviderMark } from './ProviderMark';
import { TerminalPane, type TerminalHandle } from './TerminalPane';
import { StaleCatchCard } from './StaleCatchCard';
import { useWrapUp } from './useWrapUp';
import { resumable } from './sessionState';
import type { Appearance } from './theme';
import { branchReachable, createStagedActions, exitLine, handoffPrefill, identityLine, isErrorExit, keyLabels, rememberable, rememberAllIds, SEEN_SUGGESTIONS, shortId, testsLine, type HandoffPrefill } from './wrapUpModel';

type Outcome = 'remembered' | 'dismissing' | 'dismissed' | 'review';
const readSeen = () => { try { return localStorage.getItem(SEEN_SUGGESTIONS) === '1'; } catch { return false; } };
const writeSeen = () => { try { localStorage.setItem(SEEN_SUGGESTIONS, '1'); } catch { /* without storage the explainer shows each time, which is harmless */ } };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// An ended session's terminal, read-only. When the runtime no longer has its buffer
// (released, or from an earlier run), it says so instead of showing an empty terminal.
export function EndedTerminal({ session, appearance, onError, handleRef, preview = false, onUnavailable }: {
  session: Session; appearance: Appearance; onError(message: string): void; handleRef?: Ref<TerminalHandle>; preview?: boolean; onUnavailable?(): void;
}) {
  const [gone, setGone] = useState(false);
  if (gone) return <p className="wrap-not-saved" role="note">{wrapUp.notSaved}</p>;
  return <TerminalPane key={session.id} sessionId={session.id} live={false} appearance={appearance} onError={onError} handleRef={handleRef} focusOnAttach={!preview}
    onUnavailable={() => { setGone(true); onUnavailable?.(); }} />;
}

// The session wrap-up (boards 6 and 14, States panel 5): how it ended, notes this session
// put out of date, what is worth keeping, the counts and how to continue. Nothing is kept
// without a click. No entrance animation: it replaces the terminal in place, several times a day.
export function WrapUp({ session, project, workspaces, receipt, events, agents, appearance, mac, busy, canStart, connected, justEnded,
  onShowTerminal, onContinue, onConfirmId, onCopyId, onOpenDiff, onOpenMemory, onEdit, onFinishDraft, onHandoff, onChanged, onError }: {
  session: Session; project: Project; workspaces: Workspace[]; receipt: Receipt | null; events: TimelineEvent[]; agents: AgentInfo[];
  appearance: Appearance; mac: boolean; busy: boolean; canStart: boolean; connected: boolean; justEnded: boolean;
  onShowTerminal(): void; onContinue(): void; onConfirmId(nativeId: string): Promise<void>; onCopyId(): void; onOpenDiff(): void; onOpenMemory(): void;
  onEdit(memory: Memory, done: () => void): void; onFinishDraft(): void; onHandoff(prefill: HandoffPrefill): void; onChanged(): void; onError(error: unknown): void;
}) {
  const data = useWrapUp(session, onError);
  const { summary } = data;
  const staged = useRef(createStagedActions()).current;
  // Leaving the view (another session, Show terminal, another project) commits staged choices.
  useEffect(() => () => staged.flushAll(), [staged]);
  const heading = useRef<HTMLHeadingElement>(null); const root = useRef<HTMLElement>(null);
  // The terminal that had focus is gone when the session ends under it: focus the heading.
  useEffect(() => { if (justEnded && (!document.activeElement || document.activeElement === document.body)) heading.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const identity = identityLine({ nativeId: session.nativeId, confirmed: session.nativeIdConfirmed, source: session.nativeIdSource ?? null, mismatch: !!session.identityMismatch }, session.provider);
  const keys = keyLabels(mac);
  const continueBlock = !identity.canContinue || !resumable(session) ? (identity.needsConfirm ? wrapUp.confirmFirst : identity.text)
    : !connected ? composer.runtimeDown : !canStart ? copy.slotsFull(4) : '';
  const canContinue = !continueBlock && !busy;
  const error = isErrorExit(session);

  // Suggestions: the list on screen keeps cards this view handled, so a refetch never hides an outcome.
  const [shown, setShown] = useState<Proposal[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [rememberError, setRememberError] = useState('');
  const [working, setWorking] = useState(false);
  const [seen, setSeen] = useState(readSeen);
  useEffect(() => {
    if (!data.proposals) return;
    const incoming = data.proposals;
    setShown(current => [...current.filter(p => outcomes[p.id] || incoming.some(n => n.id === p.id)).map(p => incoming.find(n => n.id === p.id) ?? p),
      ...incoming.filter(n => !current.some(p => p.id === n.id))]);
  }, [data.proposals]); // eslint-disable-line react-hooks/exhaustive-deps
  const openList = shown.filter(p => !outcomes[p.id]);
  const allIds = rememberAllIds(openList, project, workspaces);
  const markSeen = () => { if (!seen) { setSeen(true); writeSeen(); } };

  async function remember(ids: string[]) {
    if (working) return;
    setWorking(true); setRememberError(''); markSeen();
    try { await api('rememberProposals', { ids }); setOutcomes(current => ({ ...current, ...Object.fromEntries(ids.map(id => [id, 'remembered' as const])) })); onChanged(); }
    catch (failure) { setRememberError(message(failure)); }
    finally { setWorking(false); }
  }
  async function edit(proposal: Proposal) {
    setRememberError(''); markSeen();
    try { const memory = await api<Memory>('acceptProposal', { id: proposal.id }); setOutcomes(current => ({ ...current, [proposal.id]: 'review' })); onChanged(); onEdit(memory, onChanged); }
    catch (failure) { setRememberError(message(failure)); }
  }
  function dismiss(proposal: Proposal) {
    markSeen(); setOutcomes(current => ({ ...current, [proposal.id]: 'dismissing' }));
    staged.stage(`dismiss:${proposal.id}`, () => {
      void api('dismissProposal', { id: proposal.id }).then(() => { setOutcomes(current => ({ ...current, [proposal.id]: 'dismissed' })); onChanged(); },
        failure => { setOutcomes(current => { const next = { ...current }; delete next[proposal.id]; return next; }); setRememberError(message(failure)); });
    });
  }
  const undoDismiss = (id: string) => { if (staged.undo(`dismiss:${id}`)) setOutcomes(current => { const next = { ...current }; delete next[id]; return next; }); };

  // ⌘↵ / Ctrl+Enter continues; ⇧⌘↵ / Ctrl+Shift+Enter remembers all. Only while focus is in
  // the wrap-up or nowhere, no dialog is open and no IME composition is running.
  const keysRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keysRef.current = event => {
    if (event.key !== 'Enter' || event.isComposing || event.repeat || event.altKey || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
    const active = document.activeElement;
    if (document.querySelector('dialog[open]') || (active && active !== document.body && !root.current?.contains(active))) return;
    if (event.shiftKey) { if (allIds && !working) { event.preventDefault(); void remember(allIds); } return; }
    if (canContinue) { event.preventDefault(); onContinue(); }
  };
  useEffect(() => { const handler = (event: KeyboardEvent) => keysRef.current(event); window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, []);

  // One polite announcement after the first load; never per refetch.
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current || !summary || data.looking || !data.proposals) return;
    announced.current = true; setAnnouncement(wrapUp.ended(data.proposals.length));
  }, [summary, data.looking, data.proposals]);

  // Trust lines for the notes in the catch (origin and delivery count), fetched once per list.
  const staleNotes = data.stale?.notes ?? [];
  const staleIds = staleNotes.map(item => item.note.id).join(',');
  const [trust, setTrust] = useState<Record<string, NoteTrust>>({});
  useEffect(() => {
    if (!staleIds) return; let current = true; const ids = staleIds.split(',');
    void Promise.all([api<Record<string, MemoryOrigin | null>>('memoryOrigins', { projectId: session.projectId, ids }).catch(() => null), api<Record<string, number>>('deliveryCounts', { projectId: session.projectId, ids }).catch(() => null)])
      .then(([origins, sent]) => { if (current) setTrust(Object.fromEntries(ids.map(id => [id, { origin: origins ? origins[id] ?? null : null, sent: sent ? sent[id] ?? null : null }]))); });
    return () => { current = false; };
  }, [staleIds, session.projectId]);
  const perFile = useMemo(() => { const counts: Record<string, number> = {}; for (const item of staleNotes) counts[item.path] = (counts[item.path] ?? 0) + 1; return counts; }, [staleNotes]);

  const handoffTargets = agents.filter(a => a.available && (a.state ?? 'ready') === 'ready');
  const prefill = (provider: Provider) => handoffPrefill(session, receipt, events, provider, workspaces, project.roots ?? []);
  const continueButton = (primary: boolean) => <button type="button" className={primary ? 'primary' : undefined} title={continueBlock || tip.continue} disabled={!canContinue} aria-keyshortcuts={keys.continueAria} onClick={onContinue}>
    {wrapUp.continueShort} <kbd aria-hidden="true">{keys.continue}</kbd></button>;

  return <section ref={root} className="wrap-up" aria-labelledby="wrapup-title">
    <div className="wrap-head">
      <h2 id="wrapup-title" ref={heading} tabIndex={-1} className={error ? 'tone-error' : undefined}>{exitLine(session, summary)}</h2>
      {!error && <div className="wrap-head-actions">
        <button type="button" onClick={onShowTerminal}>{wrapUp.showTerminal}</button>
        {continueButton(true)}
      </div>}
    </div>
    {!error && continueBlock && <p className="wrap-block-reason">{continueBlock}</p>}
    <p className="visually-hidden" role="status">{announcement}</p>

    {error && <ExitErrorPanel session={session} appearance={appearance} onError={onError} onShowTerminal={onShowTerminal} continueButton={continueButton(false)} reason={continueBlock} />}

    {staleNotes.map(item => <StaleCatchCard key={item.note.id} item={item} sessionId={session.id} project={project} sameFile={perFile[item.path] ?? 1} trust={trust[item.note.id]} staged={staged}
      onUpdate={onEdit} onChanged={onChanged} onReload={data.reloadStale} />)}

    <section className="wrap-keep" aria-labelledby="wrapup-keep">
      <div className="wrap-keep-head">
        <div><h3 id="wrapup-keep">{wrapUp.worthKeeping}</h3><p>{wrapUp.nothingKept}</p></div>
        {allIds && <button type="button" className="ghost" disabled={working} aria-keyshortcuts={keys.rememberAllAria} onClick={() => void remember(allIds)}>{wrapUp.rememberAll(allIds.length)} <kbd aria-hidden="true">{keys.rememberAll}</kbd></button>}
      </div>
      {rememberError && <p className="form-error wrap-keep-error" role="alert">{rememberError}</p>}
      {!seen && openList.length > 0 && <div className="wrap-explainer">
        <p><b>{wrapUp.explainer.split('. ')[0]}.</b> {wrapUp.explainer.split('. ').slice(1).join('. ')}</p>
        <button type="button" className="ghost wrap-small" onClick={markSeen}>{wrapUp.gotIt}</button>
      </div>}
      {shown.map(proposal => <SuggestionRow key={proposal.id} proposal={proposal} outcome={outcomes[proposal.id]} project={project} workspaces={workspaces} working={working}
        onRemember={() => void remember([proposal.id])} onEdit={() => void edit(proposal)} onDismiss={() => dismiss(proposal)} onUndo={() => undoDismiss(proposal.id)}
        onOpenMemory={onOpenMemory} onFinishDraft={onFinishDraft} />)}
      {!shown.length && <p className="wrap-quiet">{data.looking || !data.proposals ? wrapUp.looking : wrapUp.noSuggestions}</p>}
    </section>

    <div className="wrap-cards">
      <div className="wrap-card" title={wrapUp.changesTip}>
        <span className="wrap-card-label">{wrapUp.changes}</span>
        {summary?.changes?.available ? <>
          <span className="wrap-card-value">{summary.changes.files ? <><span className="t-g">+{summary.changes.additions}</span> <span className="t-r">−{summary.changes.deletions}</span></> : wrapUp.noChanges}</span>
          <span className="wrap-card-sub">{count(summary.changes.files, 'file')}{summary.changes.preexisting ? ` · ${wrapUp.alreadyChanged(summary.changes.preexisting)}` : ''} · <button type="button" className="link" onClick={onOpenDiff}>{wrapUp.openDiff}</button></span>
        </> : <span className="wrap-card-sub"><button type="button" className="link" onClick={onOpenDiff}>{wrapUp.changesNone}</button></span>}
      </div>
      <div className="wrap-card">
        <span className="wrap-card-label">{wrapUp.testsRun}</span>
        {(() => { const line = testsLine(summary ? summary.tests : null, session.provider); return summary ? <>
          <span className={`wrap-card-value${line.empty ? ' quiet' : ''}`}>{line.parts.map((part, index) => <span key={index} className={part.tone === 'red' ? 't-r' : undefined}>{index > 0 ? ' · ' : ''}{part.text}</span>)}</span>
          {!!summary.tests?.commands.length && <span className="wrap-card-sub mono">{summary.tests.commands.join(' · ')}</span>}
        </> : <span className="wrap-card-sub">…</span>; })()}
      </div>
      <div className="wrap-card">
        <span className="wrap-card-label" title={tip.continue}>{wrapUp.continueCard}</span>
        {session.nativeId ? <span className="wrap-card-id"><code title={session.nativeId}>{shortId(session.nativeId)}</code>
          {session.nativeIdConfirmed && <button type="button" className="link" onClick={onCopyId}>{wrapUp.copyId}</button>}</span> : null}
        <span className={`wrap-card-sub tone-${identity.tone}`}>{identity.tone === 'ok' && <span aria-hidden="true">✓ </span>}{identity.text}</span>
        {identity.needsConfirm && session.status !== 'failed' && <ConfirmId key={session.id} initial={session.nativeId ?? ''} busy={busy} onConfirm={onConfirmId} />}
      </div>
    </div>

    {handoffTargets.length > 0 && <div className="wrap-handoff">
      <span aria-hidden="true" className="wrap-handoff-arrow">→</span>
      <span>{wrapUp.handoff}</span>
      <span className="wrap-handoff-actions">
        {handoffTargets.filter(a => a.provider !== session.provider).map(a => <button type="button" key={a.provider} className="wrap-small" onClick={() => onHandoff(prefill(a.provider))}><ProviderMark provider={a.provider} size={16} />{PROVIDER_NAMES[a.provider]}</button>)}
        {handoffTargets.some(a => a.provider === session.provider) && <button type="button" className="wrap-small" onClick={() => onHandoff(prefill(session.provider))}>{wrapUp.newSessionWithTask}</button>}
      </span>
    </div>}
  </section>;
}

// States panel 5: an error exit leads with the last terminal output, or says it is gone.
function ExitErrorPanel({ session, appearance, onError, onShowTerminal, continueButton, reason }: {
  session: Session; appearance: Appearance; onError(error: unknown): void; onShowTerminal(): void; continueButton: React.ReactNode; reason: string;
}) {
  const handle = useRef<TerminalHandle>(null); const [gone, setGone] = useState(false); const [status, setStatus] = useState('');
  async function copyOutput() {
    const text = handle.current?.copyText(500) ?? ''; if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch {
      // A hidden or unfocused window may refuse the async clipboard; the selection fallback still works there.
      const area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.className = 'visually-hidden';
      document.body.append(area); area.select(); document.execCommand('copy'); area.remove();
    }
    setStatus(wrapUp.copied);
  }
  return <section className="wrap-error" aria-labelledby="wrapup-error">
    <h3 id="wrapup-error">{wrapUp.exitedWithError}</h3>
    <span className="wrap-card-label">{wrapUp.lastOutput}</span>
    <div className="wrap-error-terminal"><EndedTerminal session={session} appearance={appearance} onError={onError} handleRef={handle} preview onUnavailable={() => setGone(true)} /></div>
    <div className="wrap-error-actions">
      <button type="button" className="primary" onClick={onShowTerminal}>{wrapUp.showTerminal}</button>
      {continueButton}
      <button type="button" className="ghost" disabled={gone} onClick={() => void copyOutput()}>{wrapUp.copyOutput}</button>
      <span role="status" className="wrap-quiet">{status}</span>
    </div>
    {reason && <p className="wrap-block-reason">{reason}</p>}
  </section>;
}

// One suggestion (board 6 row): category, the full statement, where it came from and its
// scope, then Remember / Edit… / Dismiss. Handled rows collapse to one line in place.
function SuggestionRow({ proposal, outcome, project, workspaces, working, onRemember, onEdit, onDismiss, onUndo, onOpenMemory, onFinishDraft }: {
  proposal: Proposal; outcome: Outcome | undefined; project: Project; workspaces: Workspace[]; working: boolean;
  onRemember(): void; onEdit(): void; onDismiss(): void; onUndo(): void; onOpenMemory(): void; onFinishDraft(): void;
}) {
  if (outcome) return <div className={`wrap-row-done${outcome === 'remembered' ? ' ok' : ''}`} role="status">
    <span>{outcome === 'remembered' ? wrapUp.remembered : outcome === 'review' ? wrapUp.waitingReview : wrapUp.dismissed}</span>
    {outcome === 'dismissing' && <button type="button" className="wrap-small" onClick={onUndo}>{wrapUp.undo}</button>}
    {(outcome === 'remembered' || outcome === 'review') && <button type="button" className="link" onClick={onOpenMemory}>{wrapUp.openInMemory}</button>}
  </div>;
  const update = proposal.kind === 'branch-status';
  const label = update ? copy.branchStands : category(proposal.category, proposal.scope);
  const reachable = branchReachable(proposal.scope === 'branch' ? proposal.branch : null, project, workspaces);
  const conflict = !!proposal.conflicts?.length;
  const origin = update ? wrapUp.branchUpdate : proposal.kind === 'rule' ? wrapUp.fromTask : proposal.kind === 'test-command' ? wrapUp.fromTests : wrapUp.fromSession;
  const scope = proposal.scope === 'branch' ? copy.trust.onlyOn(proposal.branch ?? copy.trust.anotherBranch) : wrapUp.appliesAll;
  return <article className="wrap-row" aria-label={`${label}: ${proposal.statement.slice(0, 80)}`}>
    <span className="wrap-cat">{label}</span>
    <div className="wrap-row-text">
      <p dir="auto">{proposal.statement}</p>
      <span className="wrap-row-meta">{origin}{update ? '' : ` · ${scope}`}{proposal.earlier ? ` · ${wrapUp.suggestedEarlier}` : ''}</span>
      {conflict && <span className="wrap-row-warn">{wrapUp.mayConflict}</span>}
      {!update && !conflict && !reachable && <span className="wrap-row-warn">{wrapUp.branchUnreachable(proposal.branch ?? '')}</span>}
    </div>
    <div className="wrap-row-actions">
      {update ? <button type="button" className="wrap-small" disabled={proposal.branch !== project.branch} onClick={onFinishDraft}>{wrapUp.finishDraft}</button> : <>
        {conflict ? <button type="button" className="wrap-small" onClick={onOpenMemory}>{wrapUp.reviewInMemory}</button>
          : <button type="button" className="primary wrap-small" title={tip.remember} disabled={working || !rememberable(proposal, project, workspaces)} onClick={onRemember}>{wrapUp.remember}</button>}
        <button type="button" className="wrap-small" disabled={working} onClick={onEdit}>{wrapUp.edit}</button>
      </>}
      <button type="button" className="ghost wrap-small" disabled={working} onClick={onDismiss}>{wrapUp.dismiss}</button>
    </div>
  </article>;
}

// The confirm-ID row (formerly under the terminal): exact native ID only.
function ConfirmId({ initial, busy, onConfirm }: { initial: string; busy: boolean; onConfirm(nativeId: string): Promise<void> }) {
  const [value, setValue] = useState(initial);
  return <form className="wrap-confirm" onSubmit={event => { event.preventDefault(); void onConfirm(value.trim()); }}>
    <label>{wrapUp.idLabel}<input value={value} onChange={e => setValue(e.target.value)} placeholder={wrapUp.idPlaceholder} spellCheck={false} /></label>
    <button type="submit" className="wrap-small" disabled={busy || !value.trim()}>{wrapUp.confirmId}</button>
  </form>;
}
