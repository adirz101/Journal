// Plain-language vocabulary (design board B8). Visible text and accessible names
// use these words; the technical term may stay in a tooltip (title), so a label
// always matches what a screen reader announces. Receipt and packet text from
// core are immutable and never pass through here.
export const copy = {
  memory: 'Project memory', memoryTab: 'Memory', addNote: 'Add a note', addSummary: 'Add project summary',
  remember: 'Remember', remembered: 'Remembered', needsReview: 'Needs review', archive: 'Archive', suggestions: 'Suggestions',
  aboutProject: 'About this project', branchStands: 'Where this branch stands', projectSummary: 'Project summary',
  outOfDate: 'Out of date', otherBranch: 'Other branch', folderRemoved: 'Folder removed',
  whatWasSent: 'What was sent', willKnow: 'What the agent will know',
  continue: 'Continue', stop: 'Stop', readOnly: 'Read-only', plan: 'Plan', separateCopy: 'Separate copy (worktree)',
  everySession: 'Every session knows', relevant: 'Relevant to your task', notIncluded: 'Not included', checkNeeded: 'Check needed', rule: 'Rule',
  allBranches: 'All branches', onlyOn: (branch: string | null | undefined) => `Only on ${branch ?? 'this branch'}`,
} as const;

// Tooltips keep the precise term.
export const tip = {
  remember: 'Approve: agents receive this note from the next session',
  archive: 'Withdraw: agents stop receiving this note',
  continue: 'Resume the same native conversation by its exact ID',
  readOnly: 'Starts in Claude plan mode, the Codex read-only sandbox or Cursor Ask mode; can be changed in the session',
  plan: 'Claude plan mode or Cursor Plan mode',
  memoryTab: 'Reviewed project knowledge that agents receive',
  separateCopy: 'A separate Git worktree on its own branch',
} as const;

export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
  return ({ active: copy.remembered, candidate: copy.needsReview, rejected: 'Rejected', archived: 'Archived' } as Record<string, string>)[memory.status] ?? memory.status;
}

// Delivery state of what was sent to an agent.
export function deliveryState(state: string | undefined) {
  return ({ prepared: 'preview', submitted: 'sent', failed: 'not sent', uncertain: 'delivery uncertain' } as Record<string, string>)[state ?? 'prepared'] ?? String(state);
}

// Why core selected a note (selection.reason), in plain words.
export function selectionReason(reason: string | undefined) {
  if (!reason || reason === 'selected') return 'Included';
  if (reason === 'repo overview') return copy.aboutProject;
  if (reason === 'branch update') return copy.branchStands;
  if (reason === 'pinned') return 'Pinned';
  const area = /^referenced area (.+)$/.exec(reason);
  if (area) return `In ${area[1]}, which you referenced`;
  const matched = /^matched(?: (.+?))?(?: in (\S.*))?$/.exec(reason);
  if (matched) return `${!matched[1] || matched[1] === 'task terms' ? copy.relevant : `Matches ${matched[1]}`}${matched[2] ? ` · in ${matched[2]}` : ''}`;
  return reason;
}

// Why core left a note out (excluded[].reason codes).
const EXCLUDED: Record<string, string> = {
  stale: 'out of date', 'wrong-branch': 'other branch', 'area-not-requested': 'area not in task', duplicate: 'same as a note already included',
  'brief-limit': 'project summary limit', 'folder-removed': 'its folder was removed from the project', budget: 'size limit', 'category-limit': 'too many of one kind', 'left-out-for-task': 'left out by you',
};
export const excludedReason = (code: string) => EXCLUDED[code] ?? code;

// Core warnings are English sentences; map the known ones, show others as they are.
const WARNINGS: [RegExp, (...groups: string[]) => string][] = [
  [/^Project brief search inspected 100 entries\./, () => 'Journal looked at 100 project summaries. Archive old ones so others can be included.'],
  [/^Search inspected 1000 matches\./, () => 'Journal looked at 1,000 matching notes. Narrow the task or archive out-of-date notes to search further.'],
  [/^The current branch update is (\d+) commits? behind HEAD\./, n => `${copy.branchStands} is ${count(Number(n), 'commit')} behind. Draft an update to review recent progress.`],
  [/^Claims (\S+) r(\d+) and (\S+) r(\d+) may conflict\./, (a, ra, b, rb) => `Notes ${a} (revision ${ra}) and ${b} (revision ${rb}) may conflict. Check them in Memory.`],
  [/^Only four current project brief entries fit/, () => 'Only four project summaries fit. Combine or archive older ones.'],
  [/^A project brief was excluded by the context budget\./, () => 'A project summary did not fit the size limit. Shorten or combine summaries.'],
  [/^No current approved project brief is included\./, () => `No “${copy.aboutProject}” note is included. Add one so every session starts oriented.`],
];
export function warningText(text: string) {
  for (const [pattern, render] of WARNINGS) { const match = pattern.exec(text); if (match) return render(...match.slice(1)); }
  return text;
}
