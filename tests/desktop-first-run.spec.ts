import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// Phase 7, Group A: providers are detected after the window shows, sign-in runs a
// constant command per provider, and the first-run actions are reachable over IPC.
// Group B adds the Welcome and Getting to know your project scenarios.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs');

type Row = { provider: string; state?: string; available: boolean; version: string | null; auth?: string; supports?: Record<string, boolean>; commands?: { login: string | null } };
const request = <T>(page: Page, action: string, input: object = {}) => page.evaluate(([a, i]) => window.journal!.request(a as string, i as object), [action, input] as const) as Promise<T>;
const agents = async (page: Page) => (await request<{ agents: Row[] }>(page, 'bootstrap')).agents;
const row = async (page: Page, provider: string) => (await agents(page)).find(agent => agent.provider === provider)!;

function setup(prefix: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', prefix)); const bin = resolve(root, 'bin'); const home = resolve(root, 'home'); const project = resolve(root, 'project');
  for (const dir of [bin, home, project]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# First run fixture\n\nA fixture project.\n'); git('add', '.'); git('commit', '-qm', 'init');
  const calls = resolve(root, 'calls.jsonl');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin${delimiter}${resolve(process.execPath, '..')}`, HOME: home, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' };
  delete env.ELECTRON_RUN_AS_NODE;
  const cli = (name: string, body: string) => { writeFileSync(resolve(bin, name), `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({bin:${JSON.stringify(name)},argv:a})+'\\n');\n${body}`); chmodSync(resolve(bin, name), 0o755); };
  const log = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { bin: string; argv: string[] }) : [];
  return { root, bin, home, project, env, cli, log };
}

async function launch(env: Record<string, string>) {
  const app = await electron.launch({ args: ['.'], env });
  return { app, page: await app.firstWindow() };
}

test('providers are detected after the window shows', async () => {
  const f = setup('first-run-detect-');
  // --version takes 2.5 s: the window must not wait for it.
  f.cli('claude', `if(a[0]==='--version'){setTimeout(()=>{console.log('2.1.211 (Claude Code)');process.exit(0)},2500);return}
process.stdin.resume();`);
  f.cli('codex', `if(a[0]==='--version'){console.log('codex-cli 0.40.0');process.exit(0)}
process.stdin.resume();`);
  const started = Date.now();
  const { app, page } = await launch(f.env);
  try {
    await page.waitForLoadState('domcontentloaded');
    const first = await row(page, 'claude');
    expect(Date.now() - started).toBeLessThan(15000);
    expect(first.state).toBe('checking'); expect(first.available).toBe(false); expect(first.auth).toBe('unchecked');
    expect(first.commands?.login).toBe('claude auth login');
    await expect.poll(async () => (await row(page, 'claude')).state, { timeout: 10000 }).toBe('ready');
    expect((await row(page, 'claude')).version).toBe('2.1.211 (Claude Code)');
    expect((await row(page, 'codex')).version).toBe('codex-cli 0.40.0');
    // Headless without the hook: version only, no help read and no probe.
    expect(f.log().filter(call => call.bin === 'claude').map(call => call.argv)).toEqual([['--version']]);
    expect((await row(page, 'claude')).supports).toEqual({ login: false, authStatus: false });
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('providerLogin runs the constant command for each provider', async () => {
  const f = setup('first-run-login-');
  const signedIn = (name: string) => JSON.stringify(resolve(f.home, `.${name}-signed-in`));
  f.cli('claude', `if(a[0]==='--version'){console.log('2.1.211 (Claude Code)');process.exit(0)}
if(a[0]==='--help'){console.log('Usage: claude [options] [command]\\n\\nCommands:\\n  auth   Manage authentication\\n  mcp    Configure MCP servers');process.exit(0)}
if(a.join(' ')==='auth status --json'){const ok=fs.existsSync(${signedIn('claude')});console.log(JSON.stringify({loggedIn:ok,email:'person@example.com',orgName:'Secret Org'}));process.exit(ok?0:1)}
if(a.join(' ')==='auth login'){console.log('Opening browser for person@example.com');fs.writeFileSync(${signedIn('claude')},'');process.exit(0)}
process.stdin.resume();`);
  f.cli('codex', `if(a[0]==='--version'){console.log('codex-cli 0.40.0');process.exit(0)}
if(a.join(' ')==='--help'){console.log('Usage: codex [OPTIONS] [PROMPT]\\n\\nCommands:\\n  exec    Run non-interactively\\n  login   Manage login\\n  logout  Remove stored authentication');process.exit(0)}
if(a.join(' ')==='login --help'){console.log('Usage: codex login [OPTIONS] [COMMAND]\\n\\nCommands:\\n  status  Show login status');process.exit(0)}
if(a.join(' ')==='login status'){if(fs.existsSync(${signedIn('codex')})){console.error('Logged in using ChatGPT (person@example.com)');process.exit(0)}console.error('Not logged in');process.exit(1)}
if(a.join(' ')==='login'){console.log('Sign in at https://auth.example/device');fs.writeFileSync(${signedIn('codex')},'');process.exit(0)}
process.stdin.resume();`);
  const { app, page } = await launch(f.env);
  try {
    await app.evaluate(() => { (globalThis as any).__journalAuthProbes = true; });
    // Check again: detection with help reads and probes.
    for (const provider of ['claude', 'codex']) await request(page, 'providerStatus', { provider, fresh: true });
    await expect.poll(async () => (await row(page, 'codex')).auth).toBe('signed-out');
    await expect.poll(async () => (await row(page, 'claude')).auth).toBe('signed-out');
    expect((await row(page, 'codex')).supports).toEqual({ login: true, authStatus: true });

    // Extra fields from the window are ignored: the argv and executable are main's.
    const login = await request<{ id: string; command: string }>(page, 'providerLogin', { provider: 'codex', argv: ['--evil'], command: 'rm -rf /', path: '/bin/sh' });
    expect(login.command).toBe('codex login');
    await expect.poll(async () => (await row(page, 'codex')).auth, { timeout: 15000 }).toBe('signed-in');
    const claude = await request<{ id: string; command: string }>(page, 'providerLogin', { provider: 'claude', argv: ['--dangerously-skip-permissions'] });
    expect(claude.command).toBe('claude auth login');
    await expect.poll(async () => (await row(page, 'claude')).auth, { timeout: 15000 }).toBe('signed-in');
    const runs = f.log().filter(call => call.argv[0] === 'login' || call.argv[0] === 'auth');
    expect(runs.filter(call => !call.argv.includes('status') && !call.argv.includes('--help'))).toEqual([{ bin: 'codex', argv: ['login'] }, { bin: 'claude', argv: ['auth', 'login'] }]);
    expect(f.log().some(call => call.argv.includes('--evil') || call.argv.includes('--dangerously-skip-permissions'))).toBe(false);

    // Nothing account-identifying reaches the window.
    const all = JSON.stringify(await agents(page));
    expect(all).not.toContain('@'); expect(all).not.toContain('Secret Org');

    // An unknown provider, a second sign-in at once, and a CLI without sign-in are refused plainly.
    await expect(request(page, 'providerLogin', { provider: 'bash' })).rejects.toThrow(/Invalid provider/);
    // Install shows the exact official command in a native confirmation; Cancel runs nothing.
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async (_w: unknown, options: any) => { (globalThis as any).__lastDialog = options; return { response: 1 }; }; });
    expect(await request(page, 'providerInstall', { provider: 'codex', file: '/bin/sh', args: ['-c', 'echo evil'] })).toBeNull();
    const asked = await app.evaluate(() => (globalThis as any).__lastDialog as { message: string; detail: string });
    expect(asked.message).toBe('Install Codex?');
    expect(asked.detail).toContain('curl -fsSL https://chatgpt.com/codex/install.sh | sh'); expect(asked.detail).toContain('will not receive or store your Codex credentials');
    expect(f.log().some(call => call.argv.includes('echo evil'))).toBe(false);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('first-run actions: dropped paths, the headless gate and remembering both drafts', async () => {
  const f = setup('first-run-ipc-');
  for (const name of ['claude', 'codex']) f.cli(name, `if(a[0]==='--version'){console.log('1.0.0');process.exit(0)}\nprocess.stdin.resume();`);
  // Outside any Git repository (the fixture root is inside this checkout).
  const plain = mkdtempSync(resolve(tmpdir(), 'journal-plain-'));
  const { app, page } = await launch(f.env);
  try {
    expect((await request<{ hasNotes: boolean }>(page, 'bootstrap')).hasNotes).toBe(false);
    // A synthetic File has no OS path; the preload's webUtils bridge says so with ''.
    expect(await page.evaluate(() => window.journal!.pathForFile(new File(['x'], 'x.txt')))).toBe('');
    for (const path of ['relative/path', resolve(f.root, 'missing'), resolve(f.root, 'package.json'), 42]) await expect(request(page, 'openProjectPath', { path })).rejects.toThrow('Drop a Git folder');
    await expect(request(page, 'openProjectPath', { path: plain })).rejects.toThrow(/Git/);
    const project = await request<{ id: string }>(page, 'openProjectPath', { path: f.project });
    // Headless default: no drafts, so existing specs go straight to the composer.
    expect(await request(page, 'firstRunDrafts', { projectId: project.id })).toBeNull();
    await app.evaluate(() => { (globalThis as any).__journalFirstRun = true; });
    const drafts = await request<any>(page, 'firstRunDrafts', { projectId: project.id });
    expect(drafts.overview.basis.facts).toEqual({ readme: 'README.md', folders: 0, commits: 1, counted: true });
    expect(await request(page, 'firstRunDrafts', { projectId: project.id })).toBeNull();
    const fill = (statement: string) => statement.split('\n').filter(line => !/\[describe/.test(line)).join('\n');
    // The window cannot choose its audit label.
    const notes = await request<any[]>(page, 'rememberDraft', { projectId: project.id, via: 'wrap-up',
      overview: { statement: fill(drafts.overview.statement), base: drafts.overview.source.base, head: drafts.head },
      branch: { statement: fill(drafts.branch.statement), base: drafts.branch.source.base, head: drafts.head } });
    expect(notes.map(note => note.status)).toEqual(['active', 'active']);
    const db = new DatabaseSync(resolve(f.root, 'data', 'journal.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare("SELECT action, body FROM audit WHERE action IN ('memory-active','orientation-remembered') ORDER BY id").all() as { action: string; body: string }[];
      expect(rows.map(r => [r.action, JSON.parse(r.body).via ?? null])).toEqual([['memory-active', 'first-run'], ['memory-active', 'first-run'], ['orientation-remembered', null]]);
    } finally { db.close(); }
    expect((await request<{ hasNotes: boolean }>(page, 'bootstrap')).hasNotes).toBe(true);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); }
});
