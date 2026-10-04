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
  // Phase 5: a note card's trust lines (src/ui/noteCardModel.ts composes them). Never "used": Journal sees delivery only.
  trust: {
    today: 'today', yesterday: 'yesterday', daysAgo: (n: number) => `${n} days ago`, onDate: (date: string) => `on ${date}`,
    rememberedBy: 'You remembered this', rememberedSuffix: ', remembered by you',
    fromSession: (title: string) => `from the session '${title}'`, fromUntitled: 'from a session', removedSession: 'From a removed session',
    added: (date: string) => `You added this on ${date}`, git: (range: string) => `Drafted from Git (${range})`, upTo: (head: string) => `up to ${head}`,
    imported: (date: string) => `Imported on ${date}`, promoted: (branch: string) => `Proposed for all branches from ⑂ ${branch}`,
    basedOn: (where: string) => `Based on ${where}`, unchanged: 'file unchanged since you saved it', fileChanged: 'file changed',
    atStart: 'checked when the session started', whenYouStart: 'checked when you start', atPrepared: 'checked when this launch was prepared', onlyOn: (branch: string) => `only on ⑂ ${branch}`, anotherBranch: 'another branch', folderRemoved: 'its folder was removed from the project',
    notSent: 'Not sent yet', sentTo: (n: number) => n === 1 ? 'Sent to 1 session' : `Sent to ${n} sessions`,
    sentTip: 'Counted once per conversation, including resumes. Includes starts where Journal could not confirm delivery.',
    // Memory tab filters (board WrapUp): chips by category, then two attention toggles.
    category: 'Category', otherBranches: 'Other branches', checking: '…', checked: (n: number, total: number) => `Checked ${n} of ${total}`,
    needCheck: (n: number) => n === 1 ? '1 note needs a check' : `${n} notes need a check`, firstOnly: (n: number) => `Showing the first ${n}`,
    noneNeedCheck: 'No notes need a check', checkingNotes: 'Checking notes…', noneOtherBranch: 'No notes for other branches', showSource: 'Show source', hideSource: 'Hide source',
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
  notInstalled: 'Not installed', install: 'Install…', installPage: 'Install page…', signIn: 'Sign in…', signInUnknown: 'Sign-in unknown', checking: 'Checking…', unsupported: 'Unsupported version',
  notCursor: 'Not the Cursor CLI', cantLaunch: 'Can’t launch',
  noPlan: (name: string) => `${name} has no plan mode. Choose Build or Read-only.`, noModes: 'This Cursor version has no modes. Choose Build.',
  slotsFull: '4 sessions are running. Stop one to start another.', runtimeDown: 'The runtime is reconnecting. Start is available again once it connects.',
  // The action names the card's own button, so the reason beside Start says what to do next.
  agentMissing: (name: string, action?: 'install' | 'page' | 'login') => `${name} isn’t installed on this computer.${action === 'install' ? ' Choose Install… on its card.' : action === 'page' ? ' Choose Install page… on its card.' : ''}`,
  updatesAsYouType: 'updates as you type', notes: 'Notes', size: 'Size', notChecked: 'Sources are checked when you start', checked: 'Sources checked',
  notesMatch: (n: number) => n === 1 ? '1 note matches' : `${n} notes match`, hoverHint: 'hover an underline',
  notesMatching: (word: string) => `Notes matching “${word}”`, matches: 'matches', leaveOutShort: 'Leave out',
  leaveOutTip: (mac: boolean) => `Tip: press ${mac ? '⌫' : 'Delete'} on a note to leave it out of this session only.`,
  inspectAll: 'Inspect all', restore: 'Restore', relevantNone: 'No remembered note matches this task yet.', relevantNoTask: 'Type a task to see matching notes.',
  relevantEmpty: 'Nothing here yet. After this session, I’ll suggest rules and lessons worth keeping. The ones you remember show up here when they match your task.',
  previewFailed: (message: string) => `Preview unavailable: ${message}`, previewTimedOut: 'it took more than 20 seconds. Keep typing to try again.',
  // Group B: the renderer's own words.
  notesMatchingTask: 'Notes matching your task', pinned: 'Pinned', current: 'Current', checkedWhenYouStart: 'Checked when you start',
  referencesHint: 'Paths and lines only; the agent reads the files itself.', referencesLabel: 'Files referenced for the next task',
  matchesTerms: (terms: string[]) => `Matches ${terms.join(', ')}`, notIncludedChip: (n: number, reason: string) => `${n} ${reason}`,
  inspectEmpty: 'Type a task in New session to see what the agent will know.', manageWorkspacesSuffix: ' workspaces', // visually hidden after "Manage": the button reads "Manage workspaces"
  currentCheckout: (branch: string) => `Current checkout · ${branch}`, existingWorktree: (branch: string) => `Existing worktree · ${branch}`, folder: (name: string) => `Folder · ${name}`,
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
  // The switcher menu lists at most 28 projects; Open project… on a known folder reopens it.
  moreProjects: (n: number) => `${count(n, 'more project')} not listed · use Open project… to reach one`,
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

// Phase 6: the session wrap-up, the out-of-date catch and the exit-error view (boards 6, 14, States 5).
// Durations arrive formatted ("18m", "<1m", "1h 5m"); src/ui/wrapUpModel.ts picks the key.
export const wrapUp = {
  exited: (code: number, duration: string) => `Exited ${code} after ${duration}`, stopped: (duration: string) => `Stopped after ${duration}`,
  endedBy: (signal: string, duration: string) => `Ended by ${signal} after ${duration}`,
  interrupted: 'Interrupted', couldNotStart: 'Couldn’t start', exitedWithError: 'Session exited with an error',
  showTerminal: 'Show terminal', showSummary: 'Back to summary', continueShort: 'Continue',
  changes: 'Changes', openDiff: 'Open diff', changesTip: 'Changes in this checkout since the session started, counted when it ended. Other sessions in the same checkout are included.',
  changesNone: 'Open the Files tab to see changes', noChanges: 'none', alreadyChanged: (n: number) => `${n} already changed before the start`,
  testsRun: 'Tests run', testsHidden: (provider: string) => `Not visible for ${provider}`, noTests: 'No test commands seen',
  passed: (n: number) => `${n} passed`, failed: (n: number) => `${n} failed`,
  continueCard: 'Continue this conversation', confirmFirst: 'Confirm the conversation ID first',
  identity: {
    observed: 'Same conversation · ID confirmed by Claude', preassigned: 'ID set by Journal at start; Claude didn’t report it back',
    createChat: 'Chat created by Journal before the start', exitBanner: 'From Codex’s exit message · confirm before continuing',
    user: 'Confirmed by you', mismatch: 'Claude reported a different conversation. Confirm the ID before continuing.', none: 'No conversation ID yet',
  },
  worthKeeping: 'Worth keeping from this session?', nothingKept: 'Nothing is kept unless you choose. Remembered notes reach future sessions where they apply.',
  looking: 'Looking for suggestions…', noSuggestions: 'No suggestions from this session.',
  explainer: 'These are suggestions. I picked them from what you said and what passed in this session. Remember the useful ones and the next agent starts with them; dismiss the rest.',
  gotIt: 'Got it', remember: 'Remember', rememberAll: (n: number) => `Remember all ${n}`, edit: 'Edit…', dismiss: 'Dismiss', undo: 'Undo', finishDraft: 'Finish draft',
  remembered: 'Remembered. It goes to new sessions where it applies.', openInMemory: 'Open in Memory',
  dismissed: 'Dismissed. It won’t be suggested again.', waitingReview: 'Added to Memory under Needs review.',
  fromTask: 'You stated this rule in the task', fromTests: 'Seen in this session’s test commands', suggestedEarlier: 'Suggested earlier in this conversation',
  mayConflict: 'May conflict with a remembered note', reviewInMemory: 'Review in Memory',
  branchUnreachable: (branch: string) => `Only on ⑂ ${branch}. Check out that branch to remember it`,
  staleHead: (path: string, n: number) => `This session changed ${path}. ${n === 1 ? '1 note is' : `${n} notes are`} based on it.`,
  staleBody: 'Until you check it, the note is left out of new sessions, so no agent gets an outdated note.',
  fileChanged: 'file changed', whatChanged: (where: string) => `What changed in ${where}`, savedLines: 'Saved lines', now: 'Now',
  renamedTo: (path: string) => `Renamed to ${path}`, linesMoved: 'The cited lines moved. Lines', removedLine: 'removed', addedLine: 'added',
  updateNote: 'Update note…', stillTrue: 'Still true', stillTrueHelp: '“Still true” records that you checked it against this change.',
  separateCopyOnly: 'Changed in this separate copy only. Check it from the main checkout after you merge.',
  fileMissing: 'The file was moved or deleted. Update the note or forget it.',
  resolvedStillTrue: 'Marked still true. Checked against this change; new sessions get it again.',
  resolvedUpdated: 'Note updated. Your edited version goes to new sessions after you review it.',
  resolvedForgotten: 'Note forgotten. No new session will get it. It stays in History.',
  handoff: 'Continue with another agent. It gets the same project memory.', newSessionWithTask: 'New session with this task',
  notSaved: 'Terminal output is kept in memory only while Journal’s runtime runs. It was not saved and is no longer available.',
  lastOutput: 'Last thing in the terminal', copyOutput: 'Copy output', copied: 'Copied',
  ended: (suggestions: number) => `Session ended. ${count(suggestions, 'suggestion')}.`,
  // --- Phase 6 Group B additions ---
  unknown: (n: number) => `${n} without a result`, appliesAll: 'applies to all branches', cancel: 'Cancel',
  showWholeChange: 'Show the whole change', wholeChangeNeeded: 'Part of this change is not shown. Show the whole change before you mark the note still true.',
  wholeChangeTooLarge: 'This change is too large to show in full here. Update the note instead.', wholeChangeHidden: 'This file’s content is hidden because its name looks sensitive. Update the note instead.',
  wholeChange: 'The whole change in this file since the note was saved',
  wholeChangeAgain: 'The file changed again while it loaded. Check the new change.', wholeChangeFailed: 'Couldn’t load the whole change. Update the note instead.',
  linesTo: 'to', rangeInvalid: 'Choose 1 to 30 lines.', rangeLabel: (edge: string) => `${edge} line`,
  confirmId: 'Confirm conversation ID', idLabel: 'Conversation ID', idPlaceholder: 'Exact ID from the agent’s own CLI', copyId: 'Copy ID',
  fromSession: 'Suggested from this session', branchUpdate: 'Drafted from this branch’s commits · needs your two lines',
  checkFailed: (message: string) => `Couldn’t mark it still true: ${message}`,
  // --- Phase 6 Group B review fixes ---
  notSavedFailed: 'This session didn’t start, so Journal has no terminal output for it.',
  moreSuggestions: (n: number) => `${n === 1 ? 'More suggestion' : 'More suggestions'} from this session`, moreSuggestionsLabel: (n: number) => `${count(n, 'more suggestion')} from this session`, review: 'Review',
  source: (where: string) => `Source: ${where}`,
  editOnBranch: (branch: string) => `To edit it, switch to ⑂ ${branch}`, finishOnBranch: (branch: string) => `Switch to ⑂ ${branch} to finish it`,
  nothingToCopy: 'Nothing to copy yet',
  savedLineHeader: 'Saved line', lineNowHeader: 'Line now', changeHeader: 'Change', textHeader: 'Text', lineHeader: 'Line',
} as const;

// Phase 7: first run (boards 1, 2, 3 and 12). Voice (board 12): plain and calm, no exclamation
// marks or emoji. First person ("I") only in onboarding, empty states and explanations, never in
// status or errors. tests/copy.test.mjs enforces the rules (Phase 7 B5).
export const firstRun = {
  welcomeTitle: 'Your agents remember your project',
  welcomeBody: 'Journal runs Claude Code, Codex and Cursor in their own terminals, and gives every new session what you taught the last one.',
  openProject: 'Open a project…', openHint: 'Any Git folder. Or drop one on this window.',
  agentsHeading: 'Agents on this computer', agentsHint: 'You need at least one',
  localOnly: 'Everything stays on this computer. Your agents keep their own logins, settings and approvals.',
  knowTitle: 'I read your project. Here’s what I’d tell an agent.',
  // "Drafted from Git: README, 8 top-level folders, 93 commits · no AI call · nothing left this computer".
  facts: (f: { readme: string | null; folders: number; commits: number; counted: boolean }) => `Drafted from Git: ${[
    f.readme ? 'README' : null,
    `${f.folders} top-level ${f.counted ? (f.folders === 1 ? 'folder' : 'folders') : (f.folders === 1 ? 'entry' : 'entries')}`,
    `${f.commits} ${f.commits === 1 ? 'commit' : 'commits'}`,
  ].filter(Boolean).join(', ')} · no AI call · nothing left this computer`,
  aboutProject: 'About this project', branchStands: 'Where this branch stands',
  workingOn: 'Working on now', next: 'Next', rulesToKeep: 'Rules to keep', optional: 'optional',
  onlyYou: 'Only you know these two lines. Git can’t tell an agent what you meant to do next.',
  rememberBoth: 'Remember both', rememberOne: 'Remember', skip: 'Skip for now', editLater: 'You can edit these any time in Project memory.',
  howTitle: 'How Journal remembers',
  howSteps: [
    'You review every note before an agent gets it.',
    'Each new session starts with the notes that apply to its branch and task.',
    'After a session, I suggest what was worth keeping. Nothing is kept unless you choose.',
  ],
  noBranch: {
    detached: 'This checkout isn’t on a branch, so I drafted only “About this project”.',
    unborn: 'This repository has no commits yet. Make a first commit and I’ll draft these notes.',
    failed: 'I couldn’t read this branch’s history from Git, so I drafted only “About this project”.',
  },
  noProject: {
    failed: 'I couldn’t read this project’s files from Git, so I drafted only “Where this branch stands”.',
  },
  firstNote: 'First note remembered. Every new session in Journal will know it.',
  draftBranch: 'Draft “Where this branch stands”', draftProject: 'Draft “About this project”',
  dropNotFolder: 'Drop a folder from Finder or File Explorer.',
} as const;

// Phase 7: the agent rows (Welcome, composer cards and Cursor status share them).
export const providers = {
  checking: 'Checking…', installedAs: (version: string | null) => version ? `Installed · ${version}` : 'Installed',
  signedIn: 'Signed in', signInNeeded: 'Sign in needed', notInstalled: 'Not installed',
  install: 'Install…', signIn: 'Sign in…', checkAgain: 'Check again', openInstallPage: 'Open install page',
  offPath: (name: string) => `Installed, but Journal can’t find ${name} on PATH. Restart Journal, or add its folder to PATH.`,
  loginTitle: (name: string) => `Sign in to ${name}`, installTitle: (name: string) => `Install ${name}`,
  installedHere: (name: string) => `${name} is installed on this computer.`,
} as const;

// Phase 8: the command palette and open-file (board 7). Group B may fix wording; keys stay.
export const palette = {
  placeholder: 'Search sessions, commands and notes…', filePlaceholder: (root: string) => `Open a file in ${root}…`,
  referencePlaceholder: (root: string) => `Reference a file in ${root}…`,
  title: 'Command palette', fileTitle: 'Open a file', referenceTitle: 'Reference a file',
  groups: { sessions: 'Sessions', quiet: 'Quiet sessions to check', actions: 'Actions', memory: 'Project memory', files: 'Files' },
  noResults: (q: string) => `No sessions, commands or notes match “${q}”.`, newWithTask: 'New session with this task', addAsNote: 'Add as a note',
  searches: 'Searches titles, tasks and notes. Terminal output isn’t saved, so it isn’t searched.',
  move: 'move', open: 'open', commandsOnly: 'Type > for commands only', continueHint: 'Continue',
  fileHint: 'Type part of a file name', notGit: 'File search needs a Git folder. Use the Files tab.',
  fileFailed: 'Git couldn’t list the files in this folder. Use the Files tab.',
  // n: the files listed (FileSearch.listed). A timeout says so: the limit is not the reason then.
  filesTruncated: (n: number, by: 'timeout' | 'size' | 'limit' = 'limit') => by === 'timeout'
    ? `Git took too long to list every file. Only the first ${n.toLocaleString('en-US')} files are searched.`
    : `Only the first ${n.toLocaleString('en-US')} files are searched.`,
  // One label per routed command (CommandId) and per palette-only action.
  actions: {
    'new-session': 'New session', 'open-project': 'Open project…', 'add-note': 'Add a note', 'focus-terminal': 'Focus the terminal',
    'toggle-inspector': 'Show or hide the inspector', 'toggle-sidebar': 'Show or hide the sidebar',
    'slot-1': 'Go to session 1', 'slot-2': 'Go to session 2', 'slot-3': 'Go to session 3', 'slot-4': 'Go to session 4',
    'next-needs-you': 'Jump to the next session that needs you', 'tab-session': 'Show the Session tab', 'tab-files': 'Show the Files tab',
    'tab-memory': 'Show the Memory tab', settings: 'Settings', 'command-palette': 'Command palette', 'open-file': 'Open a file…',
    'manage-workspaces': 'Manage workspaces…', 'new-session-separate-copy': 'New session in a separate copy', 'check-agents': 'Check agents again',
  },
  // --- Phase 8 Group B ---
  // Why an action is unavailable: the same guard the matching button or key uses.
  reasons: { needsProject: 'Open a project first', needsSession: 'Open a session first', noneNeedsYou: 'No session needs you right now', busy: 'Wait for the current action to finish' },
  noFiles: (q: string) => `No file name matches “${q}”.`, results: 'Results',
  // The input's description: the footer says the same, but the footer is hidden from screen readers.
  howTo: 'Up and down arrows move between results, Enter opens one. Type > for commands only.',
  fileHowTo: 'Up and down arrows move between files, Enter opens one.',
  addReference: 'Add reference…',
} as const;

// Phase 8: failure states (board 9): one honest sentence and one next step each.
export const states = {
  lostTitle: 'Lost connection to the session runtime', lostBody: 'Your agents may still be running. Journal is trying again every few seconds.',
  reconnectNow: 'Reconnect now', reconnecting: 'Reconnecting…',
  crashTitle: 'The session runtime stopped unexpectedly',
  // Counts recovery.total: the sessions list stops at 100 rows.
  crashBody: (recovery: { total?: number; sessions: readonly unknown[] }) => {
    const n = recovery.total ?? recovery.sessions.length;
    return `${n === 1 ? '1 session was' : `${n} sessions were`} interrupted. Nothing was resent to the agents.`;
  },
  crashContinue: 'Continue each one when you’re ready; it reopens the same conversation.',
  needsId: 'Needs the conversation ID before continuing', confirmId: 'Confirm ID…', stillRunning: 'Still running outside Journal',
  leftover: (n: number) => n === 1 ? '1 leftover process still running' : `${n} leftover processes still running`, review: 'Review', done: 'Done',
  cantStartTitle: (name: string, problem: 'signed-out' | 'missing' | 'unsupported' | 'failed') => problem === 'signed-out' ? `${name} isn’t signed in`
    : problem === 'missing' ? `${name} isn’t installed` : problem === 'unsupported' ? `This ${name} version isn’t supported` : `${name} couldn’t start`,
  signInBody: 'Sign in once in a terminal, then start again. Journal never handles your login.',
  openTerminal: 'Open terminal', copyCommand: 'Copy command', copyFailed: 'Copy failed', checkAgain: 'Check again', kept: 'Your task text is kept. Nothing was sent.',
  slotsFull: '4 of 4 running. Stop or finish one to start another. You can still write the task now.',
  // --- Phase 8 Group B ---
  copied: 'Copied', recoveryLabel: 'Interrupted sessions', unsupportedBody: 'Update it, then check again.', missingBody: 'Install it, then check again.',
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
