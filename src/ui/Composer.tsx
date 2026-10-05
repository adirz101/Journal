import { useCallback, useMemo, useRef, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { TaskField } from './TaskField';
import { ContextPreview, PreviewNote } from './ContextPreview';
import { ProviderStatus } from './ProviderStatus';
import type { ProviderBusy, ProviderHandlers } from './AgentRow';
import { actionLabel, actionName } from './firstRunModel';
import { useKeepFocus } from './useKeepFocus';
import { ProviderMark } from './ProviderMark';
import { useContextPreview } from './useContextPreview';
import { AGENT_ORDER, MAX_LIVE, agentCard, agentReady, agentTitle, modeBlock, MODES, modeSupport, previewView, startBlock, type PreviewItem } from './composerModel';
import { composer, copy, palette } from './copy';
import { StartError } from './StartError'; // Phase 8
import { startProblem } from './statesModel'; // Phase 8
import { PROVIDER_NAMES, type Bootstrap, type FileReference, type Mode, type Project, type Provider, type Receipt, type WorkspaceList } from './types';

export interface ComposerProps {
  project: Project; bootstrap: Bootstrap | null; workspaces: WorkspaceList | null;
  workspaceId: string; onWorkspace(id: string): void; onManageWorkspaces(): void;
  task: string; onTask(value: string): void; taskRef: RefObject<HTMLTextAreaElement | null>;
  references: FileReference[]; onRemoveReference(index: number): void;
  disabled: string[]; onDisabled(next: string[]): void;
  provider: Provider; onProvider(p: Provider): void; mode: Mode; onMode(m: Mode): void;
  connected: boolean; liveCount: number; busy: boolean;
  onStart(): void;                       // App's start(provider) with modeFlags(mode)
  onInspect(receipt: Receipt): void;     // set the receipt, show the inspector's Session tab
  onChecked?(receipt: Receipt): void;    // every applied full check (the inspector follows a preview it shows)
  // Install, the install page, sign in and check again for every provider (Phase 7's handlers,
  // shared with Welcome). busy: an action or check in flight per provider; notes: what the last
  // install or sign-in changed, per provider (shown under the cards).
  providers: ProviderHandlers & { busy: ProviderBusy; notes: Partial<Record<Provider, string>> };
  mark: string;                          // the mascot for the empty "Relevant to your task" box (board 12, placement 3)
  justRemembered: ReadonlySet<string>;   // notes remembered on the first-run screen in this app run
  startError: { code?: string; message: string } | null;
  knowledgeVersion: number;
  onAddReference?(): void;               // Phase 8: opens the palette's file search to reference a file
}

// One agent card (a radio) and its one next action, named as on the Welcome rows
// (actionLabel, actionName). When an update removes the focused action, focus moves to the radio.
function AgentChoice({ provider: p, agent: info, chosen: on, current, busy, handlers, onProvider }: {
  provider: Provider; agent: Bootstrap['agents'][number] | undefined; chosen: boolean; current: Provider; busy: boolean; handlers: ProviderHandlers; onProvider(p: Provider): void;
}) {
  const status = agentCard(info, p);
  const ref = useKeepFocus<HTMLDivElement>(root => root.querySelector<HTMLElement>('[role=radio]'));
  const run = { install: handlers.onInstall, 'install-page': handlers.onInstallPage, login: handlers.onLogin };
  return <div className="agent-card" ref={ref}>
    <div role="radio" id={`agent-radio-${p}`} aria-checked={on} tabIndex={on ? 0 : -1} className="agent-option" aria-label={PROVIDER_NAMES[p]} aria-describedby={`agent-sub-${p}`} title={agentTitle(info)}
      onClick={() => onProvider(p)} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); onProvider(p); } else roving(event, AGENT_ORDER, current, onProvider); }}>
      <ProviderMark provider={p} size={24} /><span className="agent-name">{PROVIDER_NAMES[p]}</span><span className={`agent-sub tone-${status.tone}`} id={`agent-sub-${p}`}>{status.sub}</span>
    </div>
    {status.action && <button type="button" className="agent-action link" disabled={busy} aria-label={actionName(status.action, PROVIDER_NAMES[p])} aria-describedby={`agent-sub-${p}`}
      onClick={() => run[status.action!](p)}>{actionLabel(status.action)}</button>}
  </div>;
}

const MODE_LABEL: Record<Mode, string> = { build: composer.build, plan: composer.plan, 'read-only': composer.readOnly };

// Arrow keys, Home and End for a radio group with roving tabIndex.
function roving<T>(event: KeyboardEvent, items: readonly T[], current: T, choose: (item: T) => void, allowed: (item: T) => boolean = () => true) {
  const at = items.indexOf(current); let next = -1;
  const step = (from: number, by: number) => { for (let i = 1; i <= items.length; i++) { const j = (from + by * i + items.length * i) % items.length; if (allowed(items[j])) return j; } return -1; };
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = step(at, 1);
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = step(at, -1);
  else if (event.key === 'Home') next = step(-1, 1);
  else if (event.key === 'End') next = step(0, -1);
  else return;
  event.preventDefault();
  if (next < 0) return;
  choose(items[next]);
  (event.currentTarget.parentElement?.closest('[role=radiogroup]')?.querySelectorAll<HTMLElement>('[role=radio]')[next])?.focus();
}

// The New session composer (board B5): task, agent, mode, workspace and one
// Start, beside the live preview of what the agent will know. App owns the
// state; the preview hook is the only thing this component runs on its own.
export function Composer(props: ComposerProps) {
  const { project, bootstrap, workspaces, workspaceId, task, references, disabled, provider, mode } = props;
  const mac = bootstrap?.platform === 'darwin';
  const agent = bootstrap?.agents.find(a => a.provider === provider);
  // The branch the selected checkout or worktree shows: a display hint only, the full check and the launch use Git.
  const branch = workspaceId && !workspaceId.startsWith('root:') ? workspaces?.workspaces.find(w => w.id === workspaceId)?.branch ?? null : project.branch;
  const referenceInputs = useMemo(() => references.map(ref => ({ projectId: ref.projectId, rootKey: ref.rootKey, path: ref.path, startLine: ref.startLine, endLine: ref.endLine })), [references]);
  const preview = useContextPreview({ projectId: project.id, task, workspaceId: workspaceId || null, branch, disabled, references: referenceInputs, version: props.knowledgeVersion }, props.onChecked);
  const view = useMemo(() => previewView(preview.result, disabled), [preview.result, disabled]);
  // The selection preview counts the notes a task could match; a full check keeps the last
  // count. Another project or workspace starts without one.
  const scope = `${project.id}\n${workspaceId}`;
  const taskNotes = useRef<{ scope: string; count: number | null }>({ scope, count: null });
  if (taskNotes.current.scope !== scope) taskNotes.current = { scope, count: null };
  if (view?.taskNotes !== null && view?.taskNotes !== undefined) taskNotes.current.count = view.taskNotes;
  // Stable callbacks (they read the newest props through a ref), so the memoized task box and
  // preview re-render only when their data changes.
  const live = useRef(props); live.current = props;
  const leaveOut = useCallback((id: string) => { const { disabled: current, onDisabled } = live.current; if (!current.includes(id)) onDisabled([...current, id]); }, []);
  const restore = useCallback(() => live.current.onDisabled([]), []);
  const block = startBlock({ connected: props.connected, liveCount: props.liveCount, busy: props.busy, agent, provider, mode });
  const support = modeSupport(provider, agent);
  const start = (event?: FormEvent) => { event?.preventDefault(); if (block === null) props.onStart(); };
  // ⌘↵ / Ctrl+Enter: anywhere in the composer form (task box, agent cards, mode, workspace,
  // Start), but not inside the hover card, whose keys belong to the card's own controls.
  const keys = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || !(mac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
    if ((event.target as Element).closest?.('.task-card')) return;
    event.preventDefault(); start();
  };
  const flush = preview.flush;
  const inspect = useCallback(async () => { const receipt = await flush(); if (receipt) live.current.onInspect(receipt); }, [flush]);
  const relevantNotes = view?.relevant; const viewChecked = !!view?.checked;
  const card = useCallback((term: string | null) => <ul className="task-card-list">{(relevantNotes ?? []).filter(item => term ? item.selection?.terms?.includes(term) : item.selection?.terms?.length).map((item: PreviewItem) => <li key={item.id}>
    <PreviewNote item={item} project={project} variant="hover" checked={viewChecked} onLeaveOut={() => leaveOut(item.id)} /></li>)}</ul>, [relevantNotes, viewChecked, project, leaveOut]);
  const onRemoveReference = props.onRemoveReference;
  const footer = useMemo(() => references.length > 0 && <ul className="reference-chips" aria-label={composer.referencesLabel}>{references.map((ref, index) => <li key={`${ref.rootKey}:${ref.path}:${ref.startLine}`}>
    <span title={`${ref.rootLabel ?? ''} · ${ref.path}${ref.contentHash ? ` · sha256 ${ref.contentHash.slice(0, 12)}` : ''}`}>{ref.kind === 'folder' ? '▸ ' : ''}{ref.display ?? ref.path}{ref.startLine ? `:${ref.startLine}${ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}` : ''}</span>
    <button type="button" aria-label={`Remove ${ref.path} from the next task`} onClick={() => onRemoveReference(index)}>×</button></li>)}
    <li className="muted">{composer.referencesHint}</li></ul>, [references, onRemoveReference]);
  const worktree = !!workspaceId && !workspaceId.startsWith('root:');
  const startKeys = mac ? '⌘↵' : 'Ctrl+Enter';
  // A refused start is explained while its cause holds: "4 sessions are running" goes once a slot frees.
  const startError = props.startError && !(props.startError.code === 'SLOTS_FULL' && props.liveCount < MAX_LIVE) ? props.startError : null;
  // === Phase 8: an agent that can't start (StartError) ===
  // A refused start's card stays until the choice changes, the next start, or (missing or
  // unsupported) until Check again finds the agent ready; an agent's own status check shows its
  // card only for a sign-in (a missing or unsupported agent that was never started keeps the
  // reason beside Start).
  const problem = startProblem({ provider, agent, error: startError });
  const problemCard = problem && (startError ? !((problem.kind === 'missing' || problem.kind === 'unsupported') && agentReady(agent)) : problem.kind === 'signed-out') ? problem : null;
  const shown = block ?? (startError && !problemCard ? startError.message : null);
  // When the card goes with focus on one of its buttons (Check again found the agent ready),
  // focus moves to Start when it can be pressed, otherwise to the task box (Phase 9).
  const errorSlot = useKeepFocus<HTMLDivElement>(root => root.closest('form')?.querySelector<HTMLElement>('.start-button:not(:disabled)') ?? document.getElementById('task'));
  // === End Phase 8 ===

  return <div className="composer">
    <form className="composer-form" aria-label="Start a session" onSubmit={start} onKeyDown={keys}>
      <div className="composer-field">
        <div className="field-label"><label htmlFor="task">{composer.task}</label><span id="task-hint">· {composer.taskHint}</span>{props.onAddReference && <button type="button" className="text-button reference-add" onClick={props.onAddReference}>{palette.addReference}</button>}</div>
        <TaskField ref={props.taskRef} value={task} onChange={props.onTask} matched={view?.matchedTerms ?? EMPTY} matchCount={view?.matchCount ?? 0} cardNotes={card} footer={footer} />
      </div>

      <div className="composer-field">
        <span className="field-label" id="agent-label">{composer.agent}</span>
        <div className="agent-cards" role="radiogroup" aria-labelledby="agent-label">
          {AGENT_ORDER.map(p => <AgentChoice key={p} provider={p} agent={bootstrap?.agents.find(a => a.provider === p)} chosen={p === provider} current={provider}
            busy={!!props.providers.busy[p]} handlers={props.providers} onProvider={props.onProvider} />)}
        </div>
        {/* Every agent's details region stays mounted (its note is a live region); the chosen agent's details show. */}
        {AGENT_ORDER.map(p => <ProviderStatus key={p} provider={p} agent={bootstrap?.agents.find(a => a.provider === p)} open={p === provider}
          busy={!!props.providers.busy[p]} rechecking={props.providers.busy[p] === 'check'} note={props.providers.notes[p] ?? ''} onCheck={props.providers.onCheck}
          fallback={() => document.getElementById(`agent-radio-${p}`)} />)}
      </div>

      <div className="composer-field">
        <span className="field-label" id="mode-label">{composer.mode}</span>
        <div className="mode-switch" role="radiogroup" aria-labelledby="mode-label" aria-describedby="mode-help">
          {MODES.map(m => {
            const reason = modeBlock(provider, agent, m); const on = m === mode;
            return <button type="button" role="radio" key={m} aria-checked={on} tabIndex={on ? 0 : -1} aria-disabled={reason ? true : undefined} title={reason ?? undefined}
              onClick={() => { if (!reason) props.onMode(m); }} onKeyDown={event => roving(event, MODES, mode, props.onMode, item => support[item])}>{MODE_LABEL[m]}</button>;
          })}
        </div>
        <p id="mode-help" className="field-help">{composer.modeHelp[mode]}</p>
      </div>

      <div className="composer-field">
        <label className="field-label" htmlFor="workspace">{composer.workspace}</label>
        <div className="workspace-row">
          <select id="workspace" value={workspaceId} onChange={event => props.onWorkspace(event.target.value)} aria-label={composer.workspace}>
            <option value="">{composer.currentCheckout(project.branch ?? 'detached HEAD')}</option>
            {workspaces?.workspaces.filter(w => w.state === 'ready').map(w => <option key={w.id} value={w.id!}>{w.kind === 'managed' ? `${copy.separateCopy} · ${w.branch ?? 'detached'}` : composer.existingWorktree(w.branch ?? 'detached')}</option>)}
            {project.roots?.map(root => <option key={root.id} value={`root:${root.id}`}>{composer.folder(root.name)}</option>)}
          </select>
          <button type="button" onClick={props.onManageWorkspaces}>{composer.manage}<span className="visually-hidden">{composer.manageWorkspacesSuffix}</span></button>
        </div>
        {worktree && <p className="field-help">{composer.separateCopyHelp}</p>}
      </div>

      <div className="start-error-slot" ref={errorSlot}>{problemCard && <StartError problem={problemCard} alert={!!startError}
        onOpenTerminal={problemCard.kind === 'signed-out' && agent?.supports?.login ? () => props.providers.onLogin(provider) : problemCard.kind === 'missing' && problemCard.command ? () => props.providers.onInstall(provider) : null} />}</div>
      <div className="start-row">
        <button type="submit" className="primary start-button" disabled={block !== null} aria-describedby="start-reason" aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}>
          {composer.start(PROVIDER_NAMES[provider])} <kbd aria-hidden="true">{startKeys}</kbd></button>
        <span className="start-reason" id="start-reason" role="status">{shown}</span>
      </div>
      <p className="field-help native-stays">{composer.nativeStays}</p>
    </form>
    <ContextPreview view={view} error={preview.error} taskNotes={taskNotes.current.count} project={project} mac={mac} hasTask={task.trim().length > 0} mark={props.mark} justRemembered={props.justRemembered}
      onLeaveOut={leaveOut} onRestore={restore} onInspect={inspect} />
  </div>;
}

const EMPTY: ReadonlySet<string> = new Set();
