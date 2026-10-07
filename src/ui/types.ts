export type Provider = 'claude' | 'codex' | 'cursor';
// Commands the main process sends for app shortcuts (src/desktop/shortcuts.mjs).
export type CommandId = 'new-session' | 'open-project' | 'add-note' | 'focus-terminal' | 'toggle-inspector' | 'slot-1' | 'slot-2' | 'slot-3' | 'slot-4' | 'next-needs-you' | 'tab-session' | 'tab-files' | 'tab-memory' | 'settings' | 'toggle-sidebar' | 'command-palette' | 'open-file';
// Phase 3 shell: the inspector's three tabs, and whether a sidebar or inspector renders in full or as a rail.
export type InspectorTab = 'session' | 'files' | 'memory';
export type Pane = 'full' | 'rail';
// userData/preferences.json (src/desktop/notify.mjs PREFERENCE_DEFAULTS).
export interface Preferences { notifications: boolean; notificationCommand: boolean; coordinatedRuns: boolean; }
export const PROVIDER_NAMES: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
export interface ProjectRoot { id: string; path: string; name: string; kind: 'git' | 'folder'; nested: boolean; gitRoot: string | null; branch: string | null; exists?: boolean; currentBranch?: string | null; knowledge?: number; }
export interface Project { id: string; name: string; root: string; branch: string | null; head: string | null; displayName?: string | null; folderName?: string; pinned?: boolean; roots?: ProjectRoot[]; }
export interface ProjectDetails { missing?: boolean; project: Project; roots: ProjectRoot[]; counts: { knowledge: number; sessions: number; liveSessions: number; receipts: number; events: number; proposals: number; worktrees: number }; }
export interface Source { rootId?: string; kind: 'user' | 'file' | 'git' | 'import'; note?: string; path?: string; startLine?: number; endLine?: number; excerpt?: string; contentHash?: string; base?: string | null; head?: string; commitCount?: number | null; }
export interface Conflict { id: string; revision: number; statement: string; }
// origin: a note proposed from a session, with its isolated environment when there was one; applied is computed now.
export interface MemoryOrigin { sessionId: string; environmentId?: string; logicalBranch?: string; base?: string; result?: string | null; applied?: boolean; environmentState?: string }
export interface Memory { pinned?: boolean; environment?: string; origin?: MemoryOrigin; selection?: SelectionInfo; promotedFrom?: { id: string; revision: number; branch: string }; supersedes?: { id: string; revision: number }; id: string; projectId: string; revisionId: string; revision: number; statement: string; category: string; scope: 'checkout' | 'branch'; area: string; branch: string | null; source: Source; status: 'candidate' | 'active' | 'rejected' | 'archived'; validation: 'current' | 'stale' | 'wrong-branch' | 'folder-removed'; drift?: number | null; conflicts?: Conflict[]; }
// Composer modes: the launch flags stay plan/research (Phase 4).
export type Mode = 'build' | 'plan' | 'read-only' | 'coordinate';
// Why a note was selected. terms: the searched terms FTS matched (receipts from Phase 4 on). The
// searched terms come from the task text and the referenced paths, so a term may be a path word
// ("billing" from src/billing) that does not appear in the task; underline only the spans found in the task.
export interface SelectionInfo { reason: string; bytes: number; terms?: string[]; }
// The typing preview (previewSelection): stored records only, nothing validated or written.
export interface SelectionPreview {
  kind: 'selection'; checked: false; query: string; branch: string | null;
  items: (Memory & { selection: SelectionInfo })[];   // same order and rules as a receipt
  excluded: { id: string; reason: string }[];          // never 'stale': evidence is not read
  warnings: string[]; bytes: number;                   // packet bytes before references and drift text
  terms: string[];                                     // queryTerms(task + reference paths)
  taskNotes: number;                                   // remembered non-brief notes on this branch or all branches
}
// categoryCounts: per category under the other filters (not the category one); otherBranch: notes of other branches (Phase 5).
export interface MemoryPage { items: Memory[]; total: number; offset: number; limit: number; counts: Record<string, number>; categoryCounts?: Record<string, number>; otherBranch?: number; }
// Where a note came from (memoryOrigins, src/core/insights.mjs). createdAt: revision 1. A session's
// id and title are set only while it is present; a removed or purged session keeps its provider and date.
export interface MemoryOrigin {
  kind: 'session' | 'manual' | 'git' | 'import' | 'promoted';
  createdAt: string; approvedAt: string | null; approvedRevision: number | null;
  session?: { id: string | null; title: string | null; provider: string | null; date: string | null; state: 'present' | 'removed' | 'purged' };
  git?: { base: string | null; head: string };
  promotedFrom?: { branch: string };
}
// A note card's trust lines. undefined = still loading (the line renders nothing); null = unavailable.
// sent: distinct conversations the note was sent to (deliveryCounts, decision D6).
export interface NoteTrust { origin?: MemoryOrigin | null; sent?: number | null }
export interface Receipt { terms?: string[]; preview?: boolean; references?: FileReference[]; disabled?: string[]; workspaceId?: string | null; sessionId?: string; id: string; packet: string; launchPrompt?: string; query: string; items: Memory[]; excluded: { id: string; reason: string }[]; warnings?: string[]; state: string; estimatedTokens: number; createdAt: string; }
export type SessionStatus = 'starting' | 'running' | 'waiting' | 'stopping' | 'stopped' | 'exited' | 'failed' | 'interrupted' | 'orphaned';
export interface Survivor { pid: number; started: string; command: string; }
export interface Session { id: string; projectId: string; provider: Provider; nativeId: string | null; nativeIdConfirmed: boolean; title: string; status: SessionStatus; receiptId: string; createdAt: string;
  role?: 'coordinator' | 'worker'; runId?: string; attemptId?: string | null; launchId?: string; turnId?: string | null; inputOwner?: 'automation' | 'human' | 'uncertain';
  lastActivityAt?: string; endedAt?: string | null; exitCode?: number | null; branch?: string | null; head?: string | null; activity?: 'idle' | 'working' | 'permission' | null; archived?: boolean; survivors?: Survivor[] | null; resumedFrom?: string | null; displayName?: string | null; pinned?: boolean; pinSeq?: number | null; removed?: boolean; version?: number; workspaceId?: string | null; environmentId?: string | null; research?: boolean; plan?: boolean; cwd?: string; identityVerified?: boolean;
  // Runtime protocol 4 (src/core/terminal.mjs). slot: a positive stable number while live in this runtime, kept until it ends.
  // lastOutputAt: last PTY output, excluding echo and resize repaints. pending: what an open Claude prompt asks.
  slot?: number | null; lastOutputAt?: string | null; pending?: PendingApproval | null;
  // The CLI version main detected when this session launched (Phase 3 B); missing for older sessions.
  cliVersion?: string | null;
  nativeIdSource?: 'preassigned' | 'preassigned-observed' | 'create-chat' | 'exit-banner' | 'hook' | 'user' | null; identityMismatch?: boolean;
  // What Journal observes of this launch (src/core/terminal.mjs OBSERVATIONS): a state is current only while 'live'.
  // lastObserved: the last applied hook fact, shown as past evidence; children: sub-agents seen (bounded). Missing from older runtimes.
  observation?: Observation; lastObserved?: LastObserved | null; children?: number;
  // What this launch's hooks can report: turn end and approval waits (null: not observed).
  observes?: { turns: boolean; approvals: boolean } | null;
  // Phase 6: the end snapshot (taken once by the runtime when the session exits) and how it ended.
  changeStats?: ChangeStats | null; signal?: string | number | null; }
export type Observation = 'pending' | 'live' | 'unobserved' | 'lost';
export type ObservedFact = 'session-start' | 'turn-start' | 'turn-progress' | 'tool-start' | 'tool-end' | 'permission-wait' | 'turn-completed' | 'turn-interrupted' | 'turn-error' | 'session-end';
export interface LastObserved { fact: ObservedFact; at: string }
// Changes in the session's checkout since it started, counted once when it ended (D11). paths: files the
// session changed (not those already changed at its start), at most 200; from: a rename's old path.
export interface ChangeStats { available: boolean; additions: number; deletions: number; files: number; preexisting: number;
  paths: { path: string; from: string | null }[]; truncated: boolean; at: string; reason?: string }
// sessionSummary (src/core/insights.mjs): stored data only, no Git.
export interface SessionSummary {
  status: SessionStatus; exitCode: number | null; signal: string | number | null; durationMs: number | null;
  changes: ChangeStats | null;                     // the end snapshot (D11); null when none was taken; available: false without a start baseline
  tests: { passed: number; failed: number; unknown: number; commands: string[] } | null;   // null for Codex and Cursor
  identity: { nativeId: string | null; confirmed: boolean; source: Session['nativeIdSource']; mismatch: boolean };
  suggestions: number;                             // open suggestions of this session and its resume chain
}
export interface DiffLine { kind: ' ' | '-' | '+'; old: number | null; new: number | null; text: string }
// A remembered note on a file the session changed, now out of date (staleNotes).
export interface StaleNote {
  note: Memory; path: string; renamedTo: string | null;
  hunks: { lines: DiffLine[] }[] | null;           // note coordinates on the old side
  before: { startLine: number; lines: string[] } | null;   // fallback: the saved excerpt …
  after: { startLine: number; lines: string[] } | null;    // … and the current lines at the same place
  suggestedRange: { startLine: number; endLine: number } | null;  // where the cited lines are now, if they moved
  // The hunks are a window around the note's lines (at most 3 hunks of 40 lines, 300 characters a line).
  // truncated: part of the change was cut, so Still true must stay disabled until the full diff is shown.
  truncated: boolean;
  shownRange: { startLine: number; endLine: number } | null;  // the current file's lines on screen
  contentHash: string | null;                      // the file as shown; reaffirmMemory's expectedHash
  reaffirm: { allowed: boolean; reason: null | 'wrong-branch' | 'separate-copy' | 'file-missing' };
  workspaceId: string | null;                      // the view to reaffirm in
}
// truncated: more than 20 notes, or the 10 s deadline was reached before all were checked.
export interface StaleCatch { available: boolean; notes: StaleNote[]; truncated: boolean }
// Command, path and tool are redacted or workspace-relative by the runtime; inferred: taken from the in-flight tool.
export interface PendingApproval { tool: string | null; command: string | null; path: string | null; at: string; inferred?: boolean; }
export interface TimelineEvent { id?: number; sessionId?: string; at: string; kind: string; body: Record<string, unknown>; }
export type TerminalEvent = { type: 'output'; sessionId: string; sequence: number; data: string } | { type: 'gap'; sessionId: string } | { type: 'status'; session: Session } | { type: 'error'; message: string; sessionId?: string; code?: typeof IDENTITY_CHANGED }
  | { type: 'timeline'; event: TimelineEvent } | { type: 'proposals'; projectId: string; count: number; sessionId?: string; failed?: boolean } | { type: 'runtime'; state: 'connected' | 'disconnected' | 'connecting'; warning?: string; otherBuild?: boolean; recovered?: boolean; recovery?: Recovery | null }
  | { type: 'files'; key: string; folders: string[]; overflow: boolean; stopped?: boolean }
  | { type: 'environment'; environment?: Environment; reconciled?: number }
  | { type: 'run'; runId: string; lastEventId?: number }
  | { type: 'update'; state: UpdateState } | { type: 'providers'; agents: AgentInfo[]; after?: { provider: Provider; kind: ProcessKind } } | { type: 'command'; id: CommandId }
  // Codex and Cursor output times, at most one per session every 5 s; main asks to show a session (notification click).
  | { type: 'activity'; sessionId: string; lastOutputAt: string } | { type: 'focus-session'; sessionId: string } | { type: 'process-output'; id: string; data: string; offset: number } | { type: 'process-exit'; id: string; provider: Provider; kind: ProcessKind; code: number | null };
// colors: the runtime answers colour queries (OSC 10/11/12) itself; absent from an earlier build's runtime.
export interface OutputSnapshot { gap: boolean; chunks: { sequence: number; data: string }[]; lastSequence: number; colors?: boolean }
export interface Workspace { id: string | null; projectId?: string; kind: 'checkout' | 'managed' | 'imported'; path: string; branch: string | null; head?: string | null; base?: string; baseLabel?: string; state: 'intent' | 'ready' | 'failed' | 'missing' | 'removed'; error?: string | null; notices?: string[]; detached?: boolean; }
export interface WorkspaceList { checkout: Workspace; workspaces: Workspace[]; importable: { path: string; branch: string | null; head: string | null; detached: boolean }[]; }
export interface Proposal { id: string; kind: 'rule' | 'test-command' | 'branch-status'; category: string; statement: string; scope: string; branch?: string | null; state: string; createdAt: string; source: Source | null;
  // The session it came from (src/core/proposals.mjs); branch-status and test-command evidence carry more fields.
  evidence?: { sessionId?: string | null } | null;
  // Phase 6: possible conflicts with remembered notes; earlier: suggested by an earlier session of the same conversation.
  conflicts?: Conflict[]; earlier?: boolean; }
export interface FileRoot { key: string; family: 'primary' | 'folder'; kind: string; label: string; path: string; branch: string | null; git: boolean; exists?: boolean; }
export interface FileEntry { name: string; path: string; type: 'directory' | 'file' | 'symlink' | 'other'; sensitive: boolean; }
export interface DirectoryListing { path: string; entries: FileEntry[]; total: number; truncated: boolean; }
export type GitKind = 'conflict' | 'deleted' | 'modified' | 'renamed' | 'typechange' | 'added' | 'untracked' | 'submodule' | 'ignored';
export interface StatusEntry { path: string; sensitive?: boolean; kind: GitKind; directory: boolean; staged: boolean; unstaged: boolean; from?: string | null; submodule?: boolean; }
export interface FileStatus { available: boolean; reason?: string; entries: StatusEntry[]; folders: Record<string, GitKind>; truncated: boolean; branch?: string | null; }
export interface FilePreviewData { path: string; kind: 'text' | 'binary' | 'sensitive' | 'too-large'; size?: number; contentHash?: string; text?: string; invalidUtf8?: boolean; highlight?: boolean; eol?: string; lineCount?: number; }
export interface FileReference { projectId?: string; kind: 'file' | 'lines' | 'folder'; rootKey: string; rootLabel?: string; path: string; display?: string; startLine: number | null; endLine: number | null; contentHash?: string | null; rangeHash?: string | null; }
export interface UpdateState { status: 'off' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'; mode: 'off' | 'auto' | 'notify'; current: string; version: string | null; percent: number | null; message: string | null; automatic: boolean; installing: boolean; }
export interface ProjectState { project: Project; sessions: Session[]; receipts: Receipt[]; needsOrientation?: boolean; }
export interface ChangedFile { path: string; from: string | null; additions: number | null; deletions: number | null; binary: boolean; untracked: boolean; preexisting: boolean; sensitive: boolean; }
// trees: other Git working trees inside the checkout that the session worked in (src/core/changes.mjs).
export interface ChangedTree { path: string; branch: string | null; base: string; head: string; commitsSince: number; files: number }
export interface Changes { base: string; available: boolean; reason?: string; head?: string; branch?: string; headMoved?: boolean; commitsSince?: number; files: ChangedFile[]; trees?: ChangedTree[]; isolated?: { logicalBranch: string; base: string; moved: number | null }; saved?: boolean; truncated?: boolean; additions?: number; deletions?: number; preexistingCount?: number; }
// Phase 7. auth is signed-in or signed-out only from a probe that parsed cleanly (src/core/agents.mjs probeAuth).
export type AuthState = 'unchecked' | 'signed-in' | 'signed-out' | 'unknown';
// A visible one-off process (src/desktop/processes.mjs): one per provider and kind.
export type ProcessKind = 'install' | 'login';
export interface AgentInfo { provider: Provider; available: boolean; version: string | null; path?: string | null; state?: 'ready' | 'checking' | 'missing' | 'not-cursor' | 'unlaunchable' | 'unsupported' | 'login-required'; unlaunchable?: { path: string; reason: string } | null; auth?: AuthState; onPath?: boolean; impostor?: string | null;
  supports?: { resume?: boolean; createChat?: boolean; mode?: boolean; login?: boolean; authStatus?: boolean; hooks?: boolean | null; pluginDir?: boolean }; capabilities?: { exactResume: string; status: string[]; commands: string; fileEdits: boolean; modes?: string };
  // Display strings from main's constant table (PROVIDER_COMMANDS); the renderer never builds argv.
  commands?: { login: string | null; install: string | null; installPage: string | null } }
// What an "About this project" draft was made from (Git only; nothing left this computer). counted: false
// for the large-repository fallback, where folders counts top-level entries.
export interface DraftFacts { readme: string | null; folders: number; commits: number; counted: boolean }
// firstRunDrafts: produced once per project (D10). A card is null when its draft could not be made.
// branchName: the branch the drafts were made on (null when detached); each remembered part sends it
// back with head, and a switch to another branch refuses. 'failed': Git could not be read for that card.
export interface FirstRunDrafts { projectId: string; head: string; branchName: string | null; overview: StatusDraft | null; branch: StatusDraft | null;
  branchSkipped: 'detached' | 'failed' | null; overviewSkipped: 'failed' | null }
export interface Bootstrap { projects: Project[]; agents: AgentInfo[]; platform: string; shortcuts: Partial<Record<CommandId, { label: string; aria: string }>>; runtime: { state: 'connected' | 'disconnected' | 'connecting'; warning: string | null; otherBuild?: boolean }; live: Session[]; active: Session[];
  // Phase 7: any remembered note in any project (the first-note moment never plays for an upgrading install).
  hasNotes: boolean;
  // Phase 8: sessions the runtime recovered from a crashed predecessor, until acknowledged (null when none).
  recovery: Recovery | null; }
// Phase 8: open-file search (searchFiles). spans: matched character ranges in path, [start, end) and merged.
export interface FileHit { path: string; score: number; spans: [number, number][] }
// available false: not a Git folder (file search uses git ls-files), or Git failed (its message is never shown).
// truncated: the listing stopped early, so some files are not searched. truncatedBy says why (Git took
// longer than 8 s, its output passed 64 MiB, or the 200,000-file limit) and listed how many files are searched.
export interface FileSearch { available: boolean; reason?: 'not-git' | 'failed'; hits: FileHit[]; total: number; truncated: boolean;
  truncatedBy?: 'timeout' | 'size' | 'limit'; listed?: number }
// Phase 8: recovery in the runtime hello. status is the state at recovery time; the session row may have moved on since.
export interface RecoveredSession { id: string; status: 'interrupted' | 'orphaned'; identityVerified: boolean | null }
// sessions: at most 100 rows; total: every recovered session (a runtime from before total was added omits it).
export interface Recovery { at: string; runtimeId: string; total?: number; sessions: RecoveredSession[] }
export interface StatusDraft { scope: 'checkout' | 'branch'; memoryId: string | null; previousRevision: number | null; previousStatement: string | null; statement: string; source: { kind: 'git'; base: string | null };
  basis: { label: string; base: string | null; head: string; commitCount?: number; changedFiles?: number; uncommitted?: number; carried?: string[]; structureChanges?: string[]; unchanged?: boolean; notes: string[]; facts?: DraftFacts }; }
declare global {
  interface Window { journal?: { request: (action: string, input?: object) => Promise<unknown>; settle: (action: string, input?: object) => Promise<Settled>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
    // The OS path of a dropped file or folder (Electron webUtils.getPathForFile); '' when it did not come from the OS.
    pathForFile: (file: File) => string;
    // process.platform, known before bootstrap answers (keys pressed as the window appears need it).
    platform?: string }; }
}
// Knowledge writes still in flight. A launch or context preview waits for
// them, so what the agent receives always includes what the user just did
// (the runtime reads the database from another process).
// Only writes that change what a packet contains, and none that wait on a dialog.
const KNOWLEDGE_WRITES = new Set(['proposeMemory', 'setMemoryStatus', 'setPinned', 'markIncorrect', 'proposePromotion', 'acceptProposal', 'rememberProposals', 'reaffirmMemory', 'rememberDraft']);
const READS_KNOWLEDGE = new Set(['start', 'prepareContext', 'previewSelection']);
const pendingWrites = new Set<Promise<unknown>>();
// What the preload bridge returns: thrown errors would lose their code crossing it.
export type Settled = { ok: true; value: unknown } | { ok: false; error: string; code?: string };
// A failed request rejects with an Error that may carry a code. Only the runtime's
// ERROR_CODES (src/core/terminal.mjs) count; any other or missing code is no code.
export const ERROR_CODES = ['SLOTS_FULL', 'SHUTTING_DOWN', 'PROVIDER_MISSING', 'PROVIDER_UNSUPPORTED', 'ID_UNCONFIRMED', 'CONVERSATION_OPEN', 'ORPHAN_RUNNING', 'START_FAILED', 'NOT_LIVE'] as const;
export type ErrorCode = typeof ERROR_CODES[number];
// The error event's code when a hook reports another native session ID (IDENTITY_CHANGED in src/core/terminal.mjs).
export const IDENTITY_CHANGED = 'IDENTITY_CHANGED' as const;
export function errorCode(error: unknown): ErrorCode | null {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return ERROR_CODES.find(known => known === code) ?? null;
}
export async function api<T>(action: string, input: object = {}): Promise<T> {
  if (!window.journal) throw new Error('Open Journal as a desktop app with npm run dev');
  // Bounded: a stuck write never blocks launches for more than 10 s.
  if (READS_KNOWLEDGE.has(action) && pendingWrites.size) await Promise.race([Promise.allSettled([...pendingWrites]), new Promise(resolve => setTimeout(resolve, 10000))]);
  const request = window.journal.settle(action, input).then(result => {
    if (!result.ok) throw Object.assign(new Error(result.error), result.code ? { code: result.code } : {});
    return result.value;
  });
  if (KNOWLEDGE_WRITES.has(action)) { pendingWrites.add(request); void request.finally(() => pendingWrites.delete(request)).catch(() => {}); }
  return await request as T;
}
export const LIVE_STATUSES: SessionStatus[] = ['starting', 'running', 'waiting', 'stopping'];
export const isLive = (session: Session | null | undefined) => !!session && LIVE_STATUSES.includes(session.status);

// An isolated session's environment (src/core/environments.mjs view): what the window shows.
export type EnvironmentState = 'creating' | 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'integrating' | 'conflict' | 'integrated' | 'abandoned' | 'cleanup_pending' | 'removed';
export interface EnvironmentFile { status: string; path: string }
export interface Environment {
  id: string; projectId: string; sessionId: string | null; task: string | null; logicalBranch: string; base: string; state: EnvironmentState;
  result: { id: string; files: EnvironmentFile[]; fileCount: number; excluded: string[]; at: string } | null;
  conflict: { paths: { path: string; kind: string }[]; against: string; at: string; inEnvironment?: boolean } | null;
  integration: { commit: string; phase: string; landedAt: string | null } | null;
  cleanup: { reason?: string; code?: string | null; attempts?: number; from?: string; removedAt?: string } | null; error: string | null; ports: number[]; folder: boolean;
  details: { path: string; tmpDir: string; logDir: string; refs: { base: string; head: string; result: string } };
}
export interface ApplyPreview {
  expect: string;
  environmentId: string; logicalBranch: string; base: string; logicalHead: string; result: string; moved: boolean; commitsSince: number; baseOnBranch: boolean;
  clean: boolean; conflicts: { path: string; kind: string }[]; changes: EnvironmentFile[]; excluded: string[]; blockedBy: string[]; canApply: boolean; checkedOut: boolean;
  busy: string | null; unresolved: string[]; empty: boolean; switchedTo: string | null;
}
