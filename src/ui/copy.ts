// Plain-language vocabulary (design board B8). Visible text and accessible names
// use these words; the technical term may stay in a tooltip (title), so a label
// always matches what a screen reader announces. Receipt and packet text from
// core are immutable and never pass through here.
export const copy = {
  memory: 'Project memory', memoryTab: 'Memory', addNote: 'Add a note', addSummary: 'Add project summary',
  remember: 'Remember', remembered: 'Remembered', needsReview: 'Needs review', forget: 'Forget…', forgotten: 'Forgotten', suggestions: 'Suggestions',
  aboutProject: 'About this project', branchStands: 'Where this branch stands', projectSummary: 'Project summary',
  outOfDate: 'Out of date', otherBranch: 'Other branch', folderRemoved: 'Folder removed',
  whatWasSent: 'What was sent', wasGoingToSend: 'What was going to be sent', willKnow: 'What the agent will know', searchMemory: 'Search project memory',
  continue: 'Continue', stop: 'Stop', readOnly: 'Read-only', plan: 'Plan', separateCopy: 'Separate copy (worktree)',
  everySession: 'Every session knows', relevant: 'Relevant to your task', notIncluded: 'Not included', leaveOut: 'Leave out for this task', leftOut: 'left out by you', checkNeeded: 'Check needed', rule: 'Rule',
  sourceNote: 'Why (your words)', allBranches: 'All branches', onlyOn: (branch: string | null | undefined) => `Only on ${branch ?? 'this branch'}`,
  slotsFull: (max: number) => `${max} sessions are running. Stop one to start another.`,
  // Session states (design board B8; src/ui/sessionState.ts picks one).
  state: {
    disconnected: 'Disconnected', unknown: 'state unknown', needsApproval: 'Needs approval', yourTurn: 'Your turn', working: 'Working',
    running: 'Running', starting: 'Starting', stopping: 'Stopping', exited: (code: number) => `Exited ${code}`, failed: 'Failed to start',
    stopped: 'Stopped', interrupted: 'Interrupted', orphaned: 'Still running outside Journal',
    noOutput: 'no output yet', outputNow: 'output just now', quiet: (span: string) => `quiet ${span}`, limited: 'limited status',
  },
} as const;

// Tooltips keep the precise term.
export const tip = {
  remember: 'Approve: agents receive this note from the next session',
  forget: 'Archive: agents stop receiving it; it stays in history. To use it again, revise it and review it.',
  continue: 'Resume the same native conversation by its exact ID',
  readOnly: 'Starts in Claude plan mode, the Codex read-only sandbox or Cursor Ask mode; can be changed in the session',
  plan: 'Claude plan mode or Cursor Plan mode',
  memoryTab: 'Reviewed project knowledge that agents receive',
  separateCopy: 'A separate Git worktree on its own branch',
  limitedStatus: "Journal sees output, not the agent's state. Check the terminal for prompts.",
  outputNotSaved: 'Journal never stores terminal output. The runtime keeps a bounded buffer while the session lives.',
  seeWhatWasSent: 'The record of the exact text handed to the CLI at launch (receipt)',
  uncommitted: 'Files with Git status changes in the working tree',
} as const;

// The New session composer (Phase 4, boards B5 and B13).
export const composer = {
  newSession: 'New session', checkoutLine: (name: string, branch: string, sha: string) => `${name} · ${branch} at ${sha}`,
  task: 'Task', taskHint: 'optional, picks relevant notes', taskPlaceholder: 'What are you working on? Mention a module or path to include notes about it.',
  agent: 'Agent', mode: 'Mode', build: 'Build', plan: copy.plan, readOnly: copy.readOnly, workspace: 'Workspace', manage: 'Manage',
  modeHelp: { build: 'Normal native permissions. The CLI asks before it runs tools.',
    plan: 'Starts in Claude plan mode or Cursor Plan mode. You can switch inside the session.',
    'read-only': 'The agent can read but is asked not to change files (Claude plan mode, Codex read-only sandbox, Cursor Ask). You can switch inside the session.' },
  separateCopyHelp: 'Isolated from your other sessions. Journal never stashes, copies or force-removes your work.',
  start: (name: string) => `Start ${name}`, nativeStays: 'Your native login, settings and approvals stay with the CLI.',
  installed: (version: string | null) => version ? `Installed · ${version}` : 'Installed', signedIn: 'Signed in', signInNeeded: 'Sign in needed',
  notInstalled: 'Not installed', install: 'Install…', signIn: 'Sign in…', checking: 'Checking…', unsupported: 'Unsupported version',
  notCursor: 'Not the Cursor CLI', cantLaunch: 'Can’t launch',
  noPlan: (name: string) => `${name} has no plan mode. Choose Build or Read-only.`, noModes: 'This Cursor version has no modes. Choose Build.',
  slotsFull: '4 sessions are running. Stop one to start another.', runtimeDown: 'The runtime is reconnecting. Start is available again once it connects.',
  agentMissing: (name: string) => `${name} isn’t installed on this computer.`,
  updatesAsYouType: 'updates as you type', notes: 'Notes', size: 'Size', notChecked: 'Sources are checked when you start', checked: 'Sources checked',
  notesMatch: (n: number) => n === 1 ? '1 note matches' : `${n} notes match`, hoverHint: 'hover an underline',
  notesMatching: (word: string) => `Notes matching “${word}”`, matches: 'matches', leaveOutShort: 'Leave out',
  leaveOutTip: (mac: boolean) => `Tip: press ${mac ? '⌫' : 'Delete'} on a note to leave it out of this session only.`,
  inspectAll: 'Inspect all', restore: 'Restore', relevantNone: 'No remembered note matches this task yet.',
  relevantEmpty: 'Nothing here yet. After this session, I’ll suggest rules and lessons worth keeping. The ones you remember show up here when they match your task.',
  previewFailed: (message: string) => `Preview unavailable: ${message}`,
} as const;

export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The Phase 3 shell (sidebar, session header, status bar, inspector, layout).
// Every key exists from the start so the three groups never edit the same
// lines; a group adds new keys only in its own block.
export const shell = {
  // A: sidebar and settings
  newSession: 'New session', active: 'Active', slotsUsed: (n: number) => `${n} of 4`,
  recent: 'Recent', today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier', archived: 'Archived',
  suggestionCount: (n: number) => count(n, 'suggestion'), canContinue: 'Can continue', settings: 'Settings',
  runtimeConnected: 'Runtime connected · local only', runtimeStarting: 'Starting runtime…', runtimeDisconnected: 'Runtime disconnected',
  switchProject: (name: string) => `Switch project. Current: ${name}`, noProject: 'No project open',
  appearance: 'Appearance', dark: 'Dark', light: 'Light', notifications: 'Notifications',
  notifyApproval: 'Notify me when Claude needs approval', notifyCommand: 'Show the command in notifications',
  notifyCommandHint: 'Notifications can appear on the lock screen.', dataAndBackups: 'Data and backups', updates: 'Updates',
  // B: header, banner, status bar, inspector
  buildMode: 'Build mode', planMode: 'Plan mode', started: (ago: string) => `Started ${ago} ago`, limitedStatus: 'Limited status',
  interrupt: 'Interrupt', approvalTitle: 'Claude is waiting for your approval', answerInTerminal: 'Answer in the terminal.',
  neverApproves: 'Journal never approves for you.',
  agentGot: (n: number, size: string) => `Agent got ${count(n, 'note')} · ${size}`, agentGotNone: 'Agent got no notes',
  deliveryUncertain: (n: number, size: string) => `Delivery uncertain · ${count(n, 'note')} · ${size}`, notSent: 'Nothing was sent',
  seeWhatWasSent: 'See what was sent', seeWhatWasPrepared: 'See what was prepared',
  diffFiles: (files: number) => `in ${count(files, 'file')}`, noChanges: 'No changes yet',
  nativePermissions: 'Native permissions', outputNotSaved: 'Output not saved',
  sentUncertain: 'What was prepared (delivery uncertain)', // heading for an uncertain delivery (Phase 1 review note)
  inspector: 'Inspector', tabSession: 'Session', tabFiles: 'Files', tabMemory: 'Memory',
  whatThisAgentKnows: 'What this agent knows', atLaunch: (ago: string) => `at launch, ${ago} ago`,
  whatItDid: 'What it did', fromHooks: 'from Claude hooks', showTimeline: 'Show full timeline',
  activityHidden: (provider: string) => `Activity isn't visible for ${provider}`,
  activityHiddenBody: (provider: string) => `${provider} doesn't report its commands or approval prompts to Journal. Its terminal shows everything. Changes are still tracked in Files.`,
  lastOutput: (detail: string) => `Last output: ${detail}`,
  changedCount: (n: number) => `Changed (${n})`, allFiles: 'All files', changesSinceStart: 'Changes since start', uncommitted: 'Uncommitted',
  // C: layout
  showInspector: 'Show inspector', hideInspector: 'Hide inspector', expandSidebar: 'Expand sidebar', collapseSidebar: 'Collapse sidebar',
  recentSessions: 'Recent sessions',
} as const;

const CATEGORIES: Record<string, string> = { constraint: copy.rule, decision: 'Decision', convention: 'Convention', lesson: 'Lesson', issue: 'Known issue' };
// A brief is "About this project" (checkout scope) or "Where this branch stands" (branch scope).
export function category(name: string, scope?: string) {
  if (name === 'brief') return scope === 'branch' ? copy.branchStands : scope === 'checkout' ? copy.aboutProject : copy.projectSummary;
  return CATEGORIES[name] ?? name;
}

export function memoryState(memory: { status: string; validation: string }) {
  if (memory.validation === 'stale') return copy.outOfDate;
  if (memory.validation === 'wrong-branch') return copy.otherBranch;
  if (memory.validation === 'folder-removed') return copy.folderRemoved;
  return ({ active: copy.remembered, candidate: copy.needsReview, rejected: 'Rejected', archived: copy.forgotten } as Record<string, string>)[memory.status] ?? memory.status;
}

// Delivery state of what was sent to an agent.
export function deliveryState(state: string | undefined) {
  return ({ prepared: 'preview', submitted: 'sent', failed: 'not sent', uncertain: 'delivery uncertain' } as Record<string, string>)[state ?? 'prepared'] ?? String(state);
}

// Why core selected a note (selection.reason), in plain words. A match reads
// "matched <terms>[ in <area>]"; the note's own area marks the suffix, so a
// term or area containing " in " is never split in the wrong place.
export function selectionReason(reason: string | undefined, area?: string | null) {
  if (!reason || reason === 'selected') return 'Included';
  if (reason === 'repo overview') return copy.aboutProject;
  if (reason === 'branch update') return copy.branchStands;
  if (reason === 'pinned') return 'Pinned';
  if (reason.startsWith('referenced area ')) return `In ${reason.slice('referenced area '.length)}, which you referenced`;
  if (reason !== 'matched' && !reason.startsWith('matched ')) return reason;
  let terms = reason.slice('matched'.length).trim(); let where = '';
  if (area && terms.endsWith(` in ${area}`)) { where = area; terms = terms.slice(0, -` in ${area}`.length); }
  return `${!terms || terms === 'task terms' ? copy.relevant : `Matches ${terms}`}${where ? ` · in ${where}` : ''}`;
}

// Why core left a note out (excluded[].reason codes). "Not included" heads every
// reason; "leave out" / "left out" is only the user's own choice for one task.
const EXCLUDED: Record<string, string> = {
  stale: 'out of date', 'wrong-branch': 'other branch', 'area-not-requested': 'area not in task', duplicate: 'same as a note already included',
  'brief-limit': 'project summary limit', 'folder-removed': 'its folder was removed from the project', budget: 'size limit', 'category-limit': 'too many of one kind', 'left-out-for-task': copy.leftOut,
};
export const excludedReason = (code: string) => EXCLUDED[code] ?? code;

// Core warnings are English sentences; map the known ones, show others as they are.
const WARNINGS: [RegExp, (...groups: string[]) => string][] = [
  [/^Project brief search inspected 100 entries\./, () => 'Journal looked at 100 project summaries. Forget old ones so others can be included.'],
  [/^Search inspected 1000 matches\./, () => 'Journal looked at 1,000 matching notes. Narrow the task or forget out-of-date notes to search further.'],
  [/^The current branch update is (\d+) commits? behind HEAD\./, n => `${copy.branchStands} is ${count(Number(n), 'commit')} behind. Draft an update to review recent progress.`],
  [/^Claims (\S+) r(\d+) and (\S+) r(\d+) may conflict\./, (a, ra, b, rb) => `Notes ${a} (revision ${ra}) and ${b} (revision ${rb}) may conflict. Check them in Memory.`],
  [/^Only four current project brief entries fit/, () => 'Only four project summaries fit. Combine or forget older ones.'],
  [/^A project brief was excluded by the context budget\./, () => 'A project summary did not fit the size limit. Shorten or combine summaries.'],
  [/^No current approved project brief is included\./, () => `No “${copy.aboutProject}” note is included. Add one so every session starts oriented.`],
];
export function warningText(text: string) {
  for (const [pattern, render] of WARNINGS) { const match = pattern.exec(text); if (match) return render(...match.slice(1)); }
  return text;
}
