// The session wrap-up (Phase 6, boards 6 and 14): pure decisions behind WrapUp,
// StaleCatchCard and useWrapUp. tests/wrap-up.test.mjs imports this file directly.
// Status and source codes live here, not in the components, so the visible-text
// scan of the .tsx files stays strict.
import { PROVIDER_NAMES, isLive, type FileReference, type Memory, type Mode, type Project, type Proposal, type Provider, type Receipt, type Session, type SessionSummary, type TimelineEvent, type Workspace } from './types';
import { wrapUp } from './copy';

// The core's limit for references per task (src/core/references.mjs MAX_REFERENCES).
export const MAX_REFERENCES = 20;
// Undo window for Still true and Dismiss.
export const UNDO_MS = 10_000;
// How long the suggestions line says "Looking…" after an end without a proposals event.
export const LOOKING_MS = 3_000;

// Every ended session opens on the wrap-up; orphans keep their leftover-process view.
export function endedView(session: Pick<Session, 'status'> | null | undefined): 'wrap-up' | null {
  if (!session || isLive(session as Session)) return null;
  return session.status === 'exited' || session.status === 'stopped' || session.status === 'failed' || session.status === 'interrupted' ? 'wrap-up' : null;
}

// node-pty reports the signal number (a SIGTERM kill is { exitCode: 0, signal: 15 }); 0 or
// none is a normal exit. Common numbers get their POSIX names (the same on macOS and Linux);
// the rest read "signal N". A name (a string) is kept as it is.
const SIGNALS: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 6: 'SIGABRT', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM' };
export function signalName(signal: string | number | null | undefined): string | null {
  if (signal === null || signal === undefined || signal === '' || signal === 0) return null;
  const number = typeof signal === 'number' ? signal : /^\d+$/.test(signal) ? Number(signal) : null;
  if (number === null) return String(signal);
  if (!Number.isInteger(number) || number <= 0) return null;
  return SIGNALS[number] ?? `signal ${number}`;
}

// A non-zero exit, an exit by a signal (its exit code may read 0), or a failed start.
export const isErrorExit = (session: Pick<Session, 'status' | 'exitCode' | 'signal'>) =>
  (session.status === 'exited' && ((session.exitCode ?? null) !== 0 || !!signalName(session.signal))) || session.status === 'failed';

// "<1m", "18m", "1h 5m".
export function durationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 60_000) return '<1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function durationOf(session: Pick<Session, 'createdAt' | 'endedAt'>, summary?: Pick<SessionSummary, 'durationMs'> | null): number | null {
  if (summary && summary.durationMs !== null) return summary.durationMs;
  const start = Date.parse(session.createdAt); const end = session.endedAt ? Date.parse(session.endedAt) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
}

// The wrap-up heading: how the session ended and after how long.
export function exitLine(session: Pick<Session, 'status' | 'exitCode' | 'signal' | 'createdAt' | 'endedAt'>, summary?: Pick<SessionSummary, 'durationMs' | 'exitCode' | 'signal'> | null): string {
  const duration = durationText(durationOf(session, summary));
  switch (session.status) {
    case 'exited': {
      const signal = signalName(summary?.signal ?? session.signal);
      if (signal) return wrapUp.endedBy(signal, duration);
      return wrapUp.exited(summary?.exitCode ?? session.exitCode ?? 0, duration);
    }
    case 'stopped': return wrapUp.stopped(duration);
    case 'interrupted': return wrapUp.interrupted;
    case 'failed': return wrapUp.couldNotStart;
    default: return '';
  }
}

export type IdentityTone = 'ok' | 'quiet' | 'amber';
export interface IdentityLine { text: string; tone: IdentityTone; canContinue: boolean; needsConfirm: boolean }

// What Journal knows about the native conversation ID, and whether Continue may use it.
// Continue needs a confirmed ID without a reported mismatch (exact-ID resume only).
export function identityLine(identity: SessionSummary['identity'], provider: Provider): IdentityLine {
  const t = wrapUp.identity;
  if (identity.mismatch) return { text: t.mismatch, tone: 'amber', canContinue: false, needsConfirm: true };
  if (!identity.nativeId) return { text: t.none, tone: 'quiet', canContinue: false, needsConfirm: provider === 'codex' };
  const confirmed = identity.confirmed;
  if (identity.source === 'exit-banner' && !confirmed) return { text: t.exitBanner, tone: 'amber', canContinue: false, needsConfirm: true };
  const text = identity.source === 'preassigned-observed' ? t.observed : identity.source === 'preassigned' ? t.preassigned
    : identity.source === 'create-chat' ? t.createChat : identity.source === 'user' ? t.user : identity.source === 'hook' ? t.hook : identity.source === 'exit-banner' ? t.exitBanner : t.none;
  if (!confirmed) return { text, tone: 'amber', canContinue: false, needsConfirm: true };
  return { text, tone: identity.source === 'preassigned-observed' || identity.source === 'user' || identity.source === 'hook' ? 'ok' : 'quiet', canContinue: true, needsConfirm: false };
}

// "c7d2…81af"; the full ID goes in a title.
export const shortId = (id: string) => id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;

// The Tests run card: Claude reports test commands; Codex and Cursor do not.
// Failed counts carry the red tone (an error, not "needs you").
export function testsLine(tests: SessionSummary['tests'], provider: Provider): { parts: { text: string; tone: 'red' | null }[]; empty: boolean } {
  if (!tests) return { parts: [{ text: wrapUp.testsHidden(PROVIDER_NAMES[provider]), tone: null }], empty: true };
  const parts: { text: string; tone: 'red' | null }[] = [];
  if (tests.passed) parts.push({ text: wrapUp.passed(tests.passed), tone: null });
  if (tests.failed) parts.push({ text: wrapUp.failed(tests.failed), tone: 'red' });
  if (tests.unknown) parts.push({ text: wrapUp.unknown(tests.unknown), tone: null });
  return parts.length ? { parts, empty: false } : { parts: [{ text: wrapUp.noTests, tone: null }], empty: true };
}

type Copy = Pick<Workspace, 'branch' | 'state'>;
// A branch suggestion can be remembered where some copy has that branch checked out.
export const branchReachable = (branch: string | null | undefined, project: Pick<Project, 'branch'>, workspaces: readonly Copy[]) =>
  !branch || project.branch === branch || workspaces.some(w => w.state === 'ready' && w.branch === branch);

// One-click Remember (D1): the full statement is on screen. Not for branch updates
// (their draft helper), possible conflicts (reviewed in Memory) or a branch no copy has.
export function rememberable(proposal: Pick<Proposal, 'kind' | 'conflicts' | 'scope' | 'branch'>, project: Pick<Project, 'branch'>, workspaces: readonly Copy[]): boolean {
  if (proposal.kind === 'branch-status' || proposal.conflicts?.length) return false;
  return proposal.scope !== 'branch' || branchReachable(proposal.branch, project, workspaces);
}

// Remember all n: shown for 2 to 5 rememberable suggestions (the core's batch limit), else null.
export function rememberAllIds(list: readonly Proposal[], project: Pick<Project, 'branch'>, workspaces: readonly Copy[]): string[] | null {
  const ids = list.filter(p => rememberable(p, project, workspaces)).map(p => p.id);
  return ids.length >= 2 && ids.length <= 5 ? ids : null;
}

// Remember all acts only on suggestions the user has seen: the ids shown in the last
// painted frame (seen) that are still open and rememberable now (current). A suggestion
// that arrives between that frame and the click or ⇧⌘↵ is left out until it has been
// painted once. null when nothing seen is left.
export function rememberAllSeen(seen: readonly string[] | null, current: readonly string[] | null): string[] | null {
  if (!seen || !current) return null;
  const ids = seen.filter(id => current.includes(id));
  return ids.length ? ids : null;
}

// Memory tab actions for a note of another branch (B8): Revise needs the main checkout on
// that branch; Remember works in a ready separate copy on it (the core picks that view).
export function noteActions(note: Pick<Memory, 'scope' | 'branch'>, project: Pick<Project, 'branch'>, workspaces: readonly Copy[]): { revise: boolean; approve: boolean } {
  if (note.scope !== 'branch' || note.branch === project.branch) return { revise: true, approve: true };
  return { revise: false, approve: workspaces.some(w => w.state === 'ready' && w.branch === note.branch) };
}

export interface HandoffPrefill { task: string; references: FileReference[]; provider: Provider; mode: Mode; workspaceId: string }

// The New session composer, filled from an ended session (D12). Only the task, its
// references, the mode and the workspace travel; notes are selected again at launch
// from remembered ones. The mode is never raised; a removed workspace falls back to the checkout.
export function handoffPrefill(session: Pick<Session, 'research' | 'plan' | 'workspaceId' | 'projectId'>, receipt: Pick<Receipt, 'query' | 'references'> | null, referenceEvents: readonly TimelineEvent[],
  provider: Provider, workspaces: readonly Pick<Workspace, 'id' | 'state'>[], roots: readonly { id: string }[] = []): HandoffPrefill {
  const seen = new Set<string>(); const references: FileReference[] = [];
  const add = (ref: Partial<FileReference> | Record<string, unknown>) => {
    const kind = ref.kind === 'lines' || ref.kind === 'folder' ? ref.kind : 'file';
    const rootKey = typeof ref.rootKey === 'string' ? ref.rootKey : ''; const path = typeof ref.path === 'string' ? ref.path : '';
    if (!rootKey || !path) return;
    const line = (value: unknown) => Number.isInteger(value) && (value as number) > 0 ? value as number : null;
    const startLine = line(ref.startLine); const endLine = line(ref.endLine) ?? startLine;
    const key = `${rootKey}\u0000${path}\u0000${startLine ?? ''}-${endLine ?? ''}`;
    if (seen.has(key) || references.length >= MAX_REFERENCES) return; seen.add(key);
    references.push({ projectId: session.projectId, kind, rootKey, ...(typeof ref.rootLabel === 'string' && ref.rootLabel ? { rootLabel: ref.rootLabel } : {}), path, startLine, endLine });
  };
  for (const ref of receipt?.references ?? []) add(ref);
  for (const event of referenceEvents) if (event.kind === 'reference' && event.body.delivery === 'inserted') add(event.body);
  const mode: Mode = session.research ? 'read-only' : session.plan ? 'plan' : 'build';
  const id = session.workspaceId ?? '';
  const exists = id.startsWith('root:') ? roots.some(root => `root:${root.id}` === id) : workspaces.some(w => w.id === id && w.state === 'ready');
  return { task: receipt?.query ?? '', references, provider, mode, workspaceId: id && exists ? id : '' };
}

// Staged commits with Undo: a staged commit runs after delayMs, at once on flushAll()
// (leaving the view), or never after undo(). Quitting inside the window drops it, which
// is safe: nothing changed, and the wrap-up shows the same choice again.
export function createStagedActions({ delayMs = UNDO_MS, setTimeout: set = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout }: {
  delayMs?: number; setTimeout?: (callback: () => void, ms: number) => unknown; clearTimeout?: (handle: never) => void } = {}) {
  const staged = new Map<string, { handle: unknown; commit: () => void }>();
  const run = (key: string) => { const entry = staged.get(key); if (!entry) return; clear(entry.handle as never); staged.delete(key); entry.commit(); };
  return {
    stage(key: string, commit: () => void) { if (staged.has(key)) return; staged.set(key, { commit, handle: set(() => run(key), delayMs) }); },
    undo(key: string) { const entry = staged.get(key); if (!entry) return false; clear(entry.handle as never); staged.delete(key); return true; },
    flushAll() { for (const key of [...staged.keys()]) run(key); },
    pending: (key: string) => staged.has(key),
  };
}
export type StagedActions = ReturnType<typeof createStagedActions>;

// Lines a range row may cite: 1 to 30, like the note form.
export const MAX_RANGE = 30;
export function validRange(startLine: number, endLine: number) {
  return Number.isInteger(startLine) && Number.isInteger(endLine) && startLine >= 1 && endLine >= startLine && endLine - startLine < MAX_RANGE;
}

// "+1 −1" for a stale note's diff (hunks), counted on the lines shown.
export function hunkCounts(hunks: { lines: { kind: string }[] }[] | null): { added: number; removed: number } {
  let added = 0; let removed = 0;
  for (const hunk of hunks ?? []) for (const line of hunk.lines) { if (line.kind === '+') added++; else if (line.kind === '-') removed++; }
  return { added, removed };
}

// Platform key labels: nothing here is Apple-only.
export const keyLabels = (mac: boolean) => ({
  continue: mac ? '⌘↵' : 'Ctrl+Enter', continueAria: mac ? 'Meta+Enter' : 'Control+Enter',
  rememberAll: mac ? '⇧⌘↵' : 'Ctrl+Shift+Enter', rememberAllAria: mac ? 'Shift+Meta+Enter' : 'Control+Shift+Enter',
});

// Explainer storage key; every access is wrapped by the caller.
export const SEEN_SUGGESTIONS = 'journal-seen-suggestions';
