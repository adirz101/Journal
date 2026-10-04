import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Transpiles composerModel.ts with the renderer modules it imports into one
// temporary directory, so the test runs the renderer's own code.
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'composer-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['types', 'copy', 'firstRunModel', 'composerModel']) {
    const source = readFileSync(new URL(`../src/ui/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, `${name}.mjs`), outputText.replace(/from '\.\/(types|copy|firstRunModel)'/g, "from './$1.mjs'"));
  }
  return import(pathToFileURL(join(dir, 'composerModel.mjs')).href);
}

const claude = { provider: 'claude', available: true, version: '2.1.286', state: 'ready' };
const codex = { provider: 'codex', available: true, version: '0.159.3', state: 'ready' };
const cursor = (extra = {}) => ({ provider: 'cursor', available: true, version: '2026.10.01', state: 'ready', auth: 'unknown', supports: { mode: true, login: true }, ...extra });

test('modeFlags maps Build, Plan and Read-only to today\'s launch flags', async t => {
  const { modeFlags } = await load(t);
  assert.deepEqual(modeFlags('build'), { plan: false, research: false });
  assert.deepEqual(modeFlags('plan'), { plan: true, research: false });
  assert.deepEqual(modeFlags('read-only'), { plan: false, research: true });
});

test('modeSupport blocks Codex Plan and Cursor modes without supports.mode', async t => {
  const { modeSupport, modeBlock } = await load(t);
  assert.deepEqual(modeSupport('claude', claude), { build: true, plan: true, 'read-only': true });
  assert.deepEqual(modeSupport('codex', codex), { build: true, plan: false, 'read-only': true });
  assert.deepEqual(modeSupport('cursor', cursor()), { build: true, plan: true, 'read-only': true });
  assert.deepEqual(modeSupport('cursor', cursor({ supports: { mode: false } })), { build: true, plan: false, 'read-only': false });
  assert.equal(modeBlock('codex', codex, 'plan'), 'Codex has no plan mode. Choose Build or Read-only.');
  assert.equal(modeBlock('cursor', cursor({ supports: {} }), 'read-only'), 'This Cursor version has no modes. Choose Build.');
  assert.equal(modeBlock('codex', codex, 'read-only'), null);
});

test('switching agents never changes the mode', async t => {
  // The mode belongs to the user: an agent that cannot run it blocks Start
  // with a reason instead of silently escalating to Build.
  const { startBlock } = await load(t);
  const input = { connected: true, liveCount: 0, busy: false, mode: 'plan' };
  assert.equal(startBlock({ ...input, provider: 'claude', agent: claude }), null);
  assert.equal(startBlock({ ...input, provider: 'codex', agent: codex }), 'Codex has no plan mode. Choose Build or Read-only.');
  assert.equal(startBlock({ ...input, provider: 'codex', agent: codex, mode: 'read-only' }), null);
  assert.equal(startBlock({ ...input, provider: 'cursor', agent: cursor({ supports: {} }) }), 'This Cursor version has no modes. Choose Build.');
  // composerModel exposes no function that maps an agent to a mode.
  const source = readFileSync(new URL('../src/ui/composerModel.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bonMode\b|setMode\(/);
});

test('agentCard says Signed in or Sign in needed only when the status check says so', async t => {
  // The card is Phase 7's agentRow (tests/first-run-model.test.mjs checks that they agree for
  // every state); these cases pin what a card shows.
  const { agentCard } = await load(t);
  const card = (agent, provider) => { const { sub, tone, action, quiet } = agentCard(agent, provider); return { sub, tone, action, quiet }; };
  // No answer from a status check (none ran, or none exists): neither claim, and never green.
  for (const agent of [claude, codex, { ...claude, auth: undefined }, { ...codex, auth: 'unchecked' }]) {
    const view = agentCard(agent);
    assert.doesNotMatch(view.sub, /Signed in|Sign in needed|unknown/i, agent.provider);
    assert.equal(view.tone, 'muted');
  }
  assert.equal(agentCard(claude).sub, 'Installed · 2.1.286');
  assert.equal(agentCard({ ...claude, version: null }).sub, 'Installed');
  // The probe answered: the same rules for every provider.
  const login = { supports: { login: true, authStatus: true } };
  assert.deepEqual(card({ ...claude, ...login, auth: 'signed-in' }), { sub: 'Installed · 2.1.286 · Signed in', tone: 'ok', action: null, quiet: false });
  assert.equal(agentCard({ ...codex, ...login, auth: 'signed-in' }).sub, 'Installed · 0.159.3 · Signed in');
  assert.equal(agentCard(cursor({ auth: 'signed-in' })).sub, 'Installed · 2026.10.01 · Signed in');
  assert.deepEqual(card({ ...codex, ...login, auth: 'signed-out' }), { sub: 'Installed · 0.159.3 · Sign in needed', tone: 'warn', action: 'login', quiet: false });
  assert.deepEqual(card({ ...claude, auth: 'signed-out', supports: { login: false } }), { sub: 'Installed · 2.1.286 · Sign in needed', tone: 'warn', action: null, quiet: false });
  // A check that could not conclude says so without a warning, and offers a quiet sign-in where the CLI documents it.
  assert.deepEqual(card({ ...claude, ...login, auth: 'unknown' }), { sub: 'Installed · 2.1.286 · Sign-in unknown', tone: 'muted', action: 'login', quiet: true });
  assert.deepEqual(card({ ...claude, ...login, auth: 'unchecked' }), { sub: 'Installed · 2.1.286', tone: 'muted', action: 'login', quiet: true });
  // Cursor signs in through its own CLI whenever the CLI is found.
  assert.deepEqual(card(cursor({ state: 'login-required' })), { sub: 'Installed · 2026.10.01 · Sign in needed', tone: 'warn', action: 'login', quiet: false });
  assert.deepEqual(card(cursor({ auth: 'signed-out', supports: {} })), { sub: 'Installed · 2026.10.01 · Sign in needed', tone: 'warn', action: 'login', quiet: false });
  // Install runs the official command where this platform has one, else the card offers the install page.
  const commands = (install, installPage = 'https://example.test/install') => ({ commands: { login: null, install, installPage } });
  assert.deepEqual(card({ provider: 'cursor', available: false, version: null, state: 'missing', ...commands('curl https://cursor.com/install -fsS | bash') }), { sub: 'Not installed', tone: 'muted', action: 'install', quiet: false });
  assert.deepEqual(card({ provider: 'claude', available: false, version: null, state: 'missing', ...commands('curl -fsSL https://claude.ai/install.sh | bash') }), { sub: 'Not installed', tone: 'muted', action: 'install', quiet: false });
  assert.deepEqual(card({ provider: 'codex', available: false, version: null, state: 'missing', ...commands(null) }), { sub: 'Not installed', tone: 'muted', action: 'install-page', quiet: false });
  assert.deepEqual(card({ provider: 'codex', available: false, version: null }), { sub: 'Not installed', tone: 'muted', action: null, quiet: false });
  assert.equal(agentCard(cursor({ state: 'unsupported' })).sub, 'Installed · 2026.10.01 · Unsupported version');
  assert.equal(agentCard(cursor({ state: 'not-cursor', available: false })).sub, 'Not the Cursor CLI');
  assert.equal(agentCard(cursor({ state: 'not-cursor', available: false })).action, 'install');
  assert.equal(agentCard(cursor({ state: 'unlaunchable', available: false })).sub, 'Can’t launch');
  // Detection still running: checking, for every provider.
  assert.deepEqual(card(undefined, 'codex'), { sub: 'Checking…', tone: 'muted', action: null, quiet: false });
  for (const provider of ['claude', 'codex', 'cursor']) assert.deepEqual(card({ provider, available: false, version: null, state: 'checking', auth: 'unchecked' }), { sub: 'Checking…', tone: 'muted', action: null, quiet: false });
});

test('startBlock reports runtime, slots, missing agent and mode in order', async t => {
  const { startBlock } = await load(t);
  const missing = { provider: 'codex', available: false, version: null };
  const all = { connected: false, liveCount: 4, busy: true, agent: missing, provider: 'codex', mode: 'plan' };
  assert.equal(startBlock(all), '', 'busy has no text');
  assert.equal(startBlock({ ...all, busy: false }), 'The runtime is reconnecting. Start is available again once it connects.');
  assert.equal(startBlock({ ...all, busy: false, connected: true }), '4 sessions are running. Stop one to start another.');
  assert.equal(startBlock({ ...all, busy: false, connected: true, liveCount: 3 }), 'Codex isn’t installed on this computer.');
  // With an install command or page, the reason names the card's button.
  const commands = { login: null, install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', installPage: 'https://example.test' };
  assert.equal(startBlock({ ...all, busy: false, connected: true, liveCount: 3, agent: { ...missing, state: 'missing', commands } }), 'Codex isn’t installed on this computer. Choose Install… on its card.');
  assert.equal(startBlock({ ...all, busy: false, connected: true, liveCount: 3, agent: { ...missing, state: 'missing', commands: { ...commands, install: null } } }), 'Codex isn’t installed on this computer. Choose Install page… on its card.');
  assert.equal(startBlock({ ...all, busy: false, connected: true, liveCount: 3, agent: codex }), 'Codex has no plan mode. Choose Build or Read-only.');
  assert.equal(startBlock({ ...all, busy: false, connected: true, liveCount: 3, agent: codex, mode: 'build' }), null);
  // An installed agent that needs the user first says what, not "isn't installed".
  assert.equal(startBlock({ connected: true, liveCount: 0, busy: false, agent: cursor({ state: 'login-required' }), provider: 'cursor', mode: 'build' }), 'Cursor: Sign in needed');
});

test('the default agent is the first available one, and a remembered choice wins', async t => {
  const { defaultProvider } = await load(t);
  const none = { available: false, version: null };
  assert.equal(defaultProvider([claude, codex, cursor()], null), 'claude');
  assert.equal(defaultProvider([{ ...claude, ...none }, codex, cursor()], null), 'codex');
  assert.equal(defaultProvider([{ ...claude, ...none }, { ...codex, ...none }, cursor()], null), 'cursor');
  assert.equal(defaultProvider([claude, codex], 'codex'), 'codex');
  assert.equal(defaultProvider([claude, codex], 'nonsense'), 'claude');
  assert.equal(defaultProvider(undefined, null), 'claude');
});

const note = (id, category, terms, bytes, extra = {}) => ({ id, revisionId: `${id}-r1`, revision: 1, statement: `Note ${id}`, category, scope: category === 'brief' ? 'checkout' : 'checkout', area: '', branch: null, source: { kind: 'user', note: 'x' }, status: 'active', validation: 'current', selection: { reason: 'matched', bytes, terms }, ...extra });
const selection = (extra = {}) => ({ kind: 'selection', checked: false, query: 'payment retries', branch: 'main', warnings: [], bytes: 900, terms: ['payment', 'retries'], taskNotes: 3,
  items: [note('b1', 'brief', [], 300), note('r1', 'constraint', ['payment', 'retries'], 250, { pinned: true }), note('r2', 'lesson', ['retries'], 200), note('r3', 'decision', [], 150)],
  excluded: [{ id: 'x1', reason: 'stale' }, { id: 'x2', reason: 'wrong-branch' }, { id: 'x3', reason: 'stale' }, { id: 'x4', reason: 'left-out-for-task' }], ...extra });

test('previewView groups briefs, counts matches and marks unchecked sizes with ≈', async t => {
  const { previewView, meterText } = await load(t);
  const view = previewView(selection(), ['x4']);
  assert.equal(view.checked, false);
  assert.deepEqual(view.always.map(item => item.id), ['b1']);
  assert.deepEqual(view.relevant.map(item => item.id), ['r1', 'r2', 'r3']);
  assert.equal(view.notes, 4); assert.equal(view.bytes, 900); assert.equal(view.matchCount, 2);
  assert.deepEqual([...view.matchedTerms].sort(), ['payment', 'retries']);
  assert.deepEqual(view.notIncluded, [{ reason: 'stale', count: 2 }, { reason: 'wrong-branch', count: 1 }, { reason: 'left-out-for-task', count: 1 }]);
  assert.equal(view.taskNotes, 3);
  assert.deepEqual(meterText(view), { notes: '≈4 / 12', size: '≈0.9 / 6 KB' });
  // A leave-out applies before the next reply arrives; a restore drops the left-out count at once.
  const left = previewView(selection(), ['x4', 'r2']);
  assert.deepEqual(left.relevant.map(item => item.id), ['r1', 'r3']);
  assert.deepEqual(left.notIncluded.find(entry => entry.reason === 'left-out-for-task'), { reason: 'left-out-for-task', count: 2 });
  assert.equal(left.matchCount, 1); assert.deepEqual([...left.matchedTerms].sort(), ['payment', 'retries']);
  assert.equal(previewView(selection(), []).notIncluded.some(entry => entry.reason === 'left-out-for-task'), false);
  // A full check (a preview receipt) is checked: no ≈, and it carries no taskNotes.
  const { kind, checked, taskNotes, terms, bytes, ...rest } = selection();
  const receipt = { ...rest, id: 'p', packet: 'x', state: 'prepared', estimatedTokens: 1, createdAt: 'now', preview: true };
  const full = previewView(receipt, []);
  assert.equal(full.checked, true); assert.equal(full.taskNotes, null);
  assert.deepEqual(meterText(full), { notes: '4 / 12', size: '0.9 / 6 KB' });
  assert.equal(previewView(null, []), null);
});
