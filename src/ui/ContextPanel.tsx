import { useEffect, useMemo, useRef, useState } from 'react';
import { ProviderMark } from './ProviderMark';
import { api, PROVIDER_NAMES, type Bootstrap, type FileReference, type Project, type Receipt, type Session, type TimelineEvent } from './types';
import { composer, copy, count, deliveryState, excludedReason, shell, warningText } from './copy';
import { NoteCard } from './NoteCard';
import { receiptVariant } from './noteCardModel';
import { useNoteTrust, useOpenable } from './useNoteTrust';
import { relativeTime } from './sidebarModel';

// Files the user referenced, with whether each still matches what was referenced.
function References({ title, projectId, workspaceId, references }: { title: string; projectId: string; workspaceId: string | null; references: (FileReference & { note?: string })[] }) {
  const [changed, setChanged] = useState<Record<number, 'same' | 'changed' | 'missing'>>({});
  useEffect(() => {
    let cancelled = false; setChanged({});
    void Promise.all(references.map(async (ref, index) => {
      if (!ref.contentHash) return [index, null] as const;
      const current = await api<FileReference>('describeReference', { projectId, workspaceId, rootKey: ref.rootKey, path: ref.path, startLine: ref.startLine, endLine: ref.endLine }).catch(() => null);
      const same = !current ? 'missing' : (ref.rangeHash ? current.rangeHash === ref.rangeHash : current.contentHash === ref.contentHash) ? 'same' : 'changed';
      return [index, same] as const;
    })).then(results => { if (!cancelled) setChanged(Object.fromEntries(results.filter(([, value]) => value)) as Record<number, 'same' | 'changed' | 'missing'>); });
    return () => { cancelled = true; };
  }, [projectId, workspaceId, references]);
  if (!references.length) return null;
  return <section className="reference-list" aria-label={title}><span className="eyebrow">{title}</span><ul>{references.map((ref, index) => <li key={index}>
    <code>{ref.display ?? ref.path}{ref.startLine ? `:${ref.startLine}${ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}` : ''}{ref.kind === 'folder' ? '/' : ''}</code>
    <small>{ref.note ? `${ref.note} · ` : ''}{ref.rootLabel ?? ref.rootKey}{ref.contentHash ? ` · sha256 ${ref.contentHash.slice(0, 8)}` : ''}{changed[index] === 'changed' ? ' · changed since referenced' : changed[index] === 'missing' ? ' · no longer available' : changed[index] === 'same' ? ' · unchanged' : ''}</small></li>)}</ul></section>;
}

function SessionReferences({ session, events }: { session: Session; events: TimelineEvent[] }) {
  const own = events.filter(e => e.kind === 'reference'); const key = own.map(e => e.id ?? e.at).join('|');
  // Stable until a reference is added, so files are not re-hashed on every render.
  const references = useMemo(() => own.map(e => { const b = e.body as Record<string, any>; return { kind: b.kind, rootKey: b.rootKey, rootLabel: b.rootLabel, path: b.path, display: b.path, startLine: b.startLine, endLine: b.endLine, contentHash: b.contentHash, rangeHash: b.rangeHash, note: `${b.delivery === 'inserted' ? 'typed' : 'copied'} ${new Date(e.at).toLocaleTimeString()}` } as FileReference & { note: string }; }), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <References title="Referenced during this session" projectId={session.projectId} workspaceId={session.workspaceId ?? null} references={references} />;
}

// What the agent receives: the exact packet, why each note is there, what
// was left out and why, and what Journal cannot observe.
// events: the session's timeline (useSessionEvents). packetRequest: set by
// "See what was sent", which shows the exact text and moves focus to it once:
// onPacketShown clears it in App, so a later remount (a tab switch, a layout
// change) never takes focus again.
// Phase 5: each delivered note is a NoteCard (receipt variant) with where it came from and how
// many conversations it was sent to; project, trustVersion, sessions and onOpenSession feed it.
export function ContextPanel({ receipt, session, bootstrap, history, disabled, events = [], now = Date.now(), packetRequest = null, project = null, trustVersion = 0, sessions = [], onOpenSession, onPacketShown, onToggle, onSelectReceipt, onChanged, onError }: {
  receipt: Receipt | null; session: Session | null; bootstrap: Bootstrap | null; history: Receipt[]; disabled: string[]; events?: TimelineEvent[]; now?: number; packetRequest?: number | null; onPacketShown?: () => void;
  project?: Project | null; trustVersion?: number; sessions?: Session[]; onOpenSession?: (sessionId: string) => void;
  onToggle: (id: string) => void; onSelectReceipt: (receipt: Receipt) => void; onChanged: () => void; onError: (error: unknown) => void;
}) {
  const [raw, setRaw] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null); const packet = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!packetRequest) return;
    onPacketShown?.(); setRaw(true);
    // Not cancelled when the request clears: clearing it is what re-renders this.
    requestAnimationFrame(() => { packet.current?.scrollIntoView({ block: 'nearest' }); heading.current?.focus({ preventScroll: true }); });
  }, [packetRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = receipt?.state === 'prepared';
  const trust = useNoteTrust(project?.id ?? null, useMemo(() => receipt?.items.map(item => item.id) ?? [], [receipt]), trustVersion);
  const openable = useOpenable(sessions);
  // The selected session's own record reads as what this agent knows; an
  // uncertain delivery never reads as sent.
  const own = !!session && receipt?.id === session.receiptId;
  const title = !receipt || preview ? copy.willKnow : receipt.state === 'failed' ? copy.wasGoingToSend : receipt.state === 'uncertain' ? shell.sentUncertain : own ? shell.whatThisAgentKnows : copy.whatWasSent;
  const agent = session ? bootstrap?.agents.find(a => a.provider === session.provider) : null;
  const act = async (action: () => Promise<unknown>) => { try { await action(); onChanged(); } catch (error) { onError(error); } };
  return <div className="panel-content context-content"><div className="section-heading"><div><span className="eyebrow">What the agent receives</span><h2 ref={heading} tabIndex={-1}>{title}</h2>{own && receipt?.state === 'submitted' && <small className="muted">{shell.atLaunch(relativeTime(receipt.createdAt, now))}</small>}</div></div>
    {!receipt ? <div className="knowledge-empty"><p>{composer.inspectEmpty}</p></div> : <>
      <div className="receipt-meta"><span>{count(receipt.items.length, 'note')}</span><span>{new TextEncoder().encode(receipt.packet).length} bytes · ≈{receipt.estimatedTokens} tokens</span><span className="receipt-state">{deliveryState(receipt.state)}</span></div>
      <dl className="receipt-facts"><dt>Task</dt><dd>{receipt.query || <em>none (only what {copy.everySession.toLowerCase()})</em>}</dd>
        <dt>Checkout</dt><dd>⑂ {(receipt as any).checkout?.branch ?? 'detached'} @ {String((receipt as any).checkout?.head ?? '').slice(0, 7) || 'unborn'}{(receipt as any).environment ? ' · isolated' : receipt.workspaceId ? ' · worktree' : ''}</dd>
        {session && <><dt>Route</dt><dd><ProviderMark provider={session.provider} size={16} />{PROVIDER_NAMES[session.provider]} {agent?.version ?? ''} · initial CLI prompt{session.plan ? ' · plan mode' : ''}{session.research ? ' · read-only mode' : ''}</dd>
          <dt>Not observable</dt><dd>{session.provider === 'claude' ? 'Whether the model read or used each note; tool output; hidden reasoning.' : 'Whether the model read or used each note; commands and test results; tool output; hidden reasoning.'}</dd></>}</dl>
      <ol className="receipt-items">{receipt.items.map(item => {
        const actions = <>{preview && <button onClick={() => onToggle(item.id)}>{copy.leaveOut}</button>}
          {item.category !== 'brief' && <button onClick={() => void act(() => api('setPinned', { id: item.id, pinned: !item.pinned }))}>{item.pinned ? 'Unpin' : 'Pin'}</button>}
          <button onClick={() => void act(() => api('markIncorrect', { id: item.id }))}>Mark incorrect</button></>;
        const details = <><button className="source-button" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? null : item.id)}>{open === item.id ? copy.trust.hideSource : copy.trust.showSource}<span aria-hidden="true">{open === item.id ? '−' : '+'}</span></button>
          {open === item.id && <div className="evidence-details"><pre dir="auto">{item.source.excerpt ?? item.source.note ?? `${item.source.base ?? ''} → ${item.source.head ?? ''}`}</pre></div>}</>;
        const sessionId = trust[item.id]?.origin?.session?.id;
        // A delivered snapshot never changes; a preview's notes are checked again at the start.
        return <li key={item.id}>{project ? <NoteCard note={item} project={project} variant={receiptVariant(receipt.state)} receiptState={receipt.state} trust={trust[item.id]} matched={item.selection?.terms} onOpenSession={sessionId && openable.has(sessionId) ? onOpenSession : undefined} actions={actions}>{details}</NoteCard>
          : <><p dir="auto">{item.statement}</p>{details}<div className="memory-actions">{actions}</div></>}</li>;
      })}</ol>
      {receipt.references?.length ? <References title={`Referenced for this task · ${receipt.references.length}`} projectId={(receipt as any).projectId} workspaceId={receipt.workspaceId ?? null} references={receipt.references} /> : null}
      {session && <SessionReferences session={session} events={events} />}
      {preview && disabled.length > 0 && <p className="hint">{count(disabled.length, 'note')} left out for the next start. <button className="text-button" onClick={() => disabled.forEach(onToggle)}>Restore all</button></p>}
      {receipt.excluded.length > 0 && <details><summary>{copy.notIncluded} · {receipt.excluded.length}</summary>{receipt.excluded.map(x => <p key={x.id + x.reason} className="muted">{x.id.slice(0, 8)} · {excludedReason(x.reason)}{x.reason === 'left-out-for-task' && preview ? <> · <button className="text-button" onClick={() => onToggle(x.id)}>restore</button></> : null}</p>)}</details>}
      {receipt.warnings?.map(warning => <p className="hint" key={warning}>{warningText(warning)}</p>)}
      <button className="text-button" aria-expanded={raw} onClick={() => setRaw(!raw)}>{raw ? 'Hide' : 'Show'} exact {receipt.launchPrompt !== undefined ? 'launch text' : 'text'}</button>
      {raw && <pre ref={packet} className="context-packet" data-testid="context-packet" dir="auto">{(receipt.launchPrompt ?? receipt.packet) || 'No Journal text supplied at launch.'}</pre>}
      {!raw && <pre className="context-packet visually-hidden" data-testid="context-packet" aria-hidden="true">{(receipt.launchPrompt ?? receipt.packet) || 'No Journal text supplied at launch.'}</pre>}
      <p className="receipt-note">{receipt.state === 'prepared' ? 'Preview only. Sources are checked again when you start.' : receipt.state === 'submitted' ? 'Sent means the CLI process started with this text. It does not prove the model read or used it.' : receipt.state === 'failed' ? 'Launch failed. Delivery to the native CLI was not confirmed.' : 'Delivery is uncertain after interruption. No input will be replayed automatically.'}{receipt.preview ? '' : ' This record never changes.'}</p>{!receipt.preview && <small className="receipt-id">{receipt.id}</small>}
    </>}
    {history.length > 0 && <div className="receipt-history"><span className="eyebrow">Sent before</span>{history.slice(0, 10).map(r => <button key={r.id} onClick={() => onSelectReceipt(r)}><span>{r.query || 'Interactive session'}</span><small>{count(r.items.length, 'note')} · {deliveryState(r.state)} · {new Date(r.createdAt).toLocaleString()}</small></button>)}</div>}
  </div>;
}
