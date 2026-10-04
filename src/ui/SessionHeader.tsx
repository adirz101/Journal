import { isLive, PROVIDER_NAMES, type Session } from './types';
import { resumable, type SessionState } from './sessionState';
import { relativeTime } from './sidebarModel';
import { copy, shell, tip } from './copy';
import { ProviderMark } from './ProviderMark';

type Point = { x: number; y: number };

// The selected session's header (board B4): title and actions, then provider,
// workspace, mode, start time and state. Rename stays in the menus (RenameDialog),
// so keys typed next to a focused terminal never land in a title field.
export function SessionHeader({ session, state, connected, busy, canStart, now, mac, projectBranch, agentVersion, onInterrupt, onStop, onContinue, onArchiveToggle, onEndOrphan, onEndSurvivors, onMenu }: {
  session: Session; state: SessionState; connected: boolean; busy: boolean; canStart: boolean; now: number; mac: boolean;
  projectBranch: string | null; agentVersion: string | null;
  onInterrupt(): void; onStop(): void; onContinue(): void; onArchiveToggle(): void; onEndOrphan(): void; onEndSurvivors(): void; onMenu(at: Point): void;
}) {
  const title = session.displayName || session.title;
  const version = session.cliVersion ?? agentVersion;
  const root = session.workspaceId?.startsWith('root:');
  // The checkout moved to another branch while this session runs in it.
  const moved = !session.workspaceId && isLive(session) && session.branch !== undefined && session.branch !== projectBranch;
  const survivors = session.survivors?.length ?? 0;
  return <header className="session-header">
    <div className="session-header-row">
      <h1 className="session-title" title={title}>{title}</h1>
      <div className="session-actions">
        {isLive(session) && connected && <><button onClick={onInterrupt}>{shell.interrupt} <kbd>{mac ? '⌃C' : 'Ctrl+C'}</kbd></button><button className="danger-ghost" onClick={onStop} disabled={session.status === 'stopping'}>{copy.stop}</button></>}
        {resumable(session) && <button title={tip.continue} disabled={busy || !canStart} onClick={onContinue}>{copy.continue}</button>}
        {session.status === 'orphaned' && session.identityVerified !== false && <button onClick={onEndOrphan}>End orphaned process</button>}
        {survivors > 0 && <button onClick={onEndSurvivors}>End {survivors} leftover process{survivors === 1 ? '' : 'es'}</button>}
        {!isLive(session) && <button onClick={onArchiveToggle}>{session.archived ? 'Unarchive' : 'Archive'}</button>}
        <button onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); onMenu({ x: rect.left, y: rect.bottom }); }} aria-label="More session actions" aria-haspopup="menu">⋯</button>
      </div>
    </div>
    <div className="session-meta">
      <span className="meta-provider"><ProviderMark provider={session.provider} size={16} />{PROVIDER_NAMES[session.provider]}{version ? ` ${version}` : ''}</span>
      <span className="meta-workspace">{session.workspaceId && !root ? <><span title={tip.separateCopy}>{copy.separateCopy}</span>{session.branch ? ` · ⑂ ${session.branch}` : ''}</>
        : root ? `Folder · ${session.cwd?.split(/[\\/]/).pop() ?? 'folder'}` : session.branch !== undefined ? `${moved ? 'started on ' : ''}⑂ ${session.branch ?? 'detached HEAD'}` : null}</span>
      <span className="meta-mode" title={session.research ? tip.readOnly : session.plan ? tip.plan : undefined}>{session.research ? copy.readOnly : session.plan ? shell.planMode : shell.buildMode}</span>
      <span className="meta-started" title={new Date(session.createdAt).toLocaleString()}>{shell.started(relativeTime(session.createdAt, now))}</span>
      <span className={`meta-state tone-${state.tone}`}>{state.word}{state.detail ? ` · ${state.detail}` : ''}</span>
      {state.limited && <span className="chip" title={tip.limitedStatus}>{shell.limitedStatus}</span>}
    </div>
  </header>;
}

// Claude's open permission prompt (board B4). Journal names what it asks and
// never answers it: the user answers in the terminal. Codex and Cursor report no prompts.
export function AttentionBanner({ session }: { session: Session }) {
  if (session.provider !== 'claude' || session.status !== 'waiting') return null;
  const pending = session.pending; const target = pending?.command ?? pending?.path;
  return <div className="attention-banner" role="status">
    <span className="attention-icon" aria-hidden="true">!</span>
    <p><b>{shell.approvalTitle}</b>{target && <> · {pending?.tool ? `${pending.tool}: ` : ''}<code title={pending?.inferred ? 'Inferred from the last command Claude started' : undefined}>{target}</code></>}
      {' '}{shell.answerInTerminal}<span className="banner-extra"> {shell.neverApproves}</span></p>
  </div>;
}
