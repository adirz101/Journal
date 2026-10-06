import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commandParts } from '../src/core/story/shell.mjs';
import { classifyCommand, commitMessage } from '../src/core/story/classify.mjs';
import { atomsOf, buildStory, partResults } from '../src/core/story/story.mjs';
import { planItems } from '../src/runtime/adapters/common.mjs';

// Event builders in Journal's timeline shape (src/core/terminal.mjs records these).
let clock = Date.parse('2026-10-06T10:00:00.000Z');
const at = (seconds = 1) => new Date(clock += seconds * 1000).toISOString();
let ids = 0;
const prompt = () => ({ kind: 'prompt', at: at(), body: {} });
const turnEnd = (outcome = 'completed') => ({ kind: 'turn-end', at: at(), body: { outcome } });
// A command and its end: status succeeded (exit 0), failed (exit n), unknown or running (no end).
function run(command, { exit = 0, status, description, seconds = 1 } = {}) {
  const toolUseId = `t${++ids}`; const start = { kind: 'command-start', at: at(), body: { toolUseId, command, cwd: '.', background: false, ...(description ? { description } : {}) } };
  if (status === 'running') return [start];
  const result = status ?? (exit === 0 ? 'succeeded' : 'failed');
  return [start, { kind: 'command-end', at: at(seconds), body: { toolUseId, status: result, exitCode: result === 'succeeded' ? 0 : result === 'failed' ? exit : null, durationMs: seconds * 1000 } }];
}
const edit = (path, tool = 'Edit', op) => ({ kind: 'file', at: at(), body: { path, tool, ...(op ? { op } : {}) } });
const tool = (name, body = {}) => ({ kind: 'tool', at: at(), body: { tool: name, ...body } });
const plan = items => ({ kind: 'plan', at: at(), body: { items: items.map(([title, status], i) => ({ id: String(i + 1), title, status })) } });
const permission = (command) => ({ kind: 'permission', at: at(), body: { tool: 'Bash', command } });
const phases = story => story.turns.flatMap(t => t.phases);
const titles = story => phases(story).map(p => p.title);
const line = phase => `${phase.title} — ${phase.summary.join(' · ')}`;
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/story/${name}`, import.meta.url), 'utf8'));

// ---- Shell reading -------------------------------------------------------------------------
test('shell: connectors, quotes, substitutions, redirections and heredoc bodies', () => {
  const parts = commandParts(`cd /w && grep -rn "a && b" src | head -5; F=$(git ls-files) echo ok 2>&1 >/dev/null; cat > out.txt <<'EOF'\nnot; a && command\nEOF\nnpm test`);
  assert.deepEqual(parts.map(p => [p.words[0] ?? null, p.next]), [['cd', '&&'], ['grep', '|'], ['head', ';'], ['echo', ';'], ['cat', ';'], ['npm', null]]);
  assert.deepEqual(parts[1].words, ['grep', '-rn', 'a && b', 'src'], 'A quoted && is a word');
  assert.deepEqual(parts[3].assignments, ['F=$(git ls-files)']); assert.deepEqual(parts[3].subs, ['git ls-files']);
  assert.deepEqual(parts[3].writes, [], '>/dev/null and 2>&1 write no file');
  assert.deepEqual(parts[4].writes, ['out.txt'], 'The heredoc body is not read as commands');
  assert.equal(commandParts('cat <<EOF\nnever closed').endedInHeredoc, true);
});

// ---- Classification ------------------------------------------------------------------------
test('classification: fixed categories from the command text alone', () => {
  const top = command => { const parts = classifyCommand(command).filter(p => p.category !== 'noise'); return parts.map(p => p.category).join(','); };
  const cases = {
    'cd src': '', pwd: '', 'echo done': '', 'export A=1': '', 'sleep 2': '',
    'cat a.ts': 'explore', 'sed -n 1,80p src/a.ts': 'explore', 'head -n 20 README.md': 'explore', 'ls -la': 'explore', 'wc -l src/x.ts': 'explore',
    'grep -rn foo src': 'search', 'rg -n foo': 'search', 'find . -name "*.ts"': 'search',
    'git status': 'git-inspect', 'git diff --stat': 'git-inspect', 'git log --oneline -5': 'git-inspect', 'gh pr view 3': 'git-inspect',
    'sed -i "" s/a/b/ src/x.css': 'edit', 'echo x > notes.txt': 'edit', 'cp a.txt b.txt': 'edit', 'mkdir -p out': 'create', 'touch new.md': 'create',
    'rm -rf dist': 'delete', 'git rm old.ts': 'delete',
    'npm test': 'test', 'npm run test:desktop': 'test', 'pnpm test': 'test', 'bun test': 'test', 'pytest -q': 'test', 'python3 -m pytest': 'test', 'go test ./...': 'test',
    'cargo test': 'test', 'npx vitest run': 'test', 'npx playwright test': 'test', 'node --test tests/a.test.mjs': 'test',
    'npm run build': 'build', 'npx tsc --noEmit': 'build', 'tsc -p .': 'build', 'npm run check': 'build', 'npm run lint': 'build', 'eslint src': 'build', 'cargo check': 'build', 'make': 'build',
    'npm install': 'install', 'npm ci': 'install', 'pnpm add react': 'install', 'pip install -r requirements.txt': 'install', 'go mod tidy': 'install',
    'git commit -m "x"': 'commit', 'git push origin main': 'push', 'gh pr create --fill': 'pr', 'gh pr merge 3 --merge': 'pr',
    'gh pr checks 3': 'ci', 'gh run watch 123 --exit-status': 'ci',
    'curl -s https://example.com': 'web', 'python3 script.py': 'script', './run.sh': 'script',
  };
  for (const [command, expected] of Object.entries(cases)) assert.equal(top(command), expected, command);
  // Build kinds.
  assert.equal(classifyCommand('npx tsc --noEmit')[0].kind, 'typecheck'); assert.equal(classifyCommand('npm run lint')[0].kind, 'lint'); assert.equal(classifyCommand('npm run build')[0].kind, 'build');
  // Paths read, written and removed, never guessed from variables.
  assert.deepEqual(classifyCommand('cat a.ts b.ts')[0].paths, ['a.ts', 'b.ts']);
  assert.deepEqual(classifyCommand('S=/tmp && cat > $S/x.py <<EOF\nx\nEOF').find(p => p.category === 'edit').paths, []);
  // Commit messages: -m, -am, --message=, heredoc forms.
  assert.equal(commitMessage('git commit -m "Fix terminal shortcuts"'), 'Fix terminal shortcuts');
  assert.equal(commitMessage("git commit -am 'Two lines\n\nbody'"), 'Two lines');
  assert.equal(commitMessage('git commit --message=Short'), 'Short');
  assert.equal(commitMessage(`git commit -m "$(cat <<'EOF'\nAdd the Story view\n\nBody\nEOF\n)"`), 'Add the Story view');
  assert.equal(commitMessage(`git commit -q -F - <<'EOF'\nFrom a file\nEOF`), 'From a file');
  assert.equal(commitMessage('git commit'), null);
});

test('results: one exit status proves only what the shell guarantees', () => {
  const results = (command, status) => { const parts = classifyCommand(command); return partResults(parts, status).map((r, i) => `${parts[i].category}:${r}`).join(' '); };
  assert.equal(results('cd w && npm test', 'succeeded'), 'noise:passed test:passed');
  assert.equal(results('npm test 2>&1 | tail -20', 'succeeded'), 'test:unknown explore:passed', 'A pipe hides the test exit');
  assert.equal(results('npm test; echo done', 'succeeded'), 'test:unknown noise:passed', 'After ; only the last command is proven');
  assert.equal(results('cd w && npm test', 'failed'), 'noise:unknown test:failed', 'The only command that is not noise failed');
  assert.equal(results('npm test && git commit -m x', 'failed'), 'test:unknown commit:unknown', 'Either could have failed');
  assert.equal(results('npm run build; npm test', 'failed'), 'build:unknown test:failed');
  assert.equal(results('npm test', 'interrupted'), 'test:interrupted');
  // A command cut at the recording limit proves nothing per part.
  assert.equal(results(`npm test && git push ${'x'.repeat(300)}`, 'succeeded'), 'test:unknown');
});

// ---- Story ---------------------------------------------------------------------------------
test('repeated cd commands disappear; many reads collapse into one exploration row', () => {
  const events = [prompt(), ...run('cd src'), ...run('cd ..'), ...run('cd src && pwd'),
    ...['a.ts', 'b.ts', 'c.ts', 'a.ts'].flatMap(f => run(`cd /w && sed -n 1,80p src/${f}`)), ...run('grep -rn foo src'), ...run('rg bar'), tool('Read', { path: 'src/d.ts' }), tool('Grep'), turnEnd()];
  const story = buildStory(events);
  assert.deepEqual(titles(story), ['Investigated']);
  const [row] = phases(story);
  assert.equal(row.summary[0], '4 files read', 'Distinct files: a, b, c and d');
  assert.equal(row.summary[1], '3 searches');
  assert.equal(story.counts.hidden, 3, 'Three cd-only commands are hidden, not lost');
  assert.ok(!row.items.some(item => /^cd\b/.test(item.label)));
});

test('edits collapse by file; creations and deletions are counted apart', () => {
  const events = [prompt(), ...run('cat src/a.ts'), edit('src/a.ts'), edit('src/a.ts'), edit('src/b.ts', 'MultiEdit'), edit('src/c.ts', 'Write'), edit('src/a.ts'),
    ...run('mkdir -p src/new'), ...run('rm old.txt'), ...run('cat src/b.ts'), turnEnd()];
  const story = buildStory(events);
  assert.deepEqual(titles(story), ['Investigated', 'Implemented changes']);
  assert.equal(line(phases(story)[1]).replace(/ · \d+s$/, ''), 'Implemented changes — 3 files changed · 1 created · 1 deleted');
});

test('test runs are counted; a failed run stays visible; the last result decides the row', () => {
  const events = [prompt(), edit('src/a.ts'), ...run('npm test', { exit: 1 }), edit('src/a.ts'), ...run('npm test', { exit: 1 }), ...run('npm test'), ...run('npm test'), turnEnd()];
  const row = phases(buildStory(events)).find(p => p.kind === 'test');
  assert.deepEqual([row.title, row.status, row.summary.slice(0, 3)], ['Ran tests', 'passed', ['4 runs', '2 passed', '2 failed']]);
  const failing = phases(buildStory([prompt(), ...run('npm test'), ...run('npm test', { exit: 1 }), turnEnd()])).find(p => p.kind === 'test');
  assert.equal(failing.status, 'failed'); assert.ok(failing.summary.includes('1 failed'));
  const piped = phases(buildStory([prompt(), ...run('npm test 2>&1 | tail -5'), turnEnd()]))[0];
  assert.deepEqual([piped.status, piped.summary[1]], ['unknown', 'result not visible'], 'Never claimed passed when the exit belongs to tail');
});

test('build, typecheck and lint are one row with their kinds', () => {
  const story = buildStory([prompt(), ...run('npx tsc --noEmit'), ...run('npm run lint', { exit: 2 }), ...run('npm run build'), turnEnd()]);
  const row = phases(story)[0];
  assert.deepEqual([row.title, row.status, row.summary.slice(0, 3)], ['Checked build', 'passed', ['typecheck · lint · build', '3 runs', '1 failed']]);
  assert.equal(phases(buildStory([prompt(), ...run('npx tsc --noEmit'), turnEnd()]))[0].title, 'Type-checked');
});

test('commit, push and pull request rows come from the commands and their exits', () => {
  const story = buildStory([prompt(), edit('a.ts'), ...run('git add -A && git commit -m "Fix terminal shortcuts" && git push -u origin claude/x'), ...run('gh pr create --fill'), turnEnd()]);
  assert.deepEqual(phases(story).map(line), ['Implemented changes — 1 file changed', 'Committed changes — Fix terminal shortcuts', 'Pushed — origin claude/x', 'Opened pull request — ']);
  const failed = buildStory([prompt(), ...run('git commit -m "x"', { exit: 1 }), turnEnd()]);
  assert.equal(phases(failed)[0].title, 'Commit failed');
  const unknown = buildStory([prompt(), ...run('git commit -m "x" 2>&1 | tail -1'), turnEnd()]);
  assert.deepEqual([phases(unknown)[0].title, phases(unknown)[0].summary], ['Ran git commit', ['x', 'result unknown']], 'Not claimed when the exit is tail\'s');
});

test('CI passes or fails only when the command proves it', () => {
  const story = commands => phases(buildStory([prompt(), ...commands, turnEnd()]))[0];
  assert.equal(story(run('gh pr checks 7 --watch')).title, 'CI passed');
  assert.equal(story(run('gh pr checks 7', { exit: 1 })).title, 'CI failed');
  assert.equal(story(run('gh pr checks 7', { exit: 8 })).title, 'CI pending');
  assert.equal(story(run('gh run watch 99 --exit-status', { exit: 1 })).title, 'CI failed');
  assert.equal(story(run('gh run watch 99')).title, 'Checked CI', 'Without --exit-status the exit says nothing about the run');
  assert.equal(story(run('gh pr checks 7 | cut -f1,2')).title, 'Checked CI', 'Piped: the exit is cut\'s');
});

test('plan items are the phases; activity attaches to the item in progress', () => {
  const events = [prompt(), plan([['Investigate issue', 'in_progress'], ['Implement fix', 'pending'], ['Run tests', 'pending']]), ...run('cat src/a.ts'), ...run('grep -rn x src'),
    plan([['Investigate issue', 'completed'], ['Implement fix', 'in_progress'], ['Run tests', 'pending']]), edit('src/a.ts'), edit('src/b.ts'),
    plan([['Investigate issue', 'completed'], ['Implement fix', 'completed'], ['Run tests', 'in_progress']]), ...run('npm test', { exit: 1 }), ...run('npm test'), turnEnd()];
  const story = buildStory(events);
  assert.deepEqual(story.plan.map(p => [p.title, p.status, p.summary.join(' · ')]), [
    ['Investigate issue', 'done', '1 read'], ['Implement fix', 'done', '2 files changed'], ['Run tests', 'active', 'tests passed']]);
  assert.deepEqual(phases(story), [], 'Everything belonged to a plan item');
  // Activity with no item in progress falls back to phases.
  const outside = buildStory([prompt(), ...run('npm install'), plan([['Ship', 'pending']]), ...run('npm test'), turnEnd()]);
  assert.deepEqual([outside.plan[0].summary, titles(outside)], [[], ['Installed dependencies', 'Ran tests']]);
});

test('without a plan: turns, fixed phase order by first occurrence, reads during work stay with the work', () => {
  const events = [prompt(), ...run('cat a.ts'), edit('a.ts'), ...run('cat b.ts'), ...run('npm test'), ...run('cat c.ts'), edit('c.ts'), turnEnd(), prompt(), ...run('git status'), turnEnd()];
  const story = buildStory(events);
  assert.deepEqual(story.turns.map(t => t.phases.map(p => p.title)), [['Investigated', 'Implemented changes', 'Ran tests'], ['Investigated']]);
  assert.equal(story.turns[0].phases[0].summary[0], '1 file read', 'Only the read before any change is investigation');
  assert.equal(story.turns[0].phases[1].summary[0], '2 files changed');
});

test('identical input gives identical output; nothing depends on the clock or input order of keys', () => {
  const events = fixture('claude-terminal-fit.json').events;
  const a = JSON.stringify(buildStory(events)); const b = JSON.stringify(buildStory(structuredClone(events)));
  assert.equal(a, b);
  const reordered = events.map(event => Object.fromEntries(Object.entries(event).reverse()));
  assert.equal(JSON.stringify(buildStory(reordered)), a);
});

test('no semantic inference: titles come from the fixed vocabulary or the agent\'s own plan', () => {
  const vocabulary = /^(?:Investigated|Implemented changes|Installed dependencies|Ran tests|Built|Type-checked|Linted|Checked build|Committed changes|Commit failed|Ran git commit|Pushed|Push failed|Ran git push|Opened pull request|Merged pull request|Updated pull request|Pull request command failed|Ran gh pr(?: \w+)?|CI passed|CI failed|CI pending|Checked CI|Ran sub-agents|Ran commands)$/;
  const events = [prompt(), ...run('grep -rn "authentication bug" src', { description: 'Find the authentication bug' }), edit('src/auth.ts'), ...run('npm test -- auth', { description: 'Run auth tests' }), turnEnd()];
  const story = buildStory(events);
  for (const phase of phases(story)) assert.match(phase.title, vocabulary, phase.title);
  assert.ok(!JSON.stringify(phases(story).map(p => [p.title, p.summary])).includes('authentication'), 'Descriptions appear only in the steps, never as a title or summary');
  assert.equal(phases(story).find(p => p.kind === 'test').items[0].label, 'Run auth tests', 'A provider description replaces the raw command in the steps');
  for (const fixtureName of ['claude-terminal-fit.json', 'codex-hooks.json', 'cursor-sparse.json']) for (const phase of phases(buildStory(fixture(fixtureName).events))) assert.match(phase.title, vocabulary, `${fixtureName}: ${phase.title}`);
});

test('approvals are counted on the turn and the open one is reported as waiting', () => {
  const events = [prompt(), permission('npm publish'), ...run('npm publish', { status: 'running' })];
  assert.equal(buildStory(events).waiting, null, 'Something happened after the request');
  const story = buildStory([prompt(), ...run('cat a.ts'), permission('rm -rf build')]);
  assert.deepEqual([story.turns[0].approvals, story.waiting?.label], [1, 'rm -rf build']);
});

test('the real Claude session reads as a short story', () => {
  const story = buildStory(fixture('claude-terminal-fit.json').events);
  assert.deepEqual(story.turns.map(t => t.phases.map(p => p.title)), [
    ['Investigated', 'Implemented changes', 'Ran tests', 'Type-checked', 'Ran git commit'], ['Checked CI', 'Ran gh pr merge']]);
  const rows = phases(story).length; assert.ok(rows >= 3 && rows <= 8, `${rows} rows`);
  // The commit line was cut at the recording limit inside its message: the commit is named, not claimed.
  assert.ok(phases(story).find(p => p.kind === 'commit').summary.includes('Terminal: the last row and column fit inside the frame'));
  assert.equal(phases(story).find(p => p.kind === 'test').summary[1], 'result not visible', 'Its test output was piped to grep');
});

test('Codex without a plan still gives a useful story; Cursor with sparse events degrades cleanly', () => {
  const codex = buildStory(fixture('codex-hooks.json').events);
  assert.equal(codex.plan, null);
  assert.deepEqual(phases(codex).map(line).map(text => text.replace(/ · \d+s$/, '')), [
    'Investigated — 2 files read · 1 search', 'Implemented changes — 2 files changed · 1 created', 'Ran tests — 2 runs · 1 passed · 1 failed', 'Committed changes — Add retry to the uploader']);
  const cursor = buildStory(fixture('cursor-sparse.json').events);
  assert.deepEqual(phases(cursor).map(p => [p.title, p.status, p.summary.join(' · ')]).map(([t, s, m]) => [t, s, m.replace(/ · \d+s$/, '')]), [
    ['Investigated', 'neutral', '1 read'], ['Implemented changes', 'neutral', '1 file changed'], ['Ran tests', 'unknown', '1 run · result not visible']]);
  assert.deepEqual(buildStory([]), { isolation: [], plan: null, turns: [], waiting: null, counts: { events: 0, commands: 0, hidden: 0 } });
  assert.deepEqual(atomsOf([null, { kind: 42 }, { kind: 'unknown-kind', at: at(), body: {} }]), []);
});

// ---- Review cases (PR #26) -----------------------------------------------------------------
test('results: earlier lists, || and & prove nothing; only commands that cannot fail are excused', () => {
  const results = (command, status) => { const parts = classifyCommand(command); return partResults(parts, status).map((r, i) => `${parts[i].category}:${r}`).join(' '); };
  assert.equal(results('cd /tmp; npm run build && npm test', 'failed'), 'noise:unknown build:unknown test:unknown', 'The build may have failed and the tests never ran');
  assert.equal(results('[ -f package.json ] && npm test', 'failed'), 'noise:unknown test:unknown', 'A test command [ can fail');
  assert.equal(results('which jq && jq . a.json', 'failed'), 'noise:unknown explore:unknown');
  assert.equal(results('F=$(git ls-files) && wc -l $F', 'failed').endsWith('explore:unknown'), true, 'An assignment that runs a command can fail');
  assert.equal(results('export A=1 && npm test', 'failed'), 'noise:unknown test:failed');
  assert.equal(results('npm test > log 2>&1 &', 'succeeded'), 'test:unknown', 'Run in the background');
  assert.equal(results('npm ci || npm install', 'succeeded'), 'install:unknown install:unknown');
  assert.equal(results('npm ci || npm install && npm test', 'succeeded'), 'install:unknown install:unknown test:passed');
  assert.equal(results('! npm test', 'succeeded'), 'test:unknown', '! inverts the status');
  assert.equal(results('cd w; npm test', 'succeeded'), 'noise:unknown test:passed');
});

test('shell: a commit heredoc with an apostrophe keeps the push after it; subshells, if, sh -c, arithmetic', () => {
  const line = `git commit -m "$(cat <<'EOF'\nFix: don't crash (again)\n\nBody\nEOF\n)" && git push origin main`;
  assert.deepEqual(classifyCommand(line).filter(p => !p.inner).map(p => p.category), ['commit', 'push']);
  assert.equal(commitMessage(line), "Fix: don't crash (again)");
  const story = buildStory([prompt(), ...run(line), turnEnd()]);
  assert.deepEqual(titles(story), ['Committed changes', 'Pushed']);
  const top = command => classifyCommand(command).filter(p => p.category !== 'noise').map(p => p.category).join(',');
  assert.equal(top('(cd web && npm test)'), 'test');
  assert.equal(top('if npm test; then echo ok; fi'), 'test');
  assert.equal(top('bash -lc "npm test"'), 'test');
  assert.equal(top('echo $(( 1 + 2 ))'), '');
  assert.equal(top('find . -name "*.tmp" -delete'), 'delete');
  assert.equal(top('git diff > changes.patch'), 'edit');
  assert.equal(partResults(classifyCommand('(cd web && npm test)'), 'succeeded').at(-1), 'passed');
  assert.equal(partResults(classifyCommand('if npm test; then echo ok; fi'), 'succeeded')[0], 'unknown');
});

test('plan items are known by title: inserting or replacing items never moves or loses work', () => {
  const snapshot = list => ({ kind: 'plan', at: at(), body: { items: planItems(list.map(([content, status]) => ({ content, status }))) } });
  const inserted = buildStory([prompt(), snapshot([['Investigate', 'completed'], ['Fix uploader', 'in_progress']]), edit('src/up.ts'),
    snapshot([['Investigate', 'completed'], ['Add retry helper', 'pending'], ['Fix uploader', 'in_progress']]), ...run('npm test'), turnEnd()]);
  assert.deepEqual(inserted.plan.map(p => [p.title, p.summary.join(' · ')]), [['Investigate', ''], ['Fix uploader', '1 file changed · tests passed'], ['Add retry helper', '']]);
  const replaced = buildStory([prompt(), snapshot([['Old task', 'in_progress']]), edit('a.ts'), ...run('npm test'), snapshot([['New task', 'pending']]), turnEnd()]);
  assert.deepEqual(replaced.plan.map(p => [p.title, p.status, p.summary.join(' · ')]), [['Old task', 'removed', '1 file changed · tests passed'], ['New task', 'pending', '']]);
  assert.equal(planItems([{ content: 'Same', status: 'pending' }, { content: 'Same', status: 'pending' }]).map(i => i.id).join(','), 'title:Same,title:Same#2');
});

test('a plan item claims work only in its own turn; an empty plan is no plan', () => {
  const story = buildStory([prompt(), plan([['Refactor', 'in_progress']]), edit('a.ts'), turnEnd('interrupted'), prompt(), ...run('git push origin main'), turnEnd()]);
  assert.deepEqual([story.plan[0].summary, story.turns[1].phases.map(p => p.title)], [['1 file changed'], ['Pushed']]);
  assert.equal(buildStory([prompt(), plan([]), ...run('cat a.ts'), turnEnd()]).plan, null);
});

test('rows keep their keys as events arrive; a running test says so', () => {
  const events = [prompt(), ...run('cat a.ts'), edit('a.ts')];
  const before = phases(buildStory(events)).map(p => p.key);
  const after = phases(buildStory([{ kind: 'start', at: at(), body: {} }, ...events, ...run('npm test', { status: 'running' })])).map(p => p.key);
  assert.deepEqual(after.slice(0, 2), before);
  assert.deepEqual(phases(buildStory([prompt(), ...run('npm test', { status: 'running' })]))[0].summary, ['1 run', 'running']);
});

test('isolation rows: fixed titles from the environment\'s events, facts only', () => {
  const ev = (action, body = {}) => ({ kind: 'environment', at: at(), body: { action, ...body } });
  const story = buildStory([ev('created', { logicalBranch: 'feature/auth', base: 'abc1234def' }), ev('result', { files: 3, excluded: 1 }), ev('conflict', { paths: 2 }),
    ev('updated', { to: '0123456789', conflicts: 1 }), ev('result', { files: 3 }), ev('applied', { branch: 'feature/auth', commit: 'fedcba98', files: 3 }), ev('cleaned')]);
  assert.deepEqual(story.isolation.map(r => `${r.status} ${r.title} — ${r.summary.join(' · ')}`), [
    'neutral Isolated from feature/auth — at abc1234', 'neutral Result saved — 3 files · 1 left out (sensitive names)', 'failed Conflict with its branch — 2 files · nothing applied',
    'failed Took in its branch — at 0123456 · 1 conflict to resolve here', 'neutral Result saved — 3 files', 'passed Applied to feature/auth — commit fedcba9 · 3 files', 'neutral Folder cleaned up — result kept']);
  assert.deepEqual(buildStory([ev('created', { logicalBranch: 'x' })]).turns, [], 'isolation events are not turns');
});
