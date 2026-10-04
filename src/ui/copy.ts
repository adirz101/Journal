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
