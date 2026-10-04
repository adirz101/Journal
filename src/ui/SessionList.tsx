import { useState } from 'react';
import { isLive, PROVIDER_NAMES, type CommandId, type Project, type Session } from './types';
import { needsYou, slotOrder, stateFor } from './sessionState';
import { copy, tip } from './copy';
import { menuPosition } from './menu';
import { ProviderMark } from './ProviderMark';

export const sessionName = (session: Session) => session.displayName || session.title;
// Recent and Archived: pinned first (in pin order), then newest first.
export const byPin = (a: Session, b: Session) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((a.pinSeq ?? 0) - (b.pinSeq ?? 0)) || b.createdAt.localeCompare(a.createdAt);

const providerName = (session: Session) => PROVIDER_NAMES[session.provider];

export function relativeTime(iso: string | null | undefined, now: number) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function SessionList({ sessions, projects, selectedId, currentProjectId, connected, now, onSelect, onMenu, onNew, newShortcut, shortcuts, canStart }: {
  sessions: Session[]; projects: Project[]; selectedId: string | null; currentProjectId: string | null; connected: boolean; now: number;
  onSelect: (session: Session) => void; onMenu: (session: Session, position?: { x: number; y: number }) => void; onNew: () => void; newShortcut?: { label: string; aria: string }; shortcuts?: Partial<Record<CommandId, { label: string; aria: string }>>; canStart: boolean;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const visible = sessions.filter(s => !s.removed);
  // Running sessions always stay in Active, archived or not, from every project,
  // in the order of their stable slots (⌘1–4 / Alt+1–4); pins order only Recent and Archived.
  const active = slotOrder(visible);
  const recent = visible.filter(s => !active.includes(s) && s.projectId === currentProjectId && !s.archived).sort(byPin);
  const archived = visible.filter(s => s.archived && !active.includes(s) && s.projectId === currentProjectId).sort(byPin);
  const projectName = (id: string) => projects.find(p => p.id === id)?.name ?? 'Unknown project';
  const row = (session: Session) => {
    const state = stateFor(session, now, connected); const attention = needsYou(session) || state.tone === 'attention';
    const disconnected = isLive(session) && !connected;
    const slot = isLive(session) && session.slot ? shortcuts?.[`slot-${session.slot}` as CommandId] : undefined;
    const time = isLive(session) ? relativeTime(session.createdAt, now) : relativeTime(session.endedAt ?? session.lastActivityAt ?? session.createdAt, now);
    return <button key={session.id} className={`session-select ${session.id === selectedId ? 'selected' : ''}`} aria-current={session.id === selectedId ? 'true' : undefined} onClick={() => onSelect(session)}
      onContextMenu={event => { event.preventDefault(); onMenu(session, menuPosition(event)); }} aria-keyshortcuts={slot?.aria}
      aria-label={`${providerName(session)}: ${sessionName(session)}. ${state.word}${state.detail ? `, ${state.detail}` : ''}${state.limited ? `, ${copy.state.limited}` : ''}${session.pinned ? ', pinned' : ''}${attention ? ', needs attention' : ''}`}>
      {/* Codex and Cursor never show the amber "waiting" dot: Journal cannot see their prompts. */}
      <span className={`status-dot ${state.limited ? 'running' : session.status}${disconnected ? ' disconnected' : ''}`} />
      <ProviderMark provider={session.provider} size={16} />
      <span className="session-text"><strong>{providerName(session)}{session.pinned && <span className="pin-mark" aria-hidden="true"> ⚲</span>}{session.archived && <span className="badge archived-badge">archived</span>}{attention && <span className="attention" aria-hidden="true"> ●</span>}</strong><small>{sessionName(session)}</small>
        {state.detail && <small className="session-detail">{state.detail}</small>}
        {(session.projectId !== currentProjectId || session.workspaceId) && <small className="session-project">{session.projectId !== currentProjectId ? projectName(session.projectId) : ''}{session.workspaceId ? `${session.projectId !== currentProjectId ? ' · ' : ''}⑂ ${session.branch ?? 'worktree'}` : ''}</small>}</span>
      <span className="session-meta"><span className={`session-status ${attention ? 'attention-text' : ''}`} title={state.limited ? tip.limitedStatus : undefined}>{state.word}</span><time dateTime={session.createdAt} title={isLive(session) ? 'Elapsed' : 'Ended'}>{time}</time></span>
    </button>;
  };
  return <>
    <div className="nav-caption sessions-caption">SESSIONS<span>{visible.filter(s => isLive(s)).length}/4 active</span><button className="new-session" onClick={onNew} disabled={!canStart} aria-label="New session" title={newShortcut ? `New session (${newShortcut.label})` : 'New session'} aria-keyshortcuts={newShortcut?.aria}>New</button></div>
    <nav aria-label="Sessions" className="session-nav">
      {active.length > 0 && <div className="session-group" role="group" aria-label="Active sessions">{active.map(row)}</div>}
      {recent.length > 0 && <><div className="session-group-label">RECENT</div><div className="session-group" role="group" aria-label="Recent sessions">{recent.map(row)}</div></>}
      {archived.length > 0 && <button className="session-group-label archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>{showArchived ? '▾' : '▸'} ARCHIVED · {archived.length}</button>}
      {showArchived && archived.length > 0 && <div className="session-group" role="group" aria-label="Archived sessions">{archived.map(row)}</div>}
      {!active.length && !recent.length && !archived.length && <p className="nav-empty">Your sessions will appear here.</p>}
    </nav>
  </>;
}
