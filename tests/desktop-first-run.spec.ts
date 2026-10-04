import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { contextPreview, inspectorTab, newSession, skipFirstRun, startSession, taskBox } from './support/ui';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// Phase 7, Group A: providers are detected after the window shows, sign-in runs a
// constant command per provider, and the first-run actions are reachable over IPC.
// Group B (below) covers the Welcome screen, Getting to know your project and the first-note moment.
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

    // The install page: the official URL from main's table, recorded instead of opened in headless runs.
    await request(page, 'openInstallPage', { provider: 'codex', url: 'https://evil.example' });
    expect(await app.evaluate(() => (globalThis as any).__journalOpenedUrls)).toEqual([expect.stringMatching(/^https:\/\//)]);
    expect(JSON.stringify(await app.evaluate(() => (globalThis as any).__journalOpenedUrls))).not.toContain('evil');
    await expect(request(page, 'openInstallPage', { provider: 'bash' })).rejects.toThrow(/Invalid provider/);
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
      overview: { statement: fill(drafts.overview.statement), base: drafts.overview.source.base, head: drafts.head, branch: drafts.branchName },
      branch: { statement: fill(drafts.branch.statement), base: drafts.branch.source.base, head: drafts.head, branch: drafts.branchName } });
    expect(notes.map(note => note.status)).toEqual(['active', 'active']);
    const db = new DatabaseSync(resolve(f.root, 'data', 'journal.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare("SELECT action, body FROM audit WHERE action IN ('memory-active','orientation-remembered') ORDER BY id").all() as { action: string; body: string }[];
      expect(rows.map(r => [r.action, JSON.parse(r.body).via ?? null])).toEqual([['memory-active', 'first-run'], ['memory-active', 'first-run'], ['orientation-remembered', null]]);
    } finally { db.close(); }
    expect((await request<{ hasNotes: boolean }>(page, 'bootstrap')).hasNotes).toBe(true);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); }
});

// ----- Group B: the Welcome screen, Getting to know your project and the first-note moment -----
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const openDialogReturns = (app: ElectronApplication, path: string) => app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, path);
const firstRunHook = (app: ElectronApplication) => app.evaluate(() => { (globalThis as any).__journalFirstRun = true; });
const plainClis = (f: ReturnType<typeof setup>) => { for (const name of ['claude', 'codex']) f.cli(name, `if(a[0]==='--version'){console.log('1.0.0');process.exit(0)}\nprocess.stdin.resume();`); };
const knowTitle = (page: Page) => page.getByRole('heading', { name: 'I read your project. Here’s what I’d tell an agent.' });
const agentRows = (page: Page) => page.getByRole('list', { name: 'Agents on this computer' }).getByRole('listitem');
function audits(f: ReturnType<typeof setup>, actions: string[]) {
  const db = new DatabaseSync(resolve(f.root, 'data', 'journal.sqlite'), { readOnly: true });
  try { return (db.prepare(`SELECT action, body FROM audit WHERE action IN (${actions.map(() => '?').join(',')}) ORDER BY id`).all(...actions) as { action: string; body: string }[]).map(r => [r.action, JSON.parse(r.body).via ?? null]); }
  finally { db.close(); }
}

test('welcome lists agents and opens a project', async () => {
  const f = setup('first-run-welcome-'); plainClis(f);
  const { app, page } = await launch(f.env);
  try {
    await expect(page.getByRole('heading', { name: 'Your agents remember your project', level: 1 })).toBeVisible();
    await expect(agentRows(page)).toHaveCount(3);
    await expect(agentRows(page).nth(0)).toContainText('Claude Code');
    await expect(agentRows(page).nth(0)).toContainText('Installed · 1.0.0');
    // Headless without probes: no sign-in state is claimed, so the row offers nothing.
    await expect(agentRows(page).nth(0)).not.toContainText('Signed in');
    // Cursor is not installed (HOME is the fixture's): one action, named for the provider.
    await expect(agentRows(page).nth(2)).toContainText('Not installed');
    await expect(agentRows(page).nth(2).getByRole('button', { name: 'Install Cursor…' })).toBeVisible();
    await expect(page.getByText('Everything stays on this computer.', { exact: false })).toBeVisible();
    const open = page.getByRole('button', { name: 'Open a project…', exact: true });
    expect(await open.getAttribute('aria-keyshortcuts')).toBe(process.platform === 'darwin' ? 'Meta+O' : 'Control+O');
    await openDialogReturns(app, f.project); await open.click();
    await expect(taskBox(page)).toBeVisible();
    await expect(page.locator('.project-switcher .project-name')).toHaveText('project');
    // Sparse first-session states (board 3).
    await expect(page.locator('.sidebar')).toContainText('No sessions yet.');
    await expect(page.locator('.sidebar')).toContainText('Your first session will appear here.');
    const empty = page.locator('.terminal-empty');
    await expect(empty).toContainText(`Start an agent with ${process.platform === 'darwin' ? '⌘N' : 'Ctrl+N'}.`);
    await expect(empty.locator('img')).toHaveAttribute('alt', '');
    // No remembered task notes yet: the Relevant box explains itself beside the mascot (board 3).
    const relevantEmpty = contextPreview(page).locator('.preview-empty');
    await expect(relevantEmpty).toContainText('Nothing here yet. After this session, I’ll suggest rules');
    await expect(relevantEmpty.locator('img')).toHaveAttribute('alt', '');
    // The composer's cards say what the Welcome rows said.
    await expect(page.getByRole('radio', { name: 'Claude Code', exact: true })).toContainText('Installed · 1.0.0');
    await expect(page.getByRole('radio', { name: 'Cursor', exact: true })).toContainText('Not installed');
    // The empty terminal is for the project's first session only.
    await startSession(page, 'claude', { task: 'FIRST_SESSION' });
    await expect(page.locator('.terminal-surface')).toBeVisible();
    await newSession(page);
    await expect(taskBox(page)).toBeVisible();
    await expect(empty).toHaveCount(0);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('dropping a file that did not come from the OS says to drop a folder', async () => {
  const f = setup('first-run-drop-'); plainClis(f);
  const { app, page } = await launch(f.env);
  try {
    await expect(page.getByRole('heading', { name: 'Your agents remember your project' })).toBeVisible();
    // A synthetic File has no OS path (webUtils returns ''), so it can never open a project; the real drag is a native check.
    await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['x'], 'notes.txt'));
      const target = document.querySelector('.welcome')!;
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('.welcome.dragging')).toBeVisible();
    await expect(page.getByText('Drop a Git folder to open it')).toBeVisible();
    await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['x'], 'notes.txt'));
      document.querySelector('.welcome')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await expect(page.getByRole('alert')).toHaveText('Drop a folder from Finder or File Explorer.');
    await expect(page.locator('.welcome.dragging')).toHaveCount(0);
    // A folder that is not a Git checkout is refused plainly by main (the same path a real drop takes).
    const plain = mkdtempSync(resolve(tmpdir(), 'journal-drop-plain-'));
    try { await expect(request(page, 'openProjectPath', { path: plain })).rejects.toThrow(/Git/); } finally { rmSync(plain, { recursive: true, force: true }); }
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('a fresh repo shows Getting to know your project; Remember both remembers two notes in one action', async () => {
  const f = setup('first-run-know-'); plainClis(f);
  mkdirSync(resolve(f.project, 'src')); writeFileSync(resolve(f.project, 'src', 'index.js'), 'export {};\n');
  execFileSync('git', ['-C', f.project, '-c', 'user.name=a', '-c', 'user.email=a@a', 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', f.project, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'Add the source folder'], { stdio: 'pipe' });
  const { app, page } = await launch(f.env);
  try {
    await firstRunHook(app); await openDialogReturns(app, f.project);
    await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
    await expect(knowTitle(page)).toBeVisible();
    await expect(page.getByText('Drafted from Git: README, 1 top-level folder, 2 commits · no AI call · nothing left this computer')).toBeVisible();
    const about = page.getByRole('region', { name: 'About this project' }); const branch = page.getByRole('region', { name: 'Where this branch stands' });
    await expect(about).toContainText('A fixture project.'); await expect(about).toContainText('All branches'); await expect(about).toContainText('README.md · ');
    await expect(branch).toContainText('Only on main'); await expect(branch).toContainText('Add the source folder');
    await expect(branch).toContainText('Only you know these two lines.');
    await expect(page.getByRole('complementary', { name: 'How Journal remembers' })).toBeVisible();
    // Enter moves to the next field; Cmd/Ctrl+Enter remembers.
    await about.getByRole('textbox', { name: /^Rules to keep/ }).fill('Never force-push main');
    await page.keyboard.press('Enter');
    await expect(branch.getByRole('textbox', { name: 'Working on now' })).toBeFocused();
    await page.keyboard.type('First-run screens');
    await page.keyboard.press('Enter'); await page.keyboard.type('Ship alpha 4');
    await expect(branch.getByRole('textbox', { name: 'Next', exact: true })).toHaveValue('Ship alpha 4');
    await expect(page.getByRole('button', { name: /^Remember both/ })).toBeEnabled();
    await page.keyboard.press(`${mod}+Enter`);
    // Back to New session, with the first-note moment once.
    await expect(taskBox(page)).toBeVisible();
    await expect(knowTitle(page)).toHaveCount(0);
    const moment = page.locator('.first-note');
    await expect(moment).toHaveText(/First note remembered\. Every new session in Journal will know it\./);
    await expect(moment).toHaveAttribute('role', 'status');
    // The composer's "Every session knows" lists both notes as just remembered (board 3).
    const always = contextPreview(page).getByRole('region', { name: 'Every session knows' });
    await expect(always.getByRole('listitem')).toHaveCount(2);
    await expect(always.locator('.just-remembered')).toHaveCount(2);
    await expect(always).toContainText('About this project'); await expect(always).toContainText('Where this branch stands');
    expect(await moment.evaluate(el => getComputedStyle(el).animationName)).toBe('first-note-in');
    expect(await page.evaluate(() => document.activeElement?.closest('.first-note'))).toBeNull();
    // Both notes are remembered (active), exactly as the cards showed them.
    const memory = await inspectorTab(page, 'Memory');
    await expect(memory).toBeVisible();
    const notes = page.locator('.memory-list .note-card');
    await expect(notes).toHaveCount(2);
    await expect(page.locator('.memory-list .just-remembered')).toHaveCount(2);
    await expect(page.locator('.memory-list')).toContainText('Constraints: Never force-push main');
    await expect(page.locator('.memory-list')).toContainText('Current work: First-run screens');
    await expect(page.locator('.memory-list')).toContainText('Next: Ship alpha 4');
    await expect(page.locator('.memory-list')).not.toContainText('[describe');
    expect(audits(f, ['memory-active', 'orientation-remembered'])).toEqual([['memory-active', 'first-run'], ['memory-active', 'first-run'], ['orientation-remembered', null]]);
    // Once per install: a later remembered note gets the plain Remembered state, no moment.
    await moment.getByRole('button', { name: 'Close' }).click(); await expect(moment).toHaveCount(0);
    const project = await request<{ id: string }>(page, 'openProjectPath', { path: f.project });
    await request(page, 'proposeMemory', { projectId: project.id, input: { statement: 'Run the fixture tests with npm test', category: 'lesson', scope: 'checkout', area: '', environment: '', source: { kind: 'user', note: 'Seen in this repo' } } });
    await page.locator('.filter-tabs').getByRole('button', { name: /^Needs review/ }).click();
    const candidate = page.locator('.memory-list .note-card', { hasText: 'Run the fixture tests' });
    await candidate.getByRole('button', { name: 'Remember', exact: true }).click();
    // Remembered: it leaves Needs review (the list reloads after the write).
    await expect(candidate).toHaveCount(0);
    expect(audits(f, ['memory-active']).length).toBe(3);
    await expect(moment).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('journal-first-note-seen'))).toBe('1');
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('skip shows nothing again for that project', async () => {
  const f = setup('first-run-skip-'); plainClis(f);
  let { app, page } = await launch(f.env);
  try {
    await firstRunHook(app); await openDialogReturns(app, f.project);
    await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
    await expect(knowTitle(page)).toBeVisible();
    await skipFirstRun(page);
    await expect(taskBox(page)).toBeVisible();
    await skipFirstRun(page); // a no-op once the screen is gone
    expect(audits(f, ['orientation-skipped', 'memory-active']).map(([action]) => action)).toEqual(['orientation-skipped']);
    await app.close();
    ({ app, page } = await launch(f.env));
    await firstRunHook(app); await openDialogReturns(app, f.project);
    const project = await request<{ id: string }>(page, 'openProjectPath', { path: f.project });
    expect(await request(page, 'firstRunDrafts', { projectId: project.id })).toBeNull();
    await expect(taskBox(page)).toBeVisible();
    await expect(knowTitle(page)).toHaveCount(0);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('a project with a summary never shows it', async () => {
  const f = setup('first-run-brief-'); plainClis(f);
  const { app, page } = await launch(f.env);
  try {
    await expect(page.getByRole('heading', { name: 'Your agents remember your project' })).toBeVisible();
    const project = await request<{ id: string }>(page, 'openProjectPath', { path: f.project });
    const note = await request<{ id: string }>(page, 'proposeMemory', { projectId: project.id, input: { statement: 'Purpose: a fixture\nStructure: README only', category: 'brief', scope: 'checkout', area: '', environment: '', source: { kind: 'user', note: 'Written by hand' } } });
    expect(note.id).toBeTruthy();
    await firstRunHook(app); await openDialogReturns(app, f.project);
    await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
    await expect(taskBox(page)).toBeVisible();
    // The renderer asked (once) and got nothing; asking again still gives nothing.
    expect(await request(page, 'firstRunDrafts', { projectId: project.id })).toBeNull();
    await expect(knowTitle(page)).toHaveCount(0);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('a detached HEAD shows the overview card only, and Remember saves it', async () => {
  const f = setup('first-run-detached-'); plainClis(f);
  execFileSync('git', ['-C', f.project, 'checkout', '-q', '--detach'], { stdio: 'pipe' });
  const { app, page } = await launch(f.env);
  try {
    await firstRunHook(app); await openDialogReturns(app, f.project);
    await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
    await expect(knowTitle(page)).toBeVisible();
    await expect(page.getByRole('region', { name: 'About this project' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Where this branch stands' })).toHaveCount(0);
    await expect(page.getByText('This checkout isn’t on a branch, so I drafted only “About this project”.')).toBeVisible();
    await page.locator('.know-actions').getByRole('button', { name: 'Remember', exact: true }).click();
    await expect(taskBox(page)).toBeVisible();
    expect(audits(f, ['memory-active']).length).toBe(1);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('the large-repo fallback still drafts', async () => {
  const f = setup('first-run-large-'); plainClis(f);
  // About 1.2 MB of paths: more than one bounded Git listing (1 MiB), so the overview lists top-level entries only.
  // The tree is built in the index (no files on disk), which is all the draft reads.
  const git = (args: string[], input?: string) => execFileSync('git', ['-C', f.project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { input, stdio: 'pipe', encoding: 'utf8' });
  const blob = git(['hash-object', '-w', '--stdin'], 'x\n').trim();
  const lines = Array.from({ length: 13000 }, (_, i) => `100644 ${blob}\tgenerated/${'n'.repeat(80)}${i}.txt`).join('\n');
  git(['update-index', '--index-info'], `${lines}\n`); git(['commit', '-qm', 'Generated files']);
  git(['reset', '-q', '--hard']);
  const { app, page } = await launch(f.env);
  try {
    await firstRunHook(app); await openDialogReturns(app, f.project);
    await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
    await expect(knowTitle(page)).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/^Drafted from Git: README, 1 top-level entry, 2 commits/)).toBeVisible();
    const about = page.getByRole('region', { name: 'About this project' });
    await expect(about).toContainText('too large to count files per directory');
    await expect(about).toContainText('generated');
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('a signed-out Codex says Sign in needed and signs in from its row', async () => {
  const f = setup('first-run-codex-');
  const marker = JSON.stringify(resolve(f.home, '.codex-signed-in'));
  f.cli('claude', `if(a[0]==='--version'){console.log('1.0.0');process.exit(0)}\nprocess.stdin.resume();`);
  f.cli('codex', `if(a[0]==='--version'){console.log('codex-cli 0.40.0');process.exit(0)}
if(a.join(' ')==='--help'){console.log('Usage: codex [OPTIONS] [PROMPT]\\n\\nCommands:\\n  exec    Run non-interactively\\n  login   Manage login');process.exit(0)}
if(a.join(' ')==='login --help'){console.log('Usage: codex login [OPTIONS] [COMMAND]\\n\\nCommands:\\n  status  Show login status');process.exit(0)}
if(a.join(' ')==='login status'){if(fs.existsSync(${marker})){console.error('Logged in using ChatGPT (person@example.com)');process.exit(0)}console.error('Not logged in');process.exit(1)}
if(a.join(' ')==='login'){console.log('Sign in at https://auth.example/device');fs.writeFileSync(${marker},'');process.exit(0)}
process.stdin.resume();`);
  const { app, page } = await launch(f.env);
  try {
    await app.evaluate(() => { (globalThis as any).__journalAuthProbes = true; });
    const codex = agentRows(page).nth(1);
    await expect(codex).toContainText('Installed · codex-cli 0.40.0');
    await codex.getByRole('button', { name: 'Check again: Codex' }).click();
    await expect(codex).toContainText('Sign in needed');
    await codex.getByRole('button', { name: 'Sign in to Codex…' }).click();
    const dialog = page.locator('.process-dialog');
    await expect(dialog.getByRole('heading', { name: 'Sign in to Codex' })).toBeVisible();
    await expect(dialog).toContainText('Running codex login');
    await expect(dialog.getByRole('status')).toContainText('exit 0');
    await dialog.getByRole('button', { name: 'Done' }).click();
    // Main checks Codex again after the sign-in ends; the row follows without Check again.
    await expect(codex).toContainText('Installed · codex-cli 0.40.0 · Signed in');
    await expect(codex.getByRole('status')).toHaveText('Signed in to Codex.');
    await expect(codex.getByRole('button')).toHaveCount(0);
    expect(await codex.textContent()).not.toContain('@');
    // The composer's Codex card agrees with the row.
    await openDialogReturns(app, f.project); await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
    const card = page.getByRole('radio', { name: 'Codex', exact: true });
    await expect(card).toContainText('Installed · codex-cli 0.40.0 · Signed in');
    expect(await card.textContent()).not.toContain('@');
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('reduced motion shows the first-note text without animation', async () => {
  const f = setup('first-run-motion-'); plainClis(f);
  const { app, page } = await launch(f.env);
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await firstRunHook(app); await openDialogReturns(app, f.project);
    await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
    await expect(knowTitle(page)).toBeVisible();
    await page.locator('.know-actions').getByRole('button', { name: 'Remember both' }).click();
    const moment = page.locator('.first-note');
    await expect(moment).toContainText('First note remembered.');
    // Never waits on an animation: under reduced motion there is none to wait for.
    expect(await moment.evaluate(el => [el, ...el.querySelectorAll('*')].flatMap(node => node.getAnimations()).length)).toBe(0);
    expect(await moment.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});
