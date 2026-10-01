export type Provider = 'claude' | 'codex';
export interface Project { id: string; name: string; root: string; branch: string | null; head: string | null; }
export interface Source { kind: 'user' | 'file' | 'git'; note?: string; path?: string; startLine?: number; endLine?: number; excerpt?: string; contentHash?: string; base?: string | null; head?: string; commitCount?: number | null; }
export interface Memory { id: string; projectId: string; revisionId: string; revision: number; statement: string; category: string; scope: 'checkout' | 'branch'; area: string; branch: string | null; source: Source; status: 'candidate' | 'active' | 'rejected' | 'archived'; validation: 'current' | 'stale' | 'wrong-branch'; drift?: number | null; }
export interface Receipt { id: string; packet: string; launchPrompt?: string; query: string; items: Memory[]; excluded: { id: string; reason: string }[]; warnings?: string[]; state: string; estimatedTokens: number; createdAt: string; }
export interface Session { id: string; projectId: string; provider: Provider; nativeId: string | null; nativeIdConfirmed: boolean; title: string; status: string; receiptId: string; createdAt: string; }
export type TerminalEvent = { type: 'output'; sessionId: string; sequence: number; data: string } | { type: 'gap'; sessionId: string } | { type: 'status'; session: Session } | { type: 'error'; message: string };
export interface OutputSnapshot { gap: boolean; chunks: { sequence: number; data: string }[]; lastSequence: number; }
export interface StatusDraft { scope: 'checkout' | 'branch'; memoryId: string | null; previousRevision: number | null; previousStatement: string | null; statement: string; source: { kind: 'git'; base: string | null };
  basis: { label: string; base: string | null; head: string; commitCount?: number; changedFiles?: number; uncommitted?: number; carried?: string[]; structureChanges?: string[]; unchanged?: boolean; notes: string[] }; }
export interface ProjectState { project: Project; memories: Memory[]; sessions: Session[]; receipts: Receipt[]; }
export interface Bootstrap { projects: Project[]; agents: { provider: Provider; available: boolean; version: string | null }[]; activeSession: Session | null; platform: string; }
declare global {
  interface Window { journal?: { request: (action: string, input?: object) => Promise<unknown>; onEvent: (callback: (event: TerminalEvent) => void) => () => void }; }
}
export async function api<T>(action: string, input: object = {}): Promise<T> {
  if (!window.journal) throw new Error('Open Journal as a desktop app with npm run dev');
  return await window.journal.request(action, input) as T;
}
