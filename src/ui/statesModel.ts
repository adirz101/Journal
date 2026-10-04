// Failure states (Phase 8, board 9): why an agent can't start, and what the crash
// recovery panel offers. Pure: StartError.tsx and RecoveryPanel.tsx render them and
// tests/states.test.mjs checks them. Each state is one honest sentence and one next step.
import { errorCode, isLive, type AgentInfo, type Provider, type Recovery, type Session } from './types';
import { resumable } from './sessionState';

export type StartProblem =
  | { kind: 'signed-out'; provider: Provider; command: string | null }
  | { kind: 'missing'; provider: Provider; command: string | null }
  | { kind: 'unsupported'; provider: Provider; detail: string }
  | { kind: 'failed'; provider: Provider; detail: string };

// Refusals that keep their own path (the reason beside Start, a banner or a session's header).
const OWN_PATH = new Set(['SLOTS_FULL', 'SHUTTING_DOWN', 'CONVERSATION_OPEN', 'ORPHAN_RUNNING', 'ID_UNCONFIRMED', 'NOT_LIVE']);
const message = (error: unknown) => error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error);
const codeOf = (error: unknown) => errorCode(error) ?? (typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : null);

// A thrown start error wins over the agent's state. Signed out is claimed only from what the
// agent's own status check reported (Phase 7 auth, Cursor's login-required), never from
// "unknown". The commands are display strings from main's constant table; the renderer never
// builds argv. An error without a known code is not a start problem (the app banner shows it).
export function startProblem({ provider, agent, error }: { provider: Provider; agent: AgentInfo | undefined; error: unknown | null }): StartProblem | null {
  if (error) {
    const code = codeOf(error);
    if (!code || OWN_PATH.has(code)) return null;
    if (code === 'PROVIDER_MISSING') return { kind: 'missing', provider, command: agent?.commands?.install ?? null };
    if (code === 'PROVIDER_UNSUPPORTED') return { kind: 'unsupported', provider, detail: message(error) };
    if (code === 'START_FAILED') return { kind: 'failed', provider, detail: message(error) };
    return null;
  }
  if (!agent || agent.state === 'checking') return null;
  if (agent.auth === 'signed-out' || agent.state === 'login-required') return { kind: 'signed-out', provider, command: agent.commands?.login ?? null };
  if (agent.state === 'unsupported') return { kind: 'unsupported', provider, detail: '' };
  if (!agent.available || agent.state === 'missing') return { kind: 'missing', provider, command: agent.commands?.install ?? null };
  return null;
}

export type RecoveryAction = 'continue' | 'needs-id' | 'running' | 'gone';
export interface RecoveryRow { session: Session; action: RecoveryAction; reason: string | null }
export interface RecoveryView { rows: RecoveryRow[]; interrupted: number; leftovers: Session[]; allResumable: boolean }

// What each recovered session offers now (its current row: it may have moved from orphaned
// to interrupted since the hello). blocked: why Start is unavailable (all slots in use, the
// runtime reconnecting), shown on Continue. A session that was continued, removed or archived
// is gone. null once nothing is left to act on: the panel then closes and acknowledges.
export function recoveryView(recovery: Recovery | null, sessions: Record<string, Session>, blocked: string | null): RecoveryView | null {
  if (!recovery) return null;
  const all = Object.values(sessions);
  const rows: RecoveryRow[] = []; const leftovers: Session[] = [];
  for (const entry of recovery.sessions) {
    const known = sessions[entry.id];
    if (!known) continue;
    // A row still live here is older than the hello (its status event has not arrived yet):
    // the runtime recovered it, so it takes the recovered status.
    const session = isLive(known) ? { ...known, status: entry.status } : known;
    const continued = all.some(other => other.resumedFrom === session.id);
    if (session.status === 'orphaned' || session.survivors?.length) leftovers.push(session);
    const action: RecoveryAction = session.removed || session.archived || continued ? 'gone'
      : session.status === 'orphaned' ? 'running' : resumable(session) ? 'continue' : session.status === 'interrupted' ? 'needs-id' : 'gone';
    rows.push({ session, action, reason: action === 'continue' ? blocked : null });
  }
  if (!rows.some(row => row.action !== 'gone')) return null;
  const open = rows.filter(row => row.action !== 'gone');
  return { rows: open, interrupted: recovery.total ?? recovery.sessions.length, leftovers: leftovers.filter(s => !s.removed), allResumable: open.every(row => row.action === 'continue') };
}
