// What the sidebar lists and how each row reads (design board B4). Pure: the
// sidebar renders it and tests/sidebar-model.test.mjs checks it.
import { isLive, type Proposal, type Session } from './types';
import { resumable, type SessionState } from './sessionState';
import { copy, shell } from './copy';

export const sessionName = (session: Session) => session.displayName || session.title;
// Recent and Archived: pinned first (in pin order), then newest first.
export const byPin = (a: Session, b: Session) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((a.pinSeq ?? 0) - (b.pinSeq ?? 0)) || b.createdAt.localeCompare(a.createdAt);

export function relativeTime(iso: string | null | undefined, now: number) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// When a session last mattered: its end, else its last activity, else its start.
export const endedTime = (session: Session) => session.endedAt ?? session.lastActivityAt ?? session.createdAt;

export type DayGroup = { key: 'today' | 'yesterday' | 'earlier'; label: string; sessions: Session[] };

// Ended sessions of the current project, by local day. Live and orphaned
// sessions sit in Active; archived and removed ones are not Recent. Pins order
// each day, never across days; empty days are left out.
export function recentGroups(sessions: Session[], projectId: string | null, now: number): DayGroup[] {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const groups: DayGroup[] = [{ key: 'today', label: shell.today, sessions: [] }, { key: 'yesterday', label: shell.yesterday, sessions: [] }, { key: 'earlier', label: shell.earlier, sessions: [] }];
  for (const session of sessions) {
    if (session.removed || session.archived || isLive(session) || session.status === 'orphaned' || session.projectId !== projectId) continue;
    const at = Date.parse(endedTime(session));
    groups[at >= today.getTime() ? 0 : at >= yesterday.getTime() ? 1 : 2].sessions.push(session);
  }
  for (const group of groups) group.sessions.sort(byPin);
  return groups.filter(group => group.sessions.length);
}

// Open suggestions per session (evidence.sessionId); suggestions from no session are not counted.
export function suggestionCounts(proposals: Proposal[]) {
  const counts = new Map<string, number>();
  for (const proposal of proposals) { const id = proposal.evidence?.sessionId; if (id) counts.set(id, (counts.get(id) ?? 0) + 1); }
  return counts;
}

// A row's second line, in order: state word, its detail, the mode (ended
// sessions), suggestions, Can continue, another project's name, the worktree branch.
export function rowDetail(session: Session, state: SessionState, ctx: { suggestions: number; currentProjectId: string | null; projectName: (id: string) => string }): string[] {
  const parts = [state.word];
  if (state.detail) parts.push(state.detail);
  if (!isLive(session) && (session.research || session.plan)) parts.push(session.research ? copy.readOnly : shell.planMode);
  if (ctx.suggestions > 0) parts.push(shell.suggestionCount(ctx.suggestions));
  if (resumable(session)) parts.push(shell.canContinue);
  if (session.projectId !== ctx.currentProjectId) parts.push(ctx.projectName(session.projectId));
  if (session.workspaceId && !session.workspaceId.startsWith('root:')) parts.push(`⑂ ${session.branch ?? 'worktree'}`);
  return parts;
}
