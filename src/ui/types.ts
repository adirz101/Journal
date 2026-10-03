export type Provider = 'claude' | 'codex';
export interface ProjectRoot { id: string; path: string; name: string; kind: 'git' | 'folder'; nested: boolean; gitRoot: string | null; branch: string | null; exists?: boolean; currentBranch?: string | null; knowledge?: number; }
export interface Project { id: string; name: string; root: string; branch: string | null; head: string | null; displayName?: string | null; folderName?: string; pinned?: boolean; roots?: ProjectRoot[]; }
export interface ProjectDetails { missing?: boolean; project: Project; roots: ProjectRoot[]; counts: { knowledge: number; sessions: number; liveSessions: number; receipts: number; events: number; proposals: number; worktrees: number }; }
export interface Source { rootId?: string; kind: 'user' | 'file' | 'git' | 'import'; note?: string; path?: string; startLine?: number; endLine?: number; excerpt?: string; contentHash?: string; base?: string | null; head?: string; commitCount?: number | null; }
export interface Conflict { id: string; revision: number; statement: string; }
export interface Memory { pinned?: boolean; environment?: string; selection?: { reason: string; bytes: number }; promotedFrom?: { id: string; revision: number; branch: string }; supersedes?: { id: string; revision: number }; id: string; projectId: string; revisionId: string; revision: number; statement: string; category: string; scope: 'checkout' | 'branch'; area: string; branch: string | null; source: Source; status: 'candidate' | 'active' | 'rejected' | 'archived'; validation: 'current' | 'stale' | 'wrong-branch' | 'folder-removed'; drift?: number | null; conflicts?: Conflict[]; }
export interface MemoryPage { items: Memory[]; total: number; offset: number; limit: number; counts: Record<string, number>; }
export interface Receipt { disabled?: string[]; workspaceId?: string | null; sessionId?: string; id: string; packet: string; launchPrompt?: string; query: string; items: Memory[]; excluded: { id: string; reason: string }[]; warnings?: string[]; state: string; estimatedTokens: number; createdAt: string; }
export type SessionStatus = 'starting' | 'running' | 'waiting' | 'stopping' | 'stopped' | 'exited' | 'failed' | 'interrupted' | 'orphaned';
export interface Survivor { pid: number; started: string; command: string; }
export interface Session { id: string; projectId: string; provider: Provider; nativeId: string | null; nativeIdConfirmed: boolean; title: string; status: SessionStatus; receiptId: string; createdAt: string;
  lastActivityAt?: string; endedAt?: string | null; exitCode?: number | null; branch?: string | null; head?: string | null; activity?: 'idle' | 'working' | 'permission' | null; archived?: boolean; survivors?: Survivor[] | null; resumedFrom?: string | null; version?: number; workspaceId?: string | null; research?: boolean; cwd?: string; identityVerified?: boolean; }
export interface TimelineEvent { id?: number; sessionId?: string; at: string; kind: string; body: Record<string, unknown>; }
export type TerminalEvent = { type: 'output'; sessionId: string; sequence: number; data: string } | { type: 'gap'; sessionId: string } | { type: 'status'; session: Session } | { type: 'error'; message: string; sessionId?: string }
  | { type: 'timeline'; event: TimelineEvent } | { type: 'proposals'; projectId: string; count: number } | { type: 'runtime'; state: 'connected' | 'disconnected' | 'connecting'; warning?: string; recovered?: boolean };
export interface OutputSnapshot { gap: boolean; chunks: { sequence: number; data: string }[]; lastSequence: number; }
export interface Workspace { id: string | null; projectId?: string; kind: 'checkout' | 'managed' | 'imported'; path: string; branch: string | null; head?: string | null; base?: string; baseLabel?: string; state: 'intent' | 'ready' | 'failed' | 'missing' | 'removed'; error?: string | null; notices?: string[]; detached?: boolean; }
export interface WorkspaceList { checkout: Workspace; workspaces: Workspace[]; importable: { path: string; branch: string | null; head: string | null; detached: boolean }[]; }
export interface Proposal { id: string; kind: 'rule' | 'test-command' | 'branch-status'; category: string; statement: string; scope: string; branch?: string | null; state: string; createdAt: string; source: Source | null; }
export interface ProjectState { project: Project; sessions: Session[]; receipts: Receipt[]; }
export interface ChangedFile { path: string; from: string | null; additions: number | null; deletions: number | null; binary: boolean; untracked: boolean; preexisting: boolean; sensitive: boolean; }
export interface Changes { base: string; available: boolean; reason?: string; head?: string; branch?: string; headMoved?: boolean; commitsSince?: number; files: ChangedFile[]; truncated?: boolean; additions?: number; deletions?: number; preexistingCount?: number; }
export interface Bootstrap { projects: Project[]; agents: { provider: Provider; available: boolean; version: string | null; path?: string | null; capabilities?: { exactResume: string; status: string[]; commands: string; fileEdits: boolean } }[]; platform: string; runtime: { state: 'connected' | 'disconnected' | 'connecting'; warning: string | null }; live: Session[]; active: Session[]; }
export interface StatusDraft { scope: 'checkout' | 'branch'; memoryId: string | null; previousRevision: number | null; previousStatement: string | null; statement: string; source: { kind: 'git'; base: string | null };
  basis: { label: string; base: string | null; head: string; commitCount?: number; changedFiles?: number; uncommitted?: number; carried?: string[]; structureChanges?: string[]; unchanged?: boolean; notes: string[] }; }
declare global {
  interface Window { journal?: { request: (action: string, input?: object) => Promise<unknown>; onEvent: (callback: (event: TerminalEvent) => void) => () => void }; }
}
// Knowledge writes still in flight. A launch or context preview waits for
// them, so what the agent receives always includes what the user just did
// (the runtime reads the database from another process).
// Only writes that change what a packet contains, and none that wait on a dialog.
const KNOWLEDGE_WRITES = new Set(['proposeMemory', 'setMemoryStatus', 'setPinned', 'markIncorrect', 'proposePromotion', 'acceptProposal']);
const READS_KNOWLEDGE = new Set(['start', 'prepareContext']);
const pendingWrites = new Set<Promise<unknown>>();
export async function api<T>(action: string, input: object = {}): Promise<T> {
  if (!window.journal) throw new Error('Open Journal as a desktop app with npm run dev');
  // Bounded: a stuck write never blocks launches for more than 10 s.
  if (READS_KNOWLEDGE.has(action) && pendingWrites.size) await Promise.race([Promise.allSettled([...pendingWrites]), new Promise(resolve => setTimeout(resolve, 10000))]);
  const request = window.journal.request(action, input);
  if (KNOWLEDGE_WRITES.has(action)) { pendingWrites.add(request); void request.finally(() => pendingWrites.delete(request)).catch(() => {}); }
  return await request as T;
}
export const LIVE_STATUSES: SessionStatus[] = ['starting', 'running', 'waiting', 'stopping'];
export const isLive = (session: Session | null | undefined) => !!session && LIVE_STATUSES.includes(session.status);
