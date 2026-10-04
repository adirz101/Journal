import { useState } from 'react';
import { isLive, PROVIDER_NAMES, type Bootstrap, type CommandId, type Pane, type Project, type Proposal, type Session, type UpdateState } from './types';
import { needsYou, slotOrder, stateFor, type SessionState } from './sessionState';
import { byPin, endedTime, recentGroups, relativeTime, rowDetail, sessionName, suggestionCounts } from './sidebarModel';
import { copy, shell, tip } from './copy';
import { menuPosition } from './menu';
import { ProviderMark } from './ProviderMark';
import { UpdateNotice } from './UpdateNotice';
import type { Appearance } from './theme';
import journalMarkWhite from '../../assets/branding/journal-mark-white.png';
import journalMarkDark from '../../assets/branding/journal-mark.png';

type Point = { x: number; y: number };
type Keys = Bootstrap['shortcuts'] | undefined;

// The accessible name every session row and rail tile shares (Phase 2 format).
const describe = (session: Session, state: SessionState, attention: boolean) =>
  `${PROVIDER_NAMES[session.provider]}: ${sessionName(session)}. ${state.word}${state.detail ? `, ${state.detail}` : ''}${state.limited ? `, ${copy.state.limited}` : ''}${session.pinned ? ', pinned' : ''}${attention ? ', needs attention' : ''}`;
const slotKeys = (session: Session, shortcuts: Keys) => isLive(session) && session.slot ? shortcuts?.[`slot-${session.slot}` as CommandId] : undefined;
const pointAt = (element: HTMLElement): Point => { const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.bottom }; };
const withKeys = (label: string, keys?: { label: string }) => keys ? `${label} (${keys.label})` : label;

// Rail icons: inline, decorative (every rail button has its own accessible name).
const Icon = ({ d, size = 18 }: { d: string; size?: number }) => <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={d} /></svg>;
const ICONS = { plus: 'M12 5v14M5 12h14', recent: 'M12 7v5l3 2M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z', memory: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3ZM5 17a3 3 0 0 1 3-3h11', expand: 'm9 6 6 6-6 6', updown: 'm8 9 4-4 4 4M8 15l4 4 4-4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z' };
// The last two folders of a path, so the project's own folder stays readable in a narrow sidebar (the full path is the tooltip).
const shortPath = (path: string) => { const parts = path.split(/[\\/]/).filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path; };

// inOverlay: the full sidebar shown over a narrow window (the rail keeps the ID).
// canCompose: a project is open, so the New session view can be shown (even with
// all slots in use: the user can write the task while Start explains why it waits).
// update: shown in the footer; the caller passes null while the session view's status bar shows it.
export function Sidebar({ pane, inOverlay = false, projects, project, sessions, proposals, selectedId, connected, runtimeState, now, canCompose, shortcuts, appearance, update,
  onSelect, onSessionMenu, onNew, onSwitchProject, onProjectMenu, onOpenMemory, onOpenSettings, onExpand, onShowRecent, onError }: {
  pane: Pane; inOverlay?: boolean; projects: Project[]; project: Project | null; sessions: Session[]; proposals: Proposal[];
  selectedId: string | null; connected: boolean; runtimeState: 'connected' | 'connecting' | 'disconnected'; now: number; canCompose: boolean;
  shortcuts: Keys; appearance: Appearance; update: UpdateState | null;
  onSelect(session: Session): void; onSessionMenu(session: Session, at?: Point): void; onNew(): void;
  onSwitchProject(at?: Point): void; onProjectMenu(at?: Point): void; onOpenMemory(): void; onOpenSettings(): void;
  onExpand?(): void; onShowRecent?(): void; onError(error: unknown): void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const mark = appearance === 'light' ? journalMarkDark : journalMarkWhite;
  const visible = sessions.filter(s => !s.removed);
  // Active: running sessions from every project, archived or not, in the order of their stable slots.
  const active = slotOrder(visible);
  const projectId = project?.id ?? null;
  const groups = recentGroups(visible, projectId, now);
  const archived = visible.filter(s => s.archived && !active.includes(s) && s.projectId === projectId).sort(byPin);
  const suggestions = suggestionCounts(proposals);
  const projectName = (id: string) => projects.find(p => p.id === id)?.name ?? 'Unknown project';
  const used = visible.filter(isLive).length;
  const switcherName = project ? shell.switchProject(project.name) : shell.noProject;
  const switchProject = (element: HTMLElement) => onSwitchProject(pointAt(element));
  const hasMenu = projects.length > 0 ? 'menu' : undefined;
  const memoryName = proposals.length ? `${copy.memory}, ${shell.suggestionCount(proposals.length)}` : copy.memory;

  const row = (session: Session) => {
    const state = stateFor(session, now, connected); const attention = needsYou(session) || state.tone === 'attention';
    const slot = slotKeys(session, shortcuts); const selected = session.id === selectedId;
    const [word, ...rest] = rowDetail(session, state, { suggestions: suggestions.get(session.id) ?? 0, currentProjectId: projectId, projectName });
    return <button key={session.id} className={`session-select${selected ? ' selected' : ''}${attention ? ' attention' : ''}`} aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(session)} onContextMenu={event => { event.preventDefault(); onSessionMenu(session, menuPosition(event)); }}
      aria-keyshortcuts={slot?.aria} aria-label={describe(session, state, attention)} title={state.limited ? tip.limitedStatus : undefined}>
      <ProviderMark provider={session.provider} size={20} />
      <span className="session-title">{sessionName(session)}{session.pinned && <span className="pin-mark" aria-hidden="true"> ⚲</span>}{session.archived && <span className="badge archived-badge">archived</span>}</span>
      {slot ? <kbd className="session-trail" aria-hidden="true">{slot.label}</kbd>
        : <time className="session-trail" dateTime={isLive(session) ? session.createdAt : endedTime(session)} title={isLive(session) ? 'Elapsed' : 'Ended'}>{relativeTime(isLive(session) ? session.createdAt : endedTime(session), now)}</time>}
      <span className="session-line"><span className={`session-status tone-${state.tone}`} title={state.limited ? tip.limitedStatus : undefined}>{word}</span>{rest.map(part => <span key={part}> · {part}</span>)}</span>
    </button>;
  };

  if (pane === 'rail') {
    return <aside className="sidebar sidebar-rail" id="project-sidebar" aria-label="Sidebar">
      <button className="rail-tile rail-project" aria-label={switcherName} aria-haspopup={hasMenu} title={project?.name ?? shell.noProject}
        onClick={event => switchProject(event.currentTarget)} onContextMenu={event => { if (!project) return; event.preventDefault(); onProjectMenu(menuPosition(event)); }}>
        <img className="brand-icon" src={mark} alt="" width={26} height={26} /></button>
      <button className="rail-tile" aria-label={withKeys(shell.newSession, shortcuts?.['new-session'])} title={withKeys(shell.newSession, shortcuts?.['new-session'])} aria-keyshortcuts={shortcuts?.['new-session']?.aria} disabled={!canCompose} onClick={onNew}><Icon d={ICONS.plus} /></button>
      <span className="rsep" aria-hidden="true" />
      {active.filter(s => isLive(s) && s.slot).map(session => {
        const state = stateFor(session, now, connected); const attention = needsYou(session) || state.tone === 'attention'; const slot = slotKeys(session, shortcuts);
        return <button key={session.id} className={`rail-tile${attention ? ' attention' : ''}`} aria-current={session.id === selectedId ? 'true' : undefined} aria-keyshortcuts={slot?.aria}
          aria-label={`Slot ${session.slot}, ${PROVIDER_NAMES[session.provider]}: ${sessionName(session)}. ${state.word}${state.detail ? `, ${state.detail}` : ''}`}
          title={`${slot ? `${slot.label} · ` : ''}${sessionName(session)} · ${state.word}`}
          onClick={() => onSelect(session)} onContextMenu={event => { event.preventDefault(); onSessionMenu(session, menuPosition(event)); }}>
          <ProviderMark provider={session.provider} size={26} /><span className={`sd tone-${state.tone}`} aria-hidden="true" /></button>;
      })}
      <span className="rsep" aria-hidden="true" />
      <button className="rail-tile" aria-label={shell.recentSessions} title={shell.recentSessions} onClick={onShowRecent} disabled={!onShowRecent}><Icon d={ICONS.recent} /></button>
      <span className="rail-spacer" />
      {project && <button className="rail-tile" aria-label={memoryName} title={memoryName} onClick={onOpenMemory}><Icon d={ICONS.memory} />{proposals.length > 0 && <span className="badge count-badge" aria-hidden="true">{proposals.length}</span>}</button>}
      <button className="rail-tile" aria-label={shell.expandSidebar} title={withKeys(shell.expandSidebar, shortcuts?.['toggle-sidebar'])} aria-keyshortcuts={shortcuts?.['toggle-sidebar']?.aria} onClick={onExpand} disabled={!onExpand}><Icon d={ICONS.expand} /></button>
    </aside>;
  }

  return <aside className="sidebar" id={inOverlay ? undefined : 'project-sidebar'} aria-label="Sidebar">
    <button className="project-switcher" aria-label={switcherName} aria-haspopup={hasMenu} title={project?.root}
      onClick={event => switchProject(event.currentTarget)} onContextMenu={event => { if (!project) return; event.preventDefault(); onProjectMenu(menuPosition(event)); }}>
      <img className="brand-icon" src={mark} alt="" width={32} height={32} />
      <span className="project-switcher-text"><span className="project-name">{project?.name ?? shell.noProject}</span>
        {project && <span className="project-sub"><span className="project-path">{shortPath(project.root)}</span><span className="branch-badge">⑂ {project.branch ?? 'detached HEAD'}</span></span>}</span>
      <span className="switcher-chevron" aria-hidden="true"><Icon d={ICONS.updown} size={16} /></span>
    </button>
    <button className="new-session" onClick={onNew} disabled={!canCompose} aria-keyshortcuts={shortcuts?.['new-session']?.aria} title={withKeys(shell.newSession, shortcuts?.['new-session'])}>
      <span aria-hidden="true">＋</span> {shell.newSession}{shortcuts?.['new-session'] && <kbd aria-hidden="true">{shortcuts['new-session'].label}</kbd>}</button>
    <nav aria-label="Sessions" className="session-nav">
      <div className="side-heading"><span>{shell.active}</span><span className="slots-used">{shell.slotsUsed(used)}<span className="slot-meter" aria-hidden="true">{[1, 2, 3, 4].map(n => <span key={n} className={n <= used ? 'on' : ''} />)}</span></span></div>
      {active.length > 0 && <div className="session-group" role="group" aria-label="Active sessions">{active.map(row)}</div>}
      {groups.length > 0 && <div id="sidebar-recent" className="side-heading"><span>{shell.recent}</span></div>}
      {groups.map(group => <div key={group.key} className="day" role="group" aria-label={group.label}><div className="day-label" aria-hidden="true">{group.label}</div>{group.sessions.map(row)}</div>)}
      {archived.length > 0 && <button className="side-heading archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}><span aria-hidden="true">{showArchived ? '▾' : '▸'}</span> {shell.archived} · {archived.length}</button>}
      {showArchived && archived.length > 0 && <div className="session-group" role="group" aria-label="Archived sessions">{archived.map(row)}</div>}
      {!active.length && !groups.length && !archived.length && <p className="nav-empty">Your sessions will appear here.</p>}
    </nav>
    <div className="sidebar-footer">
      <UpdateNotice state={update} onError={onError} />
      {project && <button className="footer-button" onClick={onOpenMemory} aria-label={memoryName}><Icon d={ICONS.memory} size={16} /><span>{copy.memory}</span>{proposals.length > 0 && <span className="badge count-badge" aria-hidden="true">{proposals.length}</span>}</button>}
      <button className="footer-button" onClick={onOpenSettings} aria-keyshortcuts={shortcuts?.settings?.aria} title={withKeys(shell.settings, shortcuts?.settings)}><Icon d={ICONS.settings} size={16} /><span>{shell.settings}</span></button>
      <p className="runtime-line"><span className={`status-dot ${connected ? 'running' : 'waiting'}`} aria-hidden="true" />{connected ? shell.runtimeConnected : runtimeState === 'connecting' ? shell.runtimeStarting : shell.runtimeDisconnected}</p>
    </div>
  </aside>;
}
