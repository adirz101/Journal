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
// What one recorded command proves about each simple command in it. A shell reports one exit
// status for the whole line: exit 0 proves every command joined by && up to the end, but not one
// whose output was piped (the pipe's last command decides) or one followed by ; or ||. A failure
// is pinned on a command only when nothing else could have failed: it is the line's only command
// that is not noise (cd, echo, assignments are assumed not to fail) and nothing is piped after it,
// or it is the last command of a line joined by ; or ||.
export function partResults(parts, status) {
  // A command cut at the recording limit may have had more parts: only its overall status is known.
  if (parts.some(part => part.truncated) && status !== 'interrupted' && status !== 'running') return parts.map(() => 'unknown');
  const outer = parts.map((part, index) => ({ part, index })).filter(({ part }) => !part.inner);
  const results = parts.map(() => status === 'interrupted' ? 'interrupted' : status === 'running' ? 'running' : 'unknown');
  if (status === 'succeeded') {
    outer.forEach(({ part, index }, position) => {
      const after = outer.slice(position);
      if (part.next !== '|' && after.slice(0, -1).every(({ part: p }) => p.next === '&&')) results[index] = 'passed';
    });
  } else if (status === 'failed') {
    const chained = outer.slice(0, -1).every(({ part }) => part.next === '&&');
    const significant = outer.filter(({ part }) => part.category !== 'noise');
    if (chained) {
      if (significant.length === 1 && significant[0].part.next !== '|' && !outer.slice(outer.indexOf(significant[0])).some(({ part }) => part.next === '|')) results[significant[0].index] = 'failed';
    } else {
      const last = outer.at(-1);
      if (last && last.part.category !== 'noise') results[last.index] = 'failed';
    }
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
      if (unknown) meta.push(passed || failed ? `${unknown} unknown` : 'result not visible');
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
      title = last.status === 'failed' ? 'Commit failed' : 'Committed changes'; status = last.status === 'failed' ? 'failed' : last.status === 'passed' ? 'passed' : 'unknown';
      const message = [...atoms].reverse().find(a => a.message)?.message;
      if (atoms.length > 1) meta.push(plural(done.length || atoms.length, 'commit'));
      if (message) meta.push(message);
      break;
    }
    case 'push': {
      const last = atoms.at(-1); title = last.status === 'failed' ? 'Push failed' : 'Pushed'; status = last.status === 'failed' ? 'failed' : last.status === 'passed' ? 'passed' : 'unknown';
      const target = [last.part?.remote, last.part?.ref].filter(Boolean).join(' '); if (target) meta.push(target);
      if (atoms.length > 1) meta.push(plural(atoms.length, 'push', 'pushes'));
      break;
    }
    case 'pr': {
      const last = atoms.at(-1); const action = last.part?.action;
      title = last.status === 'failed' ? 'Pull request command failed' : action === 'merge' ? 'Merged pull request' : action === 'create' ? 'Opened pull request' : 'Updated pull request';
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
  if (['commit', 'push', 'pr'].includes(kind) && status === 'unknown') meta.push('result unknown');
  // The row shows at most three parts and the duration; the full line is kept for a tooltip.
  // A failure is never the part that is left out.
  const shown = meta.slice(0, 3); const failure = meta.slice(3).find(part => / failed$/.test(part));
  if (failure) shown[2] = failure;
  const summary = [...shown, ...(time && !['commit', 'push', 'pr'].includes(kind) ? [time] : [])];
  if (time && !['commit', 'push', 'pr'].includes(kind)) meta.push(time);
  const items = all.slice().sort((a, b) => a.order - b.order).map(a => ({ at: a.at, label: a.label, status: a.status ?? 'unknown', category: a.category, command: a.command ?? null }));
  return { key: `${kind}:${all[0]?.order ?? 0}`, kind, title, status, meta, summary, at: all[0]?.at ?? null, endAt: all.at(-1)?.endAt ?? all.at(-1)?.at ?? null, items };
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
const PLAN_STATUS = { completed: 'done', in_progress: 'active', pending: 'pending' };

// ---- Story ---------------------------------------------------------------------------------
export function buildStory(events) {
  const atoms = atomsOf(events);
  const turns = []; let turn = null; let hidden = 0;
  let plan = null; let active = null; const byItem = new Map(); const order = [];
  const newTurn = atom => { turn = { index: turns.length + 1, at: atom?.at ?? null, endAt: null, outcome: null, atoms: [], approvals: 0 }; turns.push(turn); };
  for (const atom of atoms) {
    if (atom.category === 'turn') { newTurn(atom); continue; }
    if (atom.category === 'plan') {
      plan = atom.items.map(item => ({ id: String(item.id ?? item.title), title: String(item.title ?? '').slice(0, 120), status: item.status }));
      for (const item of plan) if (!byItem.has(item.id)) { byItem.set(item.id, []); order.push(item.id); }
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
  const planRows = plan ? order.filter(id => plan.some(item => item.id === id)).map(id => {
    const item = plan.find(entry => entry.id === id); const itemAtoms = byItem.get(id) ?? [];
    const meta = planMeta(itemAtoms);
    return { key: `plan:${id}`, kind: 'plan', title: item.title, status: PLAN_STATUS[item.status] ?? 'pending', meta, summary: meta, at: itemAtoms[0]?.at ?? null,
      items: itemAtoms.map(a => ({ at: a.at, label: a.label, status: a.status ?? 'unknown', category: a.category, command: a.command ?? null })) };
  }) : null;
  const storyTurns = turns.map(t => ({ index: t.index, at: t.at, endAt: t.endAt, outcome: t.outcome, approvals: t.approvals, phases: phasesOf(t.atoms) }));
  const commands = atoms.filter(a => a.command !== undefined).length;
  return { plan: planRows, turns: storyTurns, waiting, counts: { events: Array.isArray(events) ? events.length : 0, commands, hidden } };
}
