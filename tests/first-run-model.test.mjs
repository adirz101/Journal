import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { fillDraft } from '../src/core/status.mjs';

// Phase 7 Group B: the first-run model (agent rows, draft cards) and the first-note
// claim, transpiled with the renderer modules they import so the test runs their own code.
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'first-run-model-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['types', 'copy', 'firstRunModel', 'firstNote']) {
    const source = readFileSync(new URL(`../src/ui/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, `${name}.mjs`), outputText.replace(/from '\.\/(types|copy)'/g, "from './$1.mjs'"));
  }
  return { ...await import(pathToFileURL(join(dir, 'firstRunModel.mjs')).href), ...await import(pathToFileURL(join(dir, 'firstNote.mjs')).href) };
}

const commands = (fields = {}) => ({ login: 'claude auth login', install: 'curl -fsSL https://claude.ai/install.sh | bash', installPage: 'https://code.claude.com/docs/en/setup', ...fields });
const agent = (fields = {}) => ({ provider: 'claude', state: 'ready', available: true, version: '2.1.286', auth: 'unchecked', supports: { login: true, authStatus: true }, commands: commands(), ...fields });

test('agentRow never says signed in without a probe', async t => {
  const { agentRow } = await load(t);
  for (const provider of ['claude', 'codex', 'cursor']) for (const auth of [undefined, 'unchecked', 'unknown', 'signed-out']) {
    const row = agentRow(agent({ provider, auth }));
    assert.doesNotMatch(row.sub, /Signed in/, `${provider} ${auth}`); assert.notEqual(row.tone, 'ok');
  }
  // Only a parsed probe (or Cursor's own status check) says it.
  assert.deepEqual(agentRow(agent({ auth: 'signed-in' })), { name: 'Claude Code', sub: 'Installed · 2.1.286 · Signed in', hint: null, tone: 'ok', action: null, quietLogin: false });
  // Unknown never warns: a quiet sign-in where the CLI documents one, nothing where it doesn't.
  assert.deepEqual(agentRow(agent({ auth: 'unknown' })), { name: 'Claude Code', sub: 'Installed · 2.1.286', hint: null, tone: 'muted', action: 'login', quietLogin: true });
  assert.equal(agentRow(agent({ auth: 'unknown', supports: { login: false } })).action, null);
  // Account details never reach a row: there is no field for them.
  assert.doesNotMatch(JSON.stringify(agentRow(agent({ auth: 'signed-in', email: 'a@b.c' }))), /@/);
});

test('agentRow offers install, install page or sign-in per state, one action at most', async t => {
  const { agentRow, actionName } = await load(t);
  const missing = fields => agent({ state: 'missing', available: false, version: null, ...fields });
  assert.deepEqual(agentRow(undefined, 'codex'), { name: 'Codex', sub: 'Checking…', hint: null, tone: 'muted', action: null, quietLogin: false });
  assert.equal(agentRow(agent({ state: 'checking', available: false })).sub, 'Checking…');
  const install = agentRow(missing());
  assert.deepEqual([install.sub, install.action, install.tone], ['Not installed', 'install', 'muted']);
  assert.match(install.hint, /official installer in a visible terminal/);
  // Codex on Windows (no confirmed command): the install page.
  assert.equal(agentRow(missing({ provider: 'codex', commands: commands({ install: null }) })).action, 'install-page');
  assert.equal(agentRow(missing({ commands: commands({ install: null, installPage: null }) })).action, null);
  // Signed out: an amber sign-in; without a documented sign-in, the row says where to sign in instead.
  assert.deepEqual([agentRow(agent({ provider: 'codex', auth: 'signed-out' })).sub, agentRow(agent({ provider: 'codex', auth: 'signed-out' })).tone, agentRow(agent({ provider: 'codex', auth: 'signed-out' })).action], ['Installed · 2.1.286 · Sign in needed', 'warn', 'login']);
  assert.deepEqual([agentRow(agent({ auth: 'signed-out', supports: { login: false } })).action, agentRow(agent({ auth: 'signed-out', supports: { login: false } })).hint], [null, 'Run Claude Code in a terminal and sign in there.']);
  // Cursor keeps its states and earlier sentences, and signs in whenever its CLI is found.
  const cursor = fields => agent({ provider: 'cursor', supports: { resume: true, createChat: true, mode: true }, commands: commands({ login: 'agent login', install: 'curl https://cursor.com/install -fsS | bash' }), ...fields });
  assert.deepEqual([agentRow(cursor({ state: 'login-required', auth: 'signed-out' })).action, agentRow(cursor({ state: 'login-required' })).tone], ['login', 'warn']);
  assert.equal(agentRow(cursor({ auth: 'unknown' })).quietLogin, true);
  assert.deepEqual([agentRow(cursor({ state: 'not-cursor', available: false, impostor: '/bin/agent' })).action, agentRow(cursor({ state: 'not-cursor', available: false, impostor: '/bin/agent' })).hint],
    ['install', 'An agent command at /bin/agent does not identify as the Cursor CLI, so Journal will not run it.']);
  assert.deepEqual([agentRow(cursor({ state: 'unsupported', available: false })).action, agentRow(cursor({ state: 'unsupported', available: false })).sub], [null, 'Installed · 2.1.286 · Unsupported version']);
  assert.match(agentRow(cursor({ state: 'unlaunchable', available: false, unlaunchable: { path: 'C:\\x\\agent.cmd', reason: 'a batch file' } })).hint, /cannot start it safely: a batch file/);
  // Action names are unique per provider.
  assert.deepEqual(['install', 'login', 'install-page'].map(action => actionName(action, 'Codex')), ['Install Codex…', 'Sign in to Codex…', 'Open Codex install page']);
});

const OVERVIEW = 'Purpose: A fixture project.\nStructure: src (4), tests (2); key files: README.md\nConstraints: [describe decisions the next session must preserve]';
const BRANCH = ['Completed (2 commits since branching from main (abc1234); HEAD def5678):', '- Add the welcome screen (def5678)', '- Fix: a: b (aaa1111)',
  'Changed areas: src/ui (3)', 'Uncommitted: none', 'Current work: [describe what this branch is doing now]', 'Next: [describe the next concrete step and any blocker]'].join('\n');
const CARRIED = BRANCH.replace('Current work: [describe what this branch is doing now]', 'Current work: Windows menus');

test('draftLines finds the three fields and keeps other lines verbatim', async t => {
  const { draftLines } = await load(t);
  assert.deepEqual(draftLines(OVERVIEW), [{ kind: 'text', label: 'Purpose', value: 'A fixture project.' }, { kind: 'text', label: 'Structure', value: 'src (4), tests (2); key files: README.md' }, { kind: 'field', label: 'Constraints', key: 'constraints' }]);
  const lines = draftLines(BRANCH);
  assert.deepEqual(lines.slice(0, 3).map(line => [line.kind, line.label, line.value]), [['text', null, BRANCH.split('\n')[0]], ['text', null, '- Add the welcome screen (def5678)'], ['text', null, '- Fix: a: b (aaa1111)']]);
  assert.deepEqual(lines.slice(5).map(line => line.key), ['currentWork', 'next']);
  // A carried line (not a placeholder) is text, never a field.
  assert.deepEqual(draftLines(CARRIED)[5], { kind: 'text', label: 'Current work', value: 'Windows menus' });
});

test('previewStatement equals core fillDraft', async t => {
  const { previewStatement, hasPlaceholder } = await load(t);
  const cases = [[OVERVIEW, {}], [OVERVIEW, { constraints: '  Never force-push main ' }], [BRANCH, { currentWork: 'Menus', next: 'Ship alpha 4' }], [BRANCH, { next: 'Ship' }],
    [BRANCH, {}], [CARRIED, { currentWork: 'ignored: the line is carried', next: 'Test' }], [`${BRANCH}\nNext: [describe again]`, { next: 'Both' }]];
  for (const [statement, fields] of cases) {
    assert.equal(previewStatement(statement, fields), fillDraft(statement, fields), JSON.stringify(fields));
    assert.equal(hasPlaceholder(previewStatement(statement, fields)), false);
  }
  // Edit keeps an empty field's placeholder, so the form shows the line.
  assert.match(previewStatement(BRANCH, { next: 'Ship' }, { keepEmpty: true }), /^Current work: \[describe/m);
  // A placeholder that is not a field (no README purpose line) remains: Remember stays off until Edit.
  assert.equal(hasPlaceholder(previewStatement('Purpose: [describe what this repo delivers and for whom]\nStructure: src', {})), true);
});

test('cardMeta and the facts line', async t => {
  const { cardMeta, factsLine } = await load(t);
  const basis = { label: 'the current checkout', base: null, head: '577fb89aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', notes: [], facts: { readme: 'README.md', folders: 8, commits: 93, counted: true } };
  assert.deepEqual(cardMeta({ scope: 'checkout', basis }), { badge: 'Draft', source: 'README.md · 577fb89' });
  assert.deepEqual(cardMeta({ scope: 'branch', basis: { ...basis, label: 'branching from main (abc1234)', commitCount: 1 } }).source, '1 commit since main');
  assert.deepEqual(cardMeta({ scope: 'branch', basis: { ...basis, label: 'recent history', commitCount: 3 } }).source, '3 recent commits · 577fb89');
  assert.equal(factsLine(basis.facts), 'Drafted from Git: README, 8 top-level folders, 93 commits · no AI call · nothing left this computer');
  assert.equal(factsLine(undefined), null);
});

test('claimFirstNote fires once and never for an install with notes', async t => {
  const { claimFirstNote, settleFirstNote, FIRST_NOTE_KEY } = await load(t);
  const store = (initial = {}) => { const data = new Map(Object.entries(initial)); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)) }; };
  const fresh = store();
  settleFirstNote(false, fresh); assert.equal(fresh.data.size, 0, 'a fresh install is not marked at bootstrap');
  assert.equal(claimFirstNote(false, fresh), true); assert.equal(fresh.data.get(FIRST_NOTE_KEY), '1');
  assert.equal(claimFirstNote(false, fresh), false, 'once per install');
  // An upgrading install (notes at start) is marked silently and never sees it.
  const upgraded = store(); settleFirstNote(true, upgraded);
  assert.equal(upgraded.data.get(FIRST_NOTE_KEY), '1'); assert.equal(claimFirstNote(true, upgraded), false);
  assert.equal(claimFirstNote(true, store()), false, 'notes at start never play it, even without the key');
  // Without storage, or when writing fails, it never plays (a repeated "first" would be false).
  assert.equal(claimFirstNote(false, null), false);
  assert.equal(claimFirstNote(false, { getItem: () => null, setItem: () => { throw new Error('quota'); } }), false);
  assert.equal(claimFirstNote(false, { getItem: () => { throw new Error('denied'); }, setItem: () => {} }), false);
});
