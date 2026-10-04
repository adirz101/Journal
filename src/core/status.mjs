import { git } from './project.mjs';
import { refuseCredentials } from './validation.mjs';

// Deterministic status drafts from local Git facts. Nothing here writes to the
// store or calls a model: a draft is only text for the operator to edit, save as
// a candidate and approve. Commit subjects and paths are data, never instructions.

export const PLACEHOLDER = /\[describe[^\]]*\]/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_STATEMENT = 2000;
const MANIFESTS = /^(?:README(?:\.[a-z]+)?|AGENTS\.md|CLAUDE\.md|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Gemfile|composer\.json)$/i;

const quiet = (action, fallback) => { try { return action(); } catch { return fallback; } };
const safe = value => { try { refuseCredentials(value); return true; } catch { return false; } };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const short = hash => hash.slice(0, 7);

export function isCommit(root, value) {
  return typeof value === 'string' && COMMIT.test(value) && quiet(() => git(root, ['cat-file', '-e', `${value}^{commit}`]) === '', false);
}

export function isAncestor(root, ancestor, head = 'HEAD') {
  return quiet(() => { git(root, ['merge-base', '--is-ancestor', ancestor, head]); return true; }, false);
}

export function commitsSince(root, commit) {
  return Number(quiet(() => git(root, ['rev-list', '--count', `${commit}..HEAD`]), 'NaN'));
}

function defaultBase(root, branch) {
  const remote = quiet(() => git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']), '');
  for (const ref of [remote, 'main', 'master', 'origin/main', 'origin/master'].filter(Boolean)) {
    if (ref === branch || ref === `origin/${branch}`) continue;
    const base = quiet(() => git(root, ['merge-base', ref, 'HEAD']), '');
    if (base) return { base, ref };
  }
  return null;
}

function areaOf(path) {
  const parts = path.split('/');
  if (parts.length === 1) return '(root)';
  return ['src', 'packages', 'apps', 'lib', 'crates'].includes(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function summarizeAreas(paths, limit = 6) {
  const counts = new Map();
  for (const path of paths) counts.set(areaOf(path), (counts.get(areaOf(path)) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, limit).map(([area, count]) => `${area} (${count})`);
  return sorted.length > limit ? [...shown, `${sorted.length - limit} more areas`].join(', ') : shown.join(', ');
}

function uncommitted(root) {
  const list = args => quiet(() => git(root, args).split('\n').filter(Boolean), []);
  return [...new Set([...list(['diff', '--name-only', 'HEAD']), ...list(['ls-files', '--others', '--exclude-standard'])])];
}

// Keep labelled lines the operator wrote so a refresh does not discard intent.
function carriedLine(statement, label) {
  const match = statement?.match(new RegExp(`^${label}:[ \\t]*(.+)$`, 'mi'));
  return match && !PLACEHOLDER.test(match[1]) ? match[1].trim() : null;
}

function fit(head, items, tail, more) {
  // Drop listed subjects, never the operator-facing prompts, until the claim fits.
  for (let shown = items.length; shown >= 0; shown--) {
    const hidden = more + items.length - shown;
    const list = [...items.slice(0, shown), ...(hidden ? [`- … and ${hidden} more`] : [])];
    const statement = [head, ...list, ...tail].join('\n');
    if (statement.length <= MAX_STATEMENT) return statement;
  }
  return [head, ...tail].join('\n').slice(0, MAX_STATEMENT);
}

export function branchDraft(project, previous) {
  const { root } = project; const notes = [];
  if (!project.branch) throw new Error('Branch updates require a named branch');
  if (!project.head) throw new Error('Branch updates require at least one commit');
  const recorded = previous?.source?.kind === 'git' ? previous.source.head : previous?.source?.commit;
  let base = null; let label;
  if (recorded && isCommit(root, recorded) && isAncestor(root, recorded)) { base = recorded; label = `the last update (${short(recorded)})`; }
  else {
    if (recorded) notes.push('The previous update is not in this branch history; using the branch point instead.');
    const found = defaultBase(root, project.branch);
    if (found && found.base !== project.head) { base = found.base; label = `branching from ${found.ref} (${short(found.base)})`; }
    else label = 'recent history';
  }
  const range = base ? [`${base}..HEAD`] : ['-n', '30', 'HEAD'];
  const commitCount = base ? commitsSince(root, base) : Math.min(30, Number(git(root, ['rev-list', '--count', 'HEAD'])));
  const log = quiet(() => git(root, ['log', '--no-merges', '--format=%h%x1f%s', '-n', '30', ...range]).split('\n').filter(Boolean), []);
  let omitted = 0;
  const subjects = log.map(line => line.split('\x1f')).filter(([, subject]) => { if (safe(subject)) return true; omitted++; return false; })
    .map(([hash, subject]) => `- ${subject.length > 100 ? `${subject.slice(0, 99)}…` : subject} (${hash})`);
  if (omitted) notes.push(`${plural(omitted, 'commit subject')} omitted: possible credential.`);
  const files = (base ? quiet(() => git(root, ['diff', '--name-only', '-M', base, 'HEAD']), '') : quiet(() => git(root, ['log', '--name-only', '--format=', ...range]), ''))
    .split('\n').filter(Boolean).filter(safe);
  const changed = [...new Set(files)];
  const pending = uncommitted(root).filter(safe);
  const current = carriedLine(previous?.statement, 'Current work'); const next = carriedLine(previous?.statement, 'Next');
  const carried = [current && 'Current work', next && 'Next'].filter(Boolean);
  const head = base ? `Completed (${plural(commitCount, 'commit')} since ${label}; HEAD ${short(project.head)}):`
    : `Recent commits (latest ${commitCount}; no earlier update or branch point; HEAD ${short(project.head)}):`;
  const tail = [
    `Changed areas: ${changed.length ? summarizeAreas(changed) : 'none'}`,
    `Uncommitted: ${pending.length ? `${plural(pending.length, 'file')} (${pending.slice(0, 4).join(', ')}${pending.length > 4 ? ', …' : ''})` : 'none'}`,
    `Current work: ${current ?? '[describe what this branch is doing now]'}`,
    `Next: ${next ?? '[describe the next concrete step and any blocker]'}`,
  ];
  if (!commitCount) notes.push('No new commits since the base; review whether status changed.');
  return {
    statement: fit(head, subjects, tail, Math.max(0, commitCount - log.length)),
    source: { kind: 'git', base },
    basis: { label, base, head: project.head, commitCount, changedFiles: changed.length, uncommitted: pending.length, carried, notes },
  };
}

export function structure(root, ref, run = git) {
  const paths = quiet(() => run(root, ['ls-tree', '-r', '-z', '--name-only', ref]).split('\0').filter(Boolean), null);
  if (paths) {
    const dirs = new Map(); const files = [];
    for (const path of paths) {
      const [first, ...rest] = path.split('/');
      if (rest.length) dirs.set(first, (dirs.get(first) ?? 0) + 1); else files.push(first);
    }
    return { dirs, files, counted: true };
  }
  // Very large trees overflow the bounded Git output: list the top level only, without counts.
  const top = quiet(() => run(root, ['ls-tree', '-z', ref]).split('\0').filter(Boolean), null);
  if (!top) return null;
  const dirs = new Map(); const files = [];
  for (const entry of top) {
    const tab = entry.indexOf('\t'); if (tab < 0) continue; const meta = entry.slice(0, tab); const name = entry.slice(tab + 1);
    if (meta.split(' ')[1] === 'tree') dirs.set(name, null); else files.push(name);
  }
  return { dirs, files, counted: false };
}

export function describeStructure({ dirs, files }) {
  const listed = [...dirs].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0) || (a[1] === null && b[1] === null ? a[0].startsWith('.') - b[0].startsWith('.') : 0) || a[0].localeCompare(b[0])).slice(0, 10)
    .map(([dir, count]) => count === null ? dir : `${dir} (${count})`);
  const top = files.filter(name => MANIFESTS.test(name)).slice(0, 5);
  return `${listed.join(', ') || 'no directories'}${top.length ? `; key files: ${top.join(', ')}` : ''}`;
}

function readmePurpose(root) {
  const name = quiet(() => git(root, ['ls-tree', '--name-only', 'HEAD']).split('\n').find(file => /^README(?:\.md|\.txt)?$/i.test(file)), null);
  if (!name) return null;
  const text = quiet(() => git(root, ['show', `HEAD:${name}`]), '');
  const line = text.split(/\r?\n/).map(value => value.trim()).find(value => value && !/^(?:#|!|\[|<|```|>|\||-{3,}|={3,})/.test(value));
  return line && safe(line) ? (line.length > 300 ? `${line.slice(0, 299)}…` : line) : null;
}

export function overviewDraft(project, previous) {
  const { root } = project; const notes = [];
  if (!project.head) throw new Error('A repo overview requires at least one commit');
  const now = structure(root, 'HEAD');
  if (!now) throw new Error('Journal could not read the file list of this repository; try again or write the overview by hand');
  if (!now.counted) notes.push('This repository is too large to count files per directory; the structure line lists top-level entries only.');
  const recorded = previous?.source?.kind === 'git' ? previous.source.head : previous?.source?.commit;
  const base = recorded && isCommit(root, recorded) && isAncestor(root, recorded) ? recorded : null;
  const structureChanges = [];
  if (base) {
    const before = structure(root, base);
    for (const dir of now.dirs.keys()) if (!before?.dirs.has(dir)) structureChanges.push(`Added ${dir}/`);
    for (const dir of before?.dirs.keys() ?? []) if (!now.dirs.has(dir)) structureChanges.push(`Removed ${dir}/`);
    const changed = quiet(() => git(root, ['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean), []);
    for (const path of changed) if (!path.includes('/') && MANIFESTS.test(path)) structureChanges.push(`Changed ${path}`);
  } else if (previous) notes.push('The previous overview has no commit in this history; review the whole overview.');
  const structureLine = `Structure: ${describeStructure(now)}`;
  let statement;
  if (previous) {
    statement = /^Structure:.*$/m.test(previous.statement) ? previous.statement.replace(/^Structure:.*$/m, structureLine) : `${previous.statement}\n${structureLine}`;
  } else {
    const purpose = readmePurpose(root);
    if (!purpose) notes.push('No README purpose line was found.');
    statement = [`Purpose: ${purpose ?? '[describe what this repo delivers and for whom]'}`, structureLine,
      'Constraints: [describe decisions the next session must preserve]'].join('\n');
  }
  const unchanged = !!base && !structureChanges.length;
  if (unchanged) notes.push(`No structural changes since ${short(base)}; the overview may not need a revision.`);
  return {
    statement: statement.slice(0, MAX_STATEMENT),
    source: { kind: 'git', base },
    basis: { label: base ? `the last overview (${short(base)})` : 'the current checkout', base, head: project.head, structureChanges, unchanged, notes },
  };
}
