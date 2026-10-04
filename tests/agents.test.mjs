import { test } from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../src/core/agents.mjs').catch(() => ({}));
const id = 'f1b5cc71-364f-4136-bbc7-20acf06f1435';

test('agent launch builder exists', () => assert.equal(typeof module.buildAgentLaunch, 'function'));
test('Claude preassigns a fresh UUID and passes prompts as literal argv', () => {
  const prompt = 'Check $(touch /tmp/no) `echo nope` "quote"\n\u05e2\u05d1\u05e8\u05d9\u05ea';
  const launch = module.buildAgentLaunch({ provider: 'claude', nativeId: id, prompt });
  assert.equal(launch.executable, 'claude');
  assert.deepEqual(launch.argv, ['--session-id', id, '--', prompt]);
});
test('targeted resume never falls back to the latest conversation', () => {
  assert.deepEqual(module.buildAgentLaunch({ provider: 'claude', nativeId: id, resume: true }).argv, ['--resume', id]);
  assert.deepEqual(module.buildAgentLaunch({ provider: 'codex', nativeId: id, resume: true }).argv, ['resume', id]);
  for (const provider of ['claude', 'codex']) {
    assert.throws(() => module.buildAgentLaunch({ provider, resume: true }), /session ID/);
    assert.throws(() => module.buildAgentLaunch({ provider, nativeId: 'id;bad', resume: true }), /session ID/);
  }
});
test('Codex literal prompt uses -- and native permissions are untouched', () => {
  const launch = module.buildAgentLaunch({ provider: 'codex', prompt: '--help; echo unsafe' });
  assert.deepEqual(launch.argv, ['--', '--help; echo unsafe']);
  assert.ok(!JSON.stringify(launch).includes('bypass'));
  assert.throws(() => module.buildAgentLaunch({ provider: 'other' }), /provider/);
});
test('Codex capture accepts only the explicit native resume banner, marked unconfirmed', () => {
  assert.equal(module.captureCodexId(`Random UUID ${id}`), null);
  assert.equal(module.captureCodexId(`To continue this session, run codex resume ${id}`), id);
});
test('Codex captures the current multiline native resume banner with terminal styling', () => {
  assert.equal(module.captureCodexId(`To continue this session, run:\r\n  \x1b[32mcodex resume ${id}\x1b[0m\r\nOr run codex resume and select the session.`), id);
});
test('Codex rejects an invalid latest banner instead of suggesting an older native ID', () => {
  assert.equal(module.captureCodexId(`To continue this session, run codex resume ${id}\nTo continue this session, run:\n  codex resume not-a-uuid\n`), null);
  assert.equal(module.captureCodexId(`Example command: codex resume ${id}`), null);
});
test('an incomplete latest Codex banner cannot suggest an older native ID', () => {
  const earlier = `To continue this session, run codex resume ${id}\n`;
  for (const latest of ['To continue this session, run codex resume ', 'To continue this session, run:\r\n  codex resume ', 'To continue this session, run:', 'To continue this session, run:\n  codex res']) {
    assert.equal(module.captureCodexId(earlier + latest), null, latest);
  }
});
test('unknown native session IDs cannot be used to construct a Claude launch', () => {
  assert.throws(() => module.buildAgentLaunch({ provider: 'claude', nativeId: 'not-a-uuid' }), /session ID/);
});

// ----- Phase 7: asynchronous detection, help-gated auth probes and constant commands -----
const { readFileSync, mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
const { join, delimiter, dirname } = await import('node:path');
const { tmpdir } = await import('node:os');
const { removeLater } = await import('./support/cleanup.mjs');
const WIN = process.platform === 'win32';
// A directory with fake `claude` and `codex` files on PATH; the fake runner answers for them.
function fakePath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-agents-'));
  for (const name of ['claude', 'codex']) {
    const file = join(dir, WIN ? `${name}.exe` : name); writeFileSync(file, ''); if (!WIN) chmodSync(file, 0o755);
  }
  t.after(() => removeLater(dir));
  return { PATH: [dir, ...(WIN ? [dirname(process.execPath)] : [])].join(delimiter), PATHEXT: '.EXE' };
}
// A fake runner: answers per argv, records every call.
function fakeRunner(answers) {
  const calls = [];
  const runner = async (path, args) => {
    calls.push(args.join(' '));
    const answer = answers[args.join(' ')];
    if (answer === undefined) throw Object.assign(new Error('unexpected'), { code: 2, stdout: '', stderr: '' });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { runner, calls };
}
const CLAUDE_HELP = 'Usage: claude [options] [command] [prompt]\n\nCommands:\n  auth            Manage authentication\n  mcp             Configure MCP servers\n';
const CODEX_HELP = 'Usage: codex [OPTIONS] [PROMPT]\n\nCommands:\n  exec        Run Codex non-interactively\n  login       Manage login\n  logout      Remove stored authentication\n';
const CODEX_LOGIN_HELP = 'Manage login\n\nUsage: codex login [OPTIONS] [COMMAND]\n\nCommands:\n  status  Show login status\n  help    Print this message\n';

test('initialAgents marks every provider checking and runs nothing', () => {
  const rows = module.initialAgents('darwin', { PATH: '' });
  assert.deepEqual(rows.map(row => row.provider), ['claude', 'codex', 'cursor']);
  for (const row of rows) {
    assert.equal(row.state, 'checking'); assert.equal(row.available, false); assert.equal(row.auth, 'unchecked');
    assert.equal(typeof row.commands.installPage, 'string'); assert.ok(row.commands.login);
  }
  assert.equal(rows[0].commands.login, 'claude auth login'); assert.equal(rows[1].commands.login, 'codex login'); assert.equal(rows[2].commands.login, 'agent login');
});

test('detectProvider reads version and help asynchronously', async t => {
  const env = fakePath(t);
  const { runner, calls } = fakeRunner({ '--version': '2.1.211 (Claude Code)\n', '--help': CLAUDE_HELP });
  const pending = module.detectProvider('claude', env, { runner });
  assert.ok(pending instanceof Promise);
  const row = await pending;
  assert.deepEqual(calls, ['--version', '--help']);
  assert.equal(row.state, 'ready'); assert.equal(row.available, true); assert.equal(row.version, '2.1.211 (Claude Code)');
  assert.deepEqual(row.supports, { login: true, authStatus: true }); assert.equal(row.auth, 'unchecked');
  assert.equal(row.commands.login, 'claude auth login');
  const source = readFileSync(new URL('../src/core/agents.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /execFileSync|spawnSync|execSync/);
  assert.equal(module.detectAgents, undefined, 'the synchronous detector is gone');
  // Without probes (headless test default) only --version runs.
  const quiet = fakeRunner({ '--version': '2.1.211 (Claude Code)\n' });
  const plain = await module.detectProvider('claude', env, { runner: quiet.runner, probes: false });
  assert.deepEqual(quiet.calls, ['--version']); assert.deepEqual(plain.supports, { login: false, authStatus: false });
  // Missing: nothing runs.
  const none = fakeRunner({});
  const missing = await module.detectProvider('codex', { PATH: '' }, { runner: none.runner });
  assert.equal(missing.state, 'missing'); assert.equal(missing.available, false); assert.deepEqual(none.calls, []);
});

test('a Claude without an auth command gets no probe and no sign-in', async t => {
  const env = fakePath(t);
  const { runner, calls } = fakeRunner({ '--version': '1.0.0 (Claude Code)', '--help': 'Usage: claude [options]\n  --print   Print response\n  config    Manage configuration\n' });
  const row = await module.detectProvider('claude', env, { runner });
  assert.deepEqual(row.supports, { login: false, authStatus: false });
  assert.equal(await module.probeAuth(row, env, { runner }), 'unchecked');
  assert.deepEqual(calls, ['--version', '--help'], 'no auth status call');
});

test('a Codex whose login help lacks status gets no probe', async t => {
  const env = fakePath(t);
  const { runner, calls } = fakeRunner({ '--version': 'codex-cli 0.40.0', '--help': CODEX_HELP, 'login --help': 'Usage: codex login [OPTIONS]\n  --api-key <KEY>\n' });
  const row = await module.detectProvider('codex', env, { runner });
  assert.deepEqual(row.supports, { login: true, authStatus: false });
  assert.equal(await module.probeAuth(row, env, { runner }), 'unchecked');
  assert.deepEqual(calls, ['--version', '--help', 'login --help']);
  // A Codex without login at all never reads login --help.
  const bare = fakeRunner({ '--version': 'codex-cli 0.1.0', '--help': 'Usage: codex [PROMPT]\n  exec  Run\n' });
  const old = await module.detectProvider('codex', env, { runner: bare.runner });
  assert.deepEqual(old.supports, { login: false, authStatus: false }); assert.deepEqual(bare.calls, ['--version', '--help']);
});

test('probeAuth runs the documented status command once a probe is allowed', async t => {
  const env = fakePath(t);
  const claude = fakeRunner({ '--version': '2.1.211', '--help': CLAUDE_HELP, 'auth status --json': '{"loggedIn":true,"email":"a@b.c","orgName":"X"}' });
  const row = await module.detectProvider('claude', env, { runner: claude.runner });
  const auth = await module.probeAuth(row, env, { runner: claude.runner });
  assert.equal(auth, 'signed-in'); assert.equal(claude.calls.at(-1), 'auth status --json');
  const merged = { ...row, auth };
  assert.ok(!JSON.stringify(merged).includes('@')); assert.ok(!JSON.stringify(merged).includes('"X"'));
  const codex = fakeRunner({ '--version': 'codex-cli 0.40.0', '--help': CODEX_HELP, 'login --help': CODEX_LOGIN_HELP,
    'login status': Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: 'Not logged in\n' }) });
  const crow = await module.detectProvider('codex', env, { runner: codex.runner });
  assert.deepEqual(crow.supports, { login: true, authStatus: true });
  assert.equal(await module.probeAuth(crow, env, { runner: codex.runner }), 'signed-out'); assert.equal(codex.calls.at(-1), 'login status');
  // Codex prints its status on stderr; a successful run keeps both streams for the parser.
  const signedIn = async (path, args, _env, options) => args.join(' ') === 'login status' && options.output === 'both' ? { stdout: '', stderr: 'Logged in using ChatGPT\n' } : codex.runner(path, args);
  assert.equal(await module.probeAuth(crow, env, { runner: signedIn }), 'signed-in');
});

test('parseClaudeAuth keeps only loggedIn', () => {
  assert.equal(module.parseClaudeAuth({ stdout: '{"loggedIn":true,"email":"a@b.c","orgName":"X"}', code: 0 }), 'signed-in');
  assert.equal(module.parseClaudeAuth({ stdout: '{"loggedIn":false}', code: 1 }), 'signed-out');
  for (const stdout of ['{"loggedIn":"yes"}', 'Logged in as a@b.c', '', '[]', 'null', '{"authenticated":true}']) assert.equal(module.parseClaudeAuth({ stdout, code: 0 }), 'unknown', stdout);
  assert.equal(module.parseClaudeAuth({}), 'unknown');
});

test('parseCodexAuth', () => {
  assert.equal(module.parseCodexAuth({ stdout: 'Logged in using ChatGPT\n', stderr: '', code: 0 }), 'signed-in');
  assert.equal(module.parseCodexAuth({ stdout: '', stderr: 'Logged in using an API key - sk-***abc\n', code: 0 }), 'signed-in');
  assert.equal(module.parseCodexAuth({ stdout: '', stderr: 'Not logged in\n', code: 1 }), 'signed-out');
  assert.equal(module.parseCodexAuth({ stdout: '', stderr: '', code: 1 }), 'unknown', 'an exit code alone never decides');
  assert.equal(module.parseCodexAuth({ stdout: '', stderr: '', code: 0 }), 'unknown', 'an exit code alone never decides');
  assert.equal(module.parseCodexAuth({ stdout: 'Logged in using ChatGPT', stderr: '', code: 1 }), 'unknown');
  assert.equal(module.parseCodexAuth({ stdout: 'Error: Logged in elsewhere?', stderr: '', code: 0 }), 'unknown', 'the line must start with it');
});

test('probeAuth turns a timeout and a spawn error into unknown', async () => {
  const row = { provider: 'claude', available: true, path: '/x/claude', supports: { login: true, authStatus: true } };
  const secret = 'person@example.com sk-ant-0123456789';
  for (const error of [Object.assign(new Error(`timed out ${secret}`), { killed: true, timedOut: true, stdout: secret, stderr: secret }),
    Object.assign(new Error(`spawn ENOENT ${secret}`), { code: 'ENOENT' }), new Error(secret)]) {
    const runner = async () => { throw error; };
    assert.equal(await module.probeAuth(row, {}, { runner }), 'unknown');
  }
  // A runner that throws synchronously, and output that is not text, are unknown too.
  assert.equal(await module.probeAuth(row, {}, { runner: () => { throw new Error(secret); } }), 'unknown');
  assert.equal(await module.probeAuth({ ...row, provider: 'codex' }, {}, { runner: async () => ({ toString() { throw new Error(secret); } }) }), 'unknown');
  // Never for a missing or unprobed row, and never for Cursor (cursorAuth keeps its own path).
  let ran = false; const runner = async () => { ran = true; return '{"loggedIn":true}'; };
  assert.equal(await module.probeAuth({ ...row, available: false }, {}, { runner }), 'unchecked');
  assert.equal(await module.probeAuth({ ...row, supports: { login: true } }, {}, { runner }), 'unchecked');
  assert.equal(await module.probeAuth({ ...row, provider: 'cursor' }, {}, { runner }), 'unchecked');
  assert.equal(ran, false);
});

test('PROVIDER_COMMANDS login argv is constant', () => {
  const table = module.PROVIDER_COMMANDS;
  const frozen = value => !value || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(frozen));
  assert.ok(frozen(table), 'deep-frozen');
  assert.deepEqual(table.claude.login, ['auth', 'login']); assert.deepEqual(table.codex.login, ['login']); assert.deepEqual(table.cursor.login, ['login']);
  assert.throws(() => { table.codex.login.push('--evil'); }); assert.throws(() => { table.claude.login = ['x']; });
  for (const provider of ['claude', 'codex', 'cursor']) assert.match(table[provider].installPage, /^https:\/\//);
});

test('install commands: official, verbatim, never elevated; missing tools fall back to the install page', () => {
  const claudeMac = module.installFor('claude', 'darwin', { PATH: '/usr/bin:/bin' }, { find: () => '/usr/bin/curl' });
  assert.equal(claudeMac.display, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(claudeMac.file, '/bin/bash'); assert.deepEqual(claudeMac.args, ['--noprofile', '--norc', '-c', claudeMac.display]);
  const claudeWin = module.installFor('claude', 'win32', { SystemRoot: 'C:\\Windows' }, { find: () => null });
  assert.equal(claudeWin.display, 'irm https://claude.ai/install.ps1 | iex');
  assert.match(claudeWin.file, /powershell\.exe$/); assert.deepEqual(claudeWin.args, ['-NoProfile', '-NonInteractive', '-Command', claudeWin.display]);
  const codexMac = module.installFor('codex', 'linux', {}, { find: () => '/usr/bin/curl' });
  assert.equal(codexMac.display, 'curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  // The official Windows command bypasses the execution policy, which Journal never does.
  assert.equal(module.installFor('codex', 'win32', {}, { find: () => null }), null);
  // No curl: Install page instead.
  assert.equal(module.installFor('claude', 'darwin', {}, { find: () => null }), null);
  assert.equal(module.installFor('cursor', 'darwin', {}).display, 'curl https://cursor.com/install -fsS | bash');
  for (const command of [claudeMac, claudeWin, codexMac]) assert.doesNotMatch(command.args.join(' '), /sudo|runas|-Verb|ExecutionPolicy/i);
  const rows = module.initialAgents('win32', { SystemRoot: 'C:\\Windows' });
  assert.equal(rows[1].commands.install, null); assert.equal(rows[0].commands.install, 'irm https://claude.ai/install.ps1 | iex');
});
