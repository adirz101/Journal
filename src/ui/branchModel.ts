// The branch picker's rules. Pure: BranchPicker.tsx renders them and tests/branches.test.mjs checks them.
import { branches as words } from './copy';

export interface Branch {
  kind: 'local' | 'remote'; name: string; commit: string; upstream: string | null; track: string | null; date: string | null; subject: string; current: boolean;
  // Checked out in another working tree: its path, and the root key and label the Files tab shows it as (when Journal knows it).
  worktree: string | null; worktreeKey?: string | null; worktreeLabel?: string | null;
  // Remote only: the local branch a switch creates, and a local branch of that name that already exists.
  localName?: string | null; conflict?: string | null;
}
export interface BranchList { key: string; label: string; family: 'primary' | 'folder'; branch: string | null; head: string | null; detached: boolean; local: Branch[]; remote: Branch[]; truncated: boolean; blocked: string | null; }
export interface SwitchResult { branch: string | null; head: string | null; previous: string | null; created: boolean; unchanged: boolean; from?: string; key: string; label: string; }
export interface BranchOption { id: string; branch: Branch; enabled: boolean; reason: string | null; }
export interface BranchGroup { id: 'local' | 'remote'; label: string; options: BranchOption[]; }

// Case-insensitive substring match on the branch name; an empty query keeps everything.
export function filterBranches<T extends { name: string }>(branches: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? branches.filter(branch => branch.name.toLocaleLowerCase().includes(needle)) : branches;
}

// Where the query occurs in a name, for highlighting ([start, end] or null).
export function matchSpan(name: string, query: string): [number, number] | null {
  const needle = query.trim().toLocaleLowerCase(); const lower = name.toLocaleLowerCase();
  if (!needle || lower.length !== name.length) return null;
  const at = lower.indexOf(needle); return at < 0 ? null : [at, at + needle.length];
}

// Why a branch cannot be chosen, or null. A session running in the repository blocks every switch.
export function unavailable(branch: Branch, blocked: string | null): string | null {
  if (branch.worktree) return words.inWorktree(branch.worktreeLabel ?? null);
  if (branch.kind === 'remote' && branch.conflict) return words.localExists(branch.conflict);
  if (branch.kind === 'remote' && !branch.localName) return words.unknownRemote;
  if (blocked && !branch.current) return words.blockedShort;
  return null;
}

export const optionId = (branch: Branch) => `${branch.kind}:${branch.name}`;

// Local branches, then remote ones, each filtered; empty groups are left out.
export function branchGroups(list: BranchList | null, query: string): BranchGroup[] {
  if (!list) return [];
  const group = (id: 'local' | 'remote', items: Branch[]): BranchGroup => ({ id, label: id === 'local' ? words.localGroup : words.remoteGroup,
    options: filterBranches(items, query).map(branch => { const reason = unavailable(branch, list.blocked); return { id: optionId(branch), branch, enabled: !reason, reason }; }) });
  return [group('local', list.local), group('remote', list.remote)].filter(g => g.options.length);
}

// The active option after a list change: the same one if still listed, else the first enabled one
// that is not the current branch (what a user most likely wants), else the first.
export function keepActiveBranch(groups: BranchGroup[], chosen: string | null): string | null {
  const all = groups.flatMap(g => g.options);
  if (chosen && all.some(option => option.id === chosen)) return chosen;
  return (all.find(option => option.enabled && !option.branch.current) ?? all[0])?.id ?? null;
}

export function moveActiveBranch(groups: BranchGroup[], active: string | null, step: 1 | -1 | 'first' | 'last'): string | null {
  const all = groups.flatMap(g => g.options); if (!all.length) return null;
  if (step === 'first') return all[0].id;
  if (step === 'last') return all[all.length - 1].id;
  const at = all.findIndex(option => option.id === active);
  return all[Math.min(all.length - 1, Math.max(0, at < 0 ? 0 : at + step))].id;
}

// The short detail beside a branch name: ahead/behind, then the age of its last commit.
export function branchDetail(branch: Branch, now: number): string {
  const parts: string[] = [];
  if (branch.current) parts.push(words.current);
  if (branch.track && branch.track !== 'gone') parts.push(branch.track);
  if (branch.track === 'gone') parts.push(words.upstreamGone);
  if (branch.date) parts.push(age(branch.date, now));
  return parts.join(' · ');
}
function age(iso: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 3600) return words.minutesAgo(Math.max(1, Math.floor(seconds / 60)));
  if (seconds < 86400) return words.hoursAgo(Math.floor(seconds / 3600));
  if (seconds < 86400 * 60) return words.daysAgo(Math.floor(seconds / 86400));
  return words.monthsAgo(Math.floor(seconds / (86400 * 30)));
}
