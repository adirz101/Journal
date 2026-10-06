import { isLive, PROVIDER_NAMES, type Session } from './types';
import { resumable, type SessionState, observed, reports } from './sessionState';
import { relativeTime } from './sidebarModel';
import { branches as branchWords, copy, isolation as isolationWords, shell, tip } from './copy';
import { ProviderMark } from './ProviderMark';

type Point = { x: number; y: number };

// The selected session's header (board B4): title and actions, then provider,
// workspace, mode, start time and state. Rename stays in the menus (RenameDialog),
// so keys typed next to a focused terminal never land in a title field.
export function SessionHeader({ session, state, connected, busy, canStart, now, mac, projectBranch, agentVersion, hideContinue, onSwitchBranch, onInterrupt, onStop, onContinue, onArchiveToggle, onEndOrphan, onEndSurvivors, onMenu }: {
  session: Session; state: SessionState; connected: boolean; busy: boolean; canStart: boolean; now: number; mac: boolean;
  projectBranch: string | null; agentVersion: string | null;
  hideContinue?: boolean;  // Phase 6: the wrap-up carries Continue itself
  // Opens the branch picker on the session's repository (its checkout or worktree); absent for another project's session.
  onSwitchBranch?: () => void;
  onInterrupt(): void; onStop(): void; onContinue(): void; onArchiveToggle(): void; onEndOrphan(): void; onEndSurvivors(): void; onMenu(at: Point): void;
}) {
  const title = session.displayName || session.title;
  const version = session.cliVersion ?? agentVersion;
  const root = session.workspaceId?.startsWith('root:');
  // The checkout moved to another branch while this session runs in it.
  const moved = !session.workspaceId && isLive(session) && session.branch !== undefined && session.branch !== projectBranch;
  const survivors = session.survivors?.length ?? 0;
  // The branch the session started on; pressing it opens the branch picker on that repository.
  const branchLabel = (label: string) => onSwitchBranch ? <button type="button" className="meta-branch" aria-haspopup="dialog" aria-label={`${label}, ${branchWords.heading.toLowerCase()}…`} title={branchWords.heading} onClick={onSwitchBranch}>{label}</button> : label;
  return <header className="session-header">
    <div className="session-header-row">
      <h1 className="session-title" title={title}>{title}</h1>
      <div className="session-actions">
        {isLive(session) && connected && <><button onClick={onInterrupt}>{shell.interrupt} <kbd>{mac ? '⌃C' : 'Ctrl+C'}</kbd></button><button className="danger-ghost" onClick={onStop} disabled={session.status === 'stopping'}>{copy.stop}</button></>}
        {resumable(session) && !hideContinue && <button title={tip.continue} disabled={busy || !canStart} onClick={onContinue}>{copy.continue}</button>}
        {session.status === 'orphaned' && session.identityVerified !== false && <button onClick={onEndOrphan}>End orphaned process</button>}
        {survivors > 0 && <button onClick={onEndSurvivors}>End {survivors} leftover process{survivors === 1 ? '' : 'es'}</button>}
        {!isLive(session) && <button onClick={onArchiveToggle}>{session.archived ? 'Unarchive' : 'Archive'}</button>}
        <button onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); onMenu({ x: rect.left, y: rect.bottom }); }} aria-label="More session actions" aria-haspopup="menu">⋯</button>
      </div>
    </div>
    <div className="session-meta">
      <span className="meta-provider"><ProviderMark provider={session.provider} size={16} />{PROVIDER_NAMES[session.provider]}{version ? ` ${version}` : ''}</span>
      <span className="meta-workspace">{session.environmentId ? <><span title={isolationWords.label}>{isolationWords.heading}</span>{session.branch ? <> · ⑂ {session.branch}</> : ''}</>
        : session.workspaceId && !root ? <><span title={tip.separateCopy}>{copy.separateCopy}</span>{session.branch ? <> · {branchLabel(`⑂ ${session.branch}`)}</> : ''}</>
        : root ? `Folder · ${session.cwd?.split(/[\\/]/).pop() ?? 'folder'}` : session.branch !== undefined ? <>{moved ? 'started on ' : ''}{branchLabel(`⑂ ${session.branch ?? 'detached HEAD'}`)}</> : null}</span>
      <span className="meta-mode" title={session.research ? tip.readOnly : session.plan ? tip.plan : undefined}>{session.role === 'coordinator' ? 'Coordinate mode' : session.research ? copy.readOnly : session.plan ? shell.planMode : shell.buildMode}</span>
      <span className="meta-started" title={new Date(session.createdAt).toLocaleString()}>{shell.started(relativeTime(session.createdAt, now))}</span>
      <span className={`meta-state tone-${state.tone}`}>{state.word}{state.detail ? ` · ${state.detail}` : ''}</span>
      {state.limited && <span className="chip" title={tip.limitedStatus}>{shell.limitedStatus}</span>}
    </div>
  </header>;
}

// An observed permission prompt (Claude and Codex; board B4). Journal names what it asks and
// never answers it: the user answers in the terminal. Cursor reports no prompts.
// The status region stays mounted while a session is shown, so the banner's text is
// announced when it appears (a live region inserted with its text often is not).
// The banner names the agent the way the notifications do.
const AGENT_SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };
export function AttentionBanner({ session }: { session: Session }) {
  const shown = session.status === 'waiting' && observed(session) && reports(session, 'approvals');
  const pending = session.pending; const target = pending?.command ?? pending?.path;
  return <div className="attention-live" role="status">{shown && <div className="attention-banner">
    <span className="attention-icon" aria-hidden="true">!</span>
    <p><b>{shell.approvalTitle(AGENT_SHORT[session.provider] ?? PROVIDER_NAMES[session.provider])}</b>{target && <> · {pending?.tool ? `${pending.tool}: ` : ''}<code title={pending?.inferred ? shell.inferredCommand : undefined}>{target}</code></>}
      {' '}{shell.answerInTerminal}<span className="banner-extra"> {shell.neverApproves}</span></p>
  </div>}</div>;
}
