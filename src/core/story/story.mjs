import { classifyCommand, commitMessage, MILESTONES, rank } from './classify.mjs';

// The Story: a deterministic presentation of a session's recorded events (docs/STORY.md).
// events (oldest first) in → { turns, plan, waiting, counts } out. No model, no clock, no
// guessing: titles come from a fixed vocabulary, metadata only from counts, paths, exit codes
// and structured fields the provider sent (command descriptions, plan items). The same events
// always give the same Story.

// Phase classes, in the order a turn usually goes through them.
const CLASS_OF = { explore: 'investigate', search: 'investigate', 'git-inspect': 'investigate', web: 'investigate', edit: 'change', create: 'change', delete: 'change',
  install: 'install', test: 'test', build: 'build', commit: 'commit', push: 'push', pr: 'pr', ci: 'ci', agent: 'agent', script: 'other', git: 'other' };
export const phaseClass = category => CLASS_OF[category] ?? null;

// ---- Results ------------------------------------------------------------------------------
// What one recorded exit status proves about each simple command in the line. The shell model:
// a line is lists separated by ; or & (or newlines); a list is pipelines joined by && and ||
// (left to right); a pipeline's status is its last command's (no pipefail). The line's status
// is the last list's, and only if that list is not run in the background.
//   Exit 0: in the last list, every pipeline after the last || ran and passed (all of them when
//   there is no ||); only a pipeline's last command is proven, and never a negated one (!).
//   Failure: in a last list joined only by &&, the failing pipeline is the only one whose last
//   command could fail (noise such as cd, echo or a plain assignment is assumed not to fail);
//   with || or with several candidates, nothing is pinned.
//   A command inside $(...), in an earlier list, or in a cut-off line is unknown.
export function partResults(parts, status) {
  const results = parts.map(() => status === 'interrupted' ? 'interrupted' : status === 'running' ? 'running' : 'unknown');
  if (status !== 'succeeded' && status !== 'failed') return results;
  if (parts.some(part => part.truncated)) return results;
  const outer = parts.map((part, index) => ({ part, index })).filter(({ part }) => !part.inner);
  if (!outer.length) return results;
  // The last list: after the last ; or & before the end.
  let from = 0;
  outer.forEach(({ part }, position) => { if (position < outer.length - 1 && (part.next === ';' || part.next === '&')) from = position + 1; });
  const list = outer.slice(from);
  if (list.at(-1).part.next === '&') return results;
  // Its pipelines, and the connectors between them.
  const pipelines = []; let current = [];
  for (const entry of list) { current.push(entry); if (entry.part.next !== '|') { pipelines.push(current); current = []; } }
  const connectors = pipelines.slice(0, -1).map(pipeline => pipeline.at(-1).part.next);
  const lastOf = pipeline => pipeline.at(-1);
  if (status === 'succeeded') {
    const lastOr = connectors.lastIndexOf('||');
    pipelines.slice(lastOr === -1 ? 0 : lastOr + 2).forEach(pipeline => { const { part, index } = lastOf(pipeline); if (!part.negated) results[index] = 'passed'; });
  } else if (connectors.every(connector => connector === '&&')) {
    const candidates = pipelines.filter(pipeline => !lastOf(pipeline).part.safe);
    if (candidates.length === 1 && !lastOf(candidates[0]).part.negated) results[lastOf(candidates[0]).index] = 'failed';
  }
  return results;
}

// ---- Atoms ---------------------------------------------------------------------------------
// Every recorded event becomes at most a few atoms: { category, at, endAt, status, label, ... }.
const shortCommand = words => words.join(' ').replace(/\s+/g, ' ').slice(0, 80);
const statusOf = end => !end ? 'running' : end.body.status ?? 'unknown';
const FILE_OPS = { add: 'create', create: 'create', delete: 'delete', remove: 'delete' };

export function atomsOf(events) {
  const list = Array.isArray(events) ? events : [];
  const ends = new Map();
  for (const event of list) if (event?.kind === 'command-end' && event.body?.toolUseId) ends.set(event.body.toolUseId, event);
  const atoms = [];
  list.forEach((event, order) => {
    if (!event || typeof event.kind !== 'string') return;
    const b = event.body ?? {}; const at = event.at;
    switch (event.kind) {
      case 'prompt': atoms.push({ category: 'turn', at, order }); break;
      case 'turn-end': atoms.push({ category: 'turn-end', at, order, outcome: b.outcome ?? 'completed' }); break;
      case 'permission': atoms.push({ category: 'approval', at, order, tool: b.tool ?? null, label: b.command ?? b.path ?? b.tool ?? 'approval' }); break;
      case 'plan': atoms.push({ category: 'plan', at, order, items: Array.isArray(b.items) ? b.items : [] }); break;
      case 'file': {
        const op = FILE_OPS[b.op] ?? (b.tool === 'Write' ? 'write' : 'edit');
        atoms.push({ category: op === 'create' ? 'create' : op === 'delete' ? 'delete' : 'edit', at, endAt: at, order, status: 'passed', files: [{ path: b.path, op }], label: `${b.tool ?? 'Edit'} ${b.path}` });
        break;
      }
      case 'tool': {
        const tool = String(b.tool ?? '');
        // Known tools by name; MCP tools count as commands; anything else (asking the user,
        // searching for tools, messages) is not work on the project and stays in Details only.
        const category = /^(?:Read|NotebookRead|read_file)$/i.test(tool) ? 'explore' : /^(?:Grep|Glob|LS|Search|codebase_search|file_search|grep_search|list_dir)$/i.test(tool) ? 'search'
          : /^(?:WebFetch|WebSearch|web_search|fetch)$/i.test(tool) ? 'web' : /^(?:Agent|Task)$/.test(tool) ? 'agent' : /^mcp__/.test(tool) ? 'script' : 'noise';
        atoms.push({ category, at, endAt: at, order, status: b.failed ? 'failed' : 'passed', reads: category === 'explore' && b.path ? [b.path] : [], tool: /^mcp__/.test(tool) ? `MCP ${tool.split('__')[1] ?? ''}`.trim() : tool,
          label: b.description ?? (b.path ? `${tool} ${b.path}` : tool), description: b.description ?? null });
        break;
      }
      case 'command-start': {
        const end = ends.get(b.toolUseId); const status = statusOf(end);
        const command = String(b.command ?? '');
        const parts = classifyCommand(command); const results = partResults(parts, status);
        const description = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 80) : null;
        const base = { at, endAt: end?.at ?? null, order, command, description, exitCode: end?.body.exitCode ?? null, commandStatus: status, durationMs: end?.body.durationMs ?? null };
        const significant = parts.map((part, i) => ({ part, result: results[i] })).filter(({ part }) => part.category !== 'noise');
        if (!significant.length) { atoms.push({ ...base, category: 'noise', status: results[0] ?? 'unknown', label: description ?? shortCommand(parts[0]?.words ?? [command]) }); break; }
        const reads = significant.filter(({ part }) => part.category === 'explore').flatMap(({ part }) => part.paths ?? []);
        const files = significant.filter(({ part }) => ['edit', 'create', 'delete'].includes(part.category)).flatMap(({ part }) => (part.paths?.length ? part.paths : [null]).map(path => ({ path, op: part.category === 'edit' ? 'write' : part.category })));
        const milestones = significant.filter(({ part }) => MILESTONES.has(part.category));
        if (milestones.length) {
          // One atom per milestone; reads and file changes in the same line ride on the first.
          milestones.forEach(({ part, result }, i) => atoms.push({ ...base, category: part.category, status: result, part, label: description && milestones.length === 1 ? description : shortCommand(part.words),
            reads: i ? [] : reads, files: i ? [] : files, message: part.category === 'commit' ? commitMessage(command) : null }));
        } else {
          const top = significant.reduce((best, entry) => rank(entry.part.category) < rank(best.part.category) ? entry : best);
          atoms.push({ ...base, category: top.part.category, status: top.result, part: top.part, label: description ?? shortCommand(top.part.words), reads, files,
            searches: significant.filter(({ part }) => part.category === 'search').length });
        }
        break;
      }
      default: break;
    }
  });
  return atoms;
}

// ---- Phases --------------------------------------------------------------------------------
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return null;
  const s = Math.round(ms / 1000); if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); const r = s % 60; if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60); return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
const span = atoms => {
  const starts = atoms.map(a => Date.parse(a.at)).filter(Number.isFinite);
  const ends = atoms.map(a => Date.parse(a.endAt ?? a.at)).filter(Number.isFinite);
  return starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : null;
};
const lastKnown = runs => [...runs].reverse().find(a => a.status === 'passed' || a.status === 'failed')?.status ?? null;
const failedCount = atoms => atoms.filter(a => a.status === 'failed').length;

// Distinct file paths an atom list read, and changed by operation.
function fileSets(atoms) {
  const read = new Set(); const changed = new Set(); const created = new Set(); const deleted = new Set(); let unnamed = 0;
  for (const atom of atoms) {
    for (const path of atom.reads ?? []) read.add(path);
    for (const file of atom.files ?? []) {
      if (!file.path) { unnamed++; continue; }
      if (file.op === 'create') created.add(file.path); else if (file.op === 'delete') deleted.add(file.path); else changed.add(file.path);
    }
  }
  for (const path of created) changed.delete(path);
  for (const path of deleted) { changed.delete(path); created.delete(path); }
  return { read, changed, created, deleted, unnamed };
}

const CI_RESULT = (atom) => {
  if (atom.part?.semantics === 'pr-checks') return atom.status === 'passed' ? 'passed' : atom.status === 'failed' ? atom.exitCode === 8 ? 'pending' : 'failed' : null;
  if (atom.part?.semantics === 'exit-status') return atom.status === 'passed' ? 'passed' : atom.status === 'failed' ? 'failed' : null;
  return null;
};
const BUILD_ORDER = ['typecheck', 'lint', 'build'];

// One phase: { key, title, status, meta: string[], at, endAt, items }.
export function describePhase(kind, atoms, extra = []) {
  const all = [...atoms, ...extra]; const time = duration(span(all));
  const meta = []; let title; let status = 'neutral';
  const sets = fileSets(all); const searches = all.reduce((n, a) => n + (a.category === 'search' ? Math.max(1, a.searches ?? 1) : (a.searches ?? 0)), 0);
  const failures = failedCount(all.filter(a => !['test', 'build', 'commit', 'push', 'ci', 'pr', 'install'].includes(a.category)));
  switch (kind) {
    case 'investigate': {
      title = 'Investigated';
      const reads = all.filter(a => a.category === 'explore').length;
      if (sets.read.size) meta.push(plural(sets.read.size, 'file read', 'files read')); else if (reads) meta.push(plural(reads, 'read'));
      if (searches) meta.push(plural(searches, 'search', 'searches'));
      const git = all.filter(a => a.category === 'git-inspect').length; if (git) meta.push(plural(git, 'git check'));
      const web = all.filter(a => a.category === 'web').length; if (web) meta.push(plural(web, 'web request'));
      break;
    }
    case 'change': {
      title = 'Implemented changes';
      if (sets.changed.size) meta.push(plural(sets.changed.size, 'file changed', 'files changed'));
      if (sets.created.size) meta.push(`${sets.created.size} created`);
      if (sets.deleted.size) meta.push(`${sets.deleted.size} deleted`);
      if (!sets.changed.size && !sets.created.size && !sets.deleted.size && sets.unnamed) meta.push(plural(sets.unnamed, 'shell write'));
      break;
    }
    case 'install': title = 'Installed dependencies'; meta.push(plural(atoms.length, 'run')); break;
    case 'test': {
      title = 'Ran tests'; const passed = atoms.filter(a => a.status === 'passed').length; const failed = atoms.filter(a => a.status === 'failed').length;
      const unknown = atoms.length - passed - failed; meta.push(plural(atoms.length, 'run'));
      if (passed) meta.push(`${passed} passed`); if (failed) meta.push(`${failed} failed`);
      const running = atoms.filter(a => a.status === 'running').length; const hidden = unknown - running;
      if (running) meta.push('running'); if (hidden) meta.push(passed || failed || running ? `${hidden} unknown` : 'result not visible');
      const last = lastKnown(atoms); status = last === 'failed' ? 'failed' : last === 'passed' ? 'passed' : 'unknown';
      break;
    }
    case 'build': {
      const kinds = BUILD_ORDER.filter(k => atoms.some(a => (a.part?.kind ?? 'build') === k));
      title = kinds.length === 1 ? { typecheck: 'Type-checked', lint: 'Linted', build: 'Built' }[kinds[0]] : 'Checked build';
      if (kinds.length > 1) meta.push(kinds.join(' · '));
      const passed = atoms.filter(a => a.status === 'passed').length; const failed = atoms.filter(a => a.status === 'failed').length;
      meta.push(plural(atoms.length, 'run')); if (failed) meta.push(`${failed} failed`); else if (passed === atoms.length) meta.push(atoms.length === 1 ? 'passed' : 'all passed');
      const last = lastKnown(atoms); status = last === 'failed' ? 'failed' : last === 'passed' ? 'passed' : 'unknown';
      break;
    }
    case 'commit': {
      const done = atoms.filter(a => a.status !== 'failed'); const last = atoms.at(-1);
      // Committed only when an exit status proves it; otherwise the command is named, not its effect.
      title = last.status === 'failed' ? 'Commit failed' : last.status === 'passed' ? 'Committed changes' : 'Ran git commit'; status = last.status === 'failed' ? 'failed' : last.status === 'passed' ? 'passed' : 'unknown';
      const message = [...atoms].reverse().find(a => a.message)?.message;
      if (atoms.length > 1) meta.push(plural(done.length || atoms.length, 'commit'));
      if (message) meta.push(message);
      break;
    }
    case 'push': {
      const last = atoms.at(-1); title = last.status === 'failed' ? 'Push failed' : last.status === 'passed' ? 'Pushed' : 'Ran git push'; status = last.status === 'failed' ? 'failed' : last.status === 'passed' ? 'passed' : 'unknown';
      const target = [last.part?.remote, last.part?.ref].filter(Boolean).join(' '); if (target) meta.push(target);
      if (atoms.length > 1) meta.push(plural(atoms.length, 'push', 'pushes'));
      break;
    }
    case 'pr': {
      const last = atoms.at(-1); const action = last.part?.action;
      title = last.status === 'failed' ? 'Pull request command failed' : last.status !== 'passed' ? `Ran gh pr ${action ?? ''}`.trim() : action === 'merge' ? 'Merged pull request' : action === 'create' ? 'Opened pull request' : 'Updated pull request';
      status = last.status === 'failed' ? 'failed' : last.status === 'passed' ? 'passed' : 'unknown';
      break;
    }
    case 'ci': {
      const results = atoms.map(CI_RESULT); const last = [...results].reverse().find(Boolean) ?? null;
      title = last === 'passed' ? 'CI passed' : last === 'failed' ? 'CI failed' : last === 'pending' ? 'CI pending' : 'Checked CI';
      status = last === 'passed' ? 'passed' : last === 'failed' ? 'failed' : 'unknown';
      meta.push(plural(atoms.length, 'check'));
      break;
    }
    case 'agent': title = 'Ran sub-agents'; meta.push(plural(atoms.length, 'sub-agent')); break;
    default: {
      title = 'Ran commands'; meta.push(plural(atoms.length, 'command'));
      const tools = [...new Set(atoms.map(a => a.part?.tool ?? a.tool).filter(Boolean))].slice(0, 2); if (tools.length) meta.push(tools.join(', '));
    }
  }
  const others = extra.filter(a => phaseClass(a.category) === 'other').length;
  if (others && kind !== 'other') meta.push(plural(others, 'other command'));
  if (failures && !['test', 'build', 'commit', 'push', 'ci', 'pr'].includes(kind)) { meta.push(`${failures} failed`); status = 'failed'; }
  // A milestone whose result the exit status cannot prove says so.
  if (['commit', 'push', 'pr'].includes(kind) && status === 'unknown' && atoms.at(-1).status !== 'running') meta.push('result unknown');
  // The row shows at most three parts and the duration; the full line is kept for a tooltip.
  // A failure is never the part that is left out.
  const shown = meta.slice(0, 3); const failure = meta.slice(3).find(part => / failed$/.test(part));
  if (failure) shown[2] = failure;
  const summary = [...shown, ...(time && !['commit', 'push', 'pr'].includes(kind) ? [time] : [])];
  if (time && !['commit', 'push', 'pr'].includes(kind)) meta.push(time);
  const items = all.slice().sort((a, b) => a.order - b.order).map(a => ({ at: a.at, label: a.label, status: a.status ?? 'unknown', category: a.category, command: a.command ?? null }));
  // One phase of each kind per turn: the kind is a stable key (event positions shift).
  return { key: kind, kind, title, status, meta, summary, at: all[0]?.at ?? null, endAt: all.at(-1)?.endAt ?? all.at(-1)?.at ?? null, items };
}

// The deterministic fallback: a turn's atoms → phases, one per class, in order of first
// occurrence. Investigation after other work (re-reading while fixing) belongs to that work.
// Unclassified commands belong to the phase they happen in; before any phase they wait for the
// first one, and only a turn with nothing else shows them as their own "Ran commands" row.
export function phasesOf(atoms) {
  const groups = new Map(); const extras = new Map(); let current = null; let first = null; const waiting = [];
  const open = kind => {
    if (!groups.has(kind)) { groups.set(kind, []); extras.set(kind, []); }
    if (!first) { first = kind; extras.get(kind).push(...waiting.splice(0)); }
    return kind;
  };
  for (const atom of atoms) {
    const kind = phaseClass(atom.category); if (!kind) continue;
    if (kind === 'other') { if (current) extras.get(current).push(atom); else if (first) extras.get(first).push(atom); else waiting.push(atom); continue; }
    if (kind === 'investigate') { if (current) extras.get(current).push(atom); else groups.get(open('investigate')).push(atom); continue; }
    current = open(kind); groups.get(kind).push(atom);
  }
  if (waiting.length) { groups.set('other', waiting); extras.set('other', []); }
  return [...groups.keys()].filter(kind => groups.get(kind).length).map(kind => describePhase(kind, groups.get(kind), extras.get(kind)));
}

// ---- Plan ----------------------------------------------------------------------------------
// A plan item's line: the most telling evidence first, at most three parts.
function planMeta(atoms) {
  if (!atoms.length) return [];
  const sets = fileSets(atoms); const parts = [];
  const tests = atoms.filter(a => a.category === 'test'); const builds = atoms.filter(a => a.category === 'build');
  const testLast = lastKnown(tests); const buildLast = lastKnown(builds);
  if (testLast === 'failed') parts.push('tests failed'); if (buildLast === 'failed') parts.push('build failed');
  const changed = sets.changed.size + sets.created.size + sets.deleted.size; if (changed) parts.push(plural(changed, 'file changed', 'files changed'));
  if (testLast === 'passed') parts.push('tests passed'); else if (tests.length && !testLast) parts.push(plural(tests.length, 'test run'));
  if (buildLast === 'passed') parts.push('build passed');
  const commit = atoms.filter(a => a.category === 'commit' && a.status !== 'failed').at(-1); if (commit) parts.push(commit.message ? `committed: ${commit.message}` : 'committed');
  if (atoms.some(a => a.category === 'push' && a.status === 'passed')) parts.push('pushed');
  const reads = sets.read.size || atoms.filter(a => a.category === 'explore').length; if (reads) parts.push(plural(reads, 'read'));
  return parts.slice(0, 3);
}
const PLAN_STATUS = { completed: 'done', in_progress: 'active', pending: 'pending', removed: 'removed' };

// ---- Story ---------------------------------------------------------------------------------
// An isolated session's environment, from its 'environment' events: fixed titles, facts only.
const shortSha = sha => typeof sha === 'string' ? sha.slice(0, 7) : '';
const countOf = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function isolationOf(events) {
  const rows = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.kind !== 'environment') continue; const b = event.body ?? {};
    const row = (title, meta, status = 'neutral') => rows.push({ key: `environment:${rows.length}`, kind: 'environment', title, status, meta: meta.filter(Boolean), summary: meta.filter(Boolean), at: event.at, items: [] });
    switch (b.action) {
      case 'created': row(`Isolated from ${b.logicalBranch ?? 'its branch'}`, [b.base ? `at ${shortSha(b.base)}` : null]); break;
      case 'result': row('Result saved', [countOf(Number(b.files ?? 0), 'file'), b.excluded ? `${b.excluded} left out (sensitive names)` : null]); break;
      case 'applied': row(`Applied to ${b.branch ?? 'its branch'}`, [b.commit ? `commit ${shortSha(b.commit)}` : null, countOf(Number(b.files ?? 0), 'file')], 'passed'); break;
      case 'conflict': row('Conflict with its branch', [countOf(Number(b.paths ?? 0), 'file'), 'nothing applied'], 'failed'); break;
      case 'updated': row('Took in its branch', [b.to ? `at ${shortSha(b.to)}` : null, b.conflicts ? `${countOf(Number(b.conflicts), 'conflict')} to resolve here` : 'no conflicts'], b.conflicts ? 'failed' : 'neutral'); break;
      case 'abandoned': row('Set aside', ['result kept']); break;
      case 'restored': row('Restored', ['ready to apply']); break;
      case 'cleanup-pending': row('Cleanup waiting', [typeof b.reason === 'string' ? b.reason.slice(0, 80) : null]); break;
      case 'cleaned': row('Folder cleaned up', [b.hasResult === false ? null : 'result kept']); break;
      default: break;
    }
  }
  return rows;
}

export function buildStory(events) {
  const atoms = atomsOf(events);
  const turns = []; let turn = null; let hidden = 0;
  let plan = null; let active = null; const byItem = new Map(); const order = []; const titles = new Map();
  const newTurn = atom => { turn = { index: turns.length + 1, at: atom?.at ?? null, endAt: null, outcome: null, atoms: [], approvals: 0 }; turns.push(turn); };
  for (const atom of atoms) {
    // A new prompt ends the plan item's claim: work in this turn belongs to an item only after
    // the agent marks one in progress again.
    if (atom.category === 'turn') { newTurn(atom); active = null; continue; }
    if (atom.category === 'plan') {
      plan = atom.items.map(item => ({ id: String(item.id ?? item.title), title: String(item.title ?? '').slice(0, 120), status: item.status }));
      for (const item of plan) { if (!byItem.has(item.id)) { byItem.set(item.id, []); order.push(item.id); } titles.set(item.id, item.title); }
      active = plan.find(item => item.status === 'in_progress')?.id ?? null;
      continue;
    }
    if (!turn) newTurn(null);
    if (atom.category === 'turn-end') { turn.endAt = atom.at; turn.outcome = atom.outcome; continue; }
    if (atom.category === 'approval') { turn.approvals++; continue; }
    if (atom.category === 'noise') { hidden++; continue; }
    if (active && byItem.has(active)) byItem.get(active).push(atom); else turn.atoms.push(atom);
  }
  // Waiting: the last approval request with nothing after it.
  const lastApproval = atoms.findLastIndex(a => a.category === 'approval');
  const waiting = lastApproval >= 0 && !atoms.slice(lastApproval + 1).some(a => !['approval', 'noise', 'plan'].includes(a.category)) ? { tool: atoms[lastApproval].tool, label: atoms[lastApproval].label } : null;
  // The latest plan's items, plus any item that left the plan after work was done under it
  // (shown as removed, so its work is never lost).
  const planRows = plan?.length || [...byItem.values()].some(list => list.length) ? order.filter(id => plan?.some(item => item.id === id) || byItem.get(id)?.length).map(id => {
    const item = plan?.find(entry => entry.id === id) ?? { id, title: titles.get(id) ?? id, status: 'removed' }; const itemAtoms = byItem.get(id) ?? [];
    const meta = planMeta(itemAtoms);
    return { key: `plan:${id}`, kind: 'plan', title: item.title, status: PLAN_STATUS[item.status] ?? 'pending', meta, summary: meta, at: itemAtoms[0]?.at ?? null,
      items: itemAtoms.map(a => ({ at: a.at, label: a.label, status: a.status ?? 'unknown', category: a.category, command: a.command ?? null })) };
  }) : null;
  const storyTurns = turns.map(t => ({ index: t.index, at: t.at, endAt: t.endAt, outcome: t.outcome, approvals: t.approvals, phases: phasesOf(t.atoms) }));
  const commands = atoms.filter(a => a.command !== undefined).length;
  return { isolation: isolationOf(events), plan: planRows?.length ? planRows : null, turns: storyTurns, waiting, counts: { events: Array.isArray(events) ? events.length : 0, commands, hidden } };
}
