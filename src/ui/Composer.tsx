import { useMemo, useRef, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { TaskField } from './TaskField';
import { ContextPreview, PreviewNote } from './ContextPreview';
import { CursorStatus } from './ProviderStatus';
import { ProviderMark } from './ProviderMark';
import { useContextPreview } from './useContextPreview';
import { AGENT_ORDER, MAX_LIVE, agentCard, agentTitle, modeBlock, MODES, modeSupport, previewView, startBlock, type PreviewItem } from './composerModel';
import { composer, copy } from './copy';
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
  // Provider rows (Phase 7, every provider): install, the install page, sign in and check again.
  // note: Cursor's result after its install or sign-in (shown in Cursor's status row).
  providers: { checking: boolean; note: string; onInstall(p: Provider): void; onInstallPage(p: Provider): void; onLogin(p: Provider): void; onCheck(p: Provider): void };
  startError: { code?: string; message: string } | null;
  knowledgeVersion: number;
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
  const leaveOut = (id: string) => { if (!disabled.includes(id)) props.onDisabled([...disabled, id]); };
  const restore = () => props.onDisabled([]);
  const block = startBlock({ connected: props.connected, liveCount: props.liveCount, busy: props.busy, agent, provider, mode });
  const support = modeSupport(provider, agent);
  const start = (event?: FormEvent) => { event?.preventDefault(); if (block === null) props.onStart(); };
  const keys = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || !(mac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
    event.preventDefault(); start();
  };
  const inspect = async () => { const receipt = await preview.flush(); if (receipt) props.onInspect(receipt); };
  const matchedNotes = (term: string | null) => (view?.relevant ?? []).filter(item => term ? item.selection?.terms?.includes(term) : item.selection?.terms?.length);
  const card = (term: string | null) => <ul className="task-card-list">{matchedNotes(term).map((item: PreviewItem) => <li key={item.id}>
    <PreviewNote item={item} project={project} variant="hover" checked={!!view?.checked} onLeaveOut={() => leaveOut(item.id)} /></li>)}</ul>;
  const worktree = !!workspaceId && !workspaceId.startsWith('root:');
  const startKeys = mac ? '⌘↵' : 'Ctrl+Enter';
  // A refused start is explained while its cause holds: "4 sessions are running" goes once a slot frees.
  const startError = props.startError && !(props.startError.code === 'SLOTS_FULL' && props.liveCount < MAX_LIVE) ? props.startError : null;
  const shown = block ?? (startError ? startError.message : null);

  return <div className="composer">
    <form className="composer-form" aria-label="Start a session" onSubmit={start} onKeyDown={keys}>
      <div className="composer-field">
        <div className="field-label"><label htmlFor="task">{composer.task}</label><span id="task-hint">· {composer.taskHint}</span></div>
        <TaskField ref={props.taskRef} value={task} onChange={props.onTask} matched={view?.matchedTerms ?? EMPTY} matchCount={view?.matchCount ?? 0} cardNotes={card}
          footer={references.length > 0 && <ul className="reference-chips" aria-label={composer.referencesLabel}>{references.map((ref, index) => <li key={`${ref.rootKey}:${ref.path}:${ref.startLine}`}>
            <span title={`${ref.rootLabel ?? ''} · ${ref.path}${ref.contentHash ? ` · sha256 ${ref.contentHash.slice(0, 12)}` : ''}`}>{ref.kind === 'folder' ? '▸ ' : ''}{ref.display ?? ref.path}{ref.startLine ? `:${ref.startLine}${ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}` : ''}</span>
            <button type="button" aria-label={`Remove ${ref.path} from the next task`} onClick={() => props.onRemoveReference(index)}>×</button></li>)}
            <li className="muted">{composer.referencesHint}</li></ul>} />
      </div>

      <div className="composer-field">
        <span className="field-label" id="agent-label">{composer.agent}</span>
        <div className="agent-cards" role="radiogroup" aria-labelledby="agent-label">
          {AGENT_ORDER.map(p => {
            const info = bootstrap?.agents.find(a => a.provider === p); const status = agentCard(info); const on = p === provider;
            return <div className="agent-card" key={p}>
              <div role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className="agent-option" aria-label={PROVIDER_NAMES[p]} aria-describedby={`agent-sub-${p}`} title={agentTitle(info)}
                onClick={() => props.onProvider(p)} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); props.onProvider(p); } else roving(event, AGENT_ORDER, provider, props.onProvider); }}>
                <ProviderMark provider={p} size={24} /><span className="agent-name">{PROVIDER_NAMES[p]}</span><span className={`agent-sub tone-${status.tone}`} id={`agent-sub-${p}`}>{status.sub}</span>
              </div>
              {status.action && <button type="button" className="agent-action link" disabled={props.providers.checking} aria-describedby={`agent-sub-${p}`}
                onClick={() => (status.action === 'install' ? props.providers.onInstall : status.action === 'page' ? props.providers.onInstallPage : props.providers.onLogin)(p)}>
                {status.action === 'install' ? composer.install : status.action === 'page' ? composer.installPage : composer.signIn}<span className="visually-hidden"> {PROVIDER_NAMES[p]}</span></button>}
            </div>;
          })}
        </div>
        {provider === 'cursor' && <CursorStatus agent={agent} checking={props.providers.checking} note={props.providers.note} onInstall={() => props.providers.onInstall('cursor')} onLogin={() => props.providers.onLogin('cursor')} onCheck={() => props.providers.onCheck('cursor')} />}
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

      <div className="start-row">
        <button type="submit" className="primary start-button" disabled={block !== null} aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}>
          {composer.start(PROVIDER_NAMES[provider])} <kbd aria-hidden="true">{startKeys}</kbd></button>
        <span className="start-reason" role="status">{shown}</span>
      </div>
      <p className="field-help native-stays">{composer.nativeStays}</p>
    </form>
    <ContextPreview view={view} error={preview.error} taskNotes={taskNotes.current.count} project={project} mac={mac}
      onLeaveOut={leaveOut} onRestore={restore} onInspect={() => void inspect()} />
  </div>;
}

const EMPTY: ReadonlySet<string> = new Set();
