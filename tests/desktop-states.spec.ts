import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chooseAgent, newSession, sessionStatus, slotsUsed, startButton, startSession, taskBox } from './support/ui';
import { fixtureEnv } from './support/env';

// Phase 8 Group B: failure states (board 9): runtime disconnected, crash recovery, an agent
// that can't start, and all slots in use. Real Electron, runtime and node-pty with fixture
// CLIs; hidden windows, no notifications, no real provider logins.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

// codexAuth: the Codex fixture answers `login status` (signed out until `login` runs), so the
// Phase 7 sign-in probe reports it; every other argument is a session.
function setup(name: string, { codexAuth = false } = {}) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`));
  const project = resolve(root, 'states project'); const bin = resolve(root, 'bin'); const home = resolve(root, 'home'); mkdirSync(project); mkdirSync(bin); mkdirSync(home);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# States fixture\n'); git('add', '.'); git('commit', '-qm', 'init');
  const ledger = resolve(root, 'launches.jsonl'); const signedIn = resolve(root, 'codex-signed-in');
  const auth = codexAuth ? `const a=process.argv.slice(2);
if(a.join(' ')==='--help'){console.log('Usage: codex [OPTIONS] [PROMPT]\\n\\nCommands:\\n  exec    Run non-interactively\\n  login   Manage login');process.exit(0)}
if(a.join(' ')==='login --help'){console.log('Usage: codex login [OPTIONS] [COMMAND]\\n\\nCommands:\\n  status  Show login status');process.exit(0)}
if(a.join(' ')==='login status'){if(fs.existsSync(${JSON.stringify(signedIn)})){console.error('Logged in using ChatGPT');process.exit(0)}console.error('Not logged in');process.exit(1)}
if(a.join(' ')==='login'){console.log('Signed in (fixture)');fs.writeFileSync(${JSON.stringify(signedIn)},'');process.exit(0)}` : '';
  const fixture = (withAuth: boolean) => `#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
${withAuth ? auth : ''}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})+'\\n');
console.log('TASK '+(process.argv.at(-1)||'').split('\\n').at(-1));process.stdin.setRawMode(true);process.stdin.resume();`;
  const write = (provider: string) => { writeFileSync(resolve(bin, provider), fixture(provider === 'codex')); chmodSync(resolve(bin, provider), 0o755); };
  for (const provider of ['claude', 'codex']) write(provider);
  const env = fixtureEnv({ root, bin, home, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  delete env.ELECTRON_RUN_AS_NODE;
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const runtimeInfo = () => JSON.parse(readFileSync(resolve(root, 'data/runtime.json'), 'utf8'));
  const cleanup = () => {
    for (const pid of launches().map(entry => entry.pid)) { try { if (execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(root)) process.kill(pid, 'SIGKILL'); } catch {} }
    try { const info = runtimeInfo(); if (execFileSync('ps', ['-p', String(info.pid), '-o', 'command='], { encoding: 'utf8' }).includes('runtime.mjs')) process.kill(info.pid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { root, project, bin, env, launches, runtimeInfo, write, cleanup };
}

async function open(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
  await expect(taskBox(page)).toBeVisible();
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; }
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(resolveWait => setTimeout(resolveWait, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
const request = async (page: Page, action: string, input: object = {}) => {
  const result = await page.evaluate(([a, i]) => (window as any).journal.settle(a, i), [action, input] as const);
  if (!result.ok) throw new Error(result.error); return result.value;
};
const recoveryPanel = (page: Page) => page.getByRole('region', { name: 'The session runtime stopped unexpectedly' });
const startError = (page: Page) => page.locator('.start-error');

test('runtime crash → the recovery panel lists the interrupted sessions; nothing is resent until Continue; Done hides it, also after a reload', async () => {
  const f = setup('states-crash'); const { app, page } = await open(f.env, f.project);
  try {
    await startSession(page, 'claude', { task: 'CLAUDE_CRASH' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK CLAUDE_CRASH');
    await startSession(page, 'codex', { task: 'CODEX_CRASH' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK CODEX_CRASH');
    const before = f.runtimeInfo(); process.kill(before.pid, 'SIGKILL');
    const panel = recoveryPanel(page);
    await expect(panel).toBeVisible({ timeout: 20000 });
    await expect(panel).toContainText('2 sessions were interrupted. Nothing was resent to the agents.');
    const claudeRow = panel.getByRole('listitem').filter({ hasText: 'CLAUDE_CRASH' });
    const codexRow = panel.getByRole('listitem').filter({ hasText: 'CODEX_CRASH' });
    await expect(claudeRow.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    // An interrupted Codex session without a confirmed ID needs it first.
    await expect(codexRow).toContainText('Needs the conversation ID before continuing');
    await page.waitForTimeout(500);
    expect(f.launches()).toHaveLength(2); // nothing was resent
    // The ended terminal is unavailable, not an error: no app banner beside the panel (review I1).
    await expect(page.locator('.error-banner')).toHaveCount(0);
    await codexRow.getByRole('button', { name: 'Confirm ID…', exact: true }).click();
    await expect(page.locator('.session-header')).toContainText('CODEX_CRASH');
    await expect(sessionStatus(page)).toContainText('Interrupted');
    // A window resize reaches no live terminal: still no banner.
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const [width, height] = w.getSize(); w.setSize(width - 40, height); });
    await page.waitForTimeout(500);
    await expect(page.locator('.error-banner')).toHaveCount(0);
    // Continue reopens the same Claude conversation (exact ID), only when clicked.
    await claudeRow.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => f.launches().length).toBe(3);
    const resumed = f.launches()[2].argv as string[];
    expect(resumed).toContain('--resume'); expect(resumed[resumed.indexOf('--resume') + 1]).toBe((f.launches()[0].argv as string[])[(f.launches()[0].argv as string[]).indexOf('--session-id') + 1]);
    await expect(claudeRow).toHaveCount(0);
    await expect(codexRow).toBeVisible();
    await expect(page.locator('.error-banner')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(async () => (await request(page, 'bootstrap')).recovery).toBeNull();
    await page.reload();
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(recoveryPanel(page)).toHaveCount(0);
    expect(f.launches()).toHaveLength(3);
  } finally { await closeApp(app); f.cleanup(); }
});

test('disconnected banner: Reconnect now waits for the next runtime event, and the runtime reconnects by itself', async () => {
  const f = setup('states-banner'); const { app, page } = await open(f.env, f.project);
  try {
    const emit = (event: object) => app.evaluate(({ BrowserWindow }, data) => { BrowserWindow.getAllWindows()[0].webContents.send('journal:event', data); }, event);
    await emit({ type: 'runtime', state: 'disconnected', warning: 'The Journal runtime could not be started. See runtime.log in the data directory.' });
    const banner = page.getByRole('status').filter({ hasText: 'Lost connection to the session runtime' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Your agents may still be running. Journal is trying again every few seconds.');
    await expect(banner).toContainText('could not be started');
    await banner.getByRole('button', { name: 'Reconnect now', exact: true }).click();
    await expect(banner.getByRole('button', { name: 'Reconnecting…', exact: true })).toBeDisabled();
    // The next runtime event re-enables it; a connected one removes the banner.
    await emit({ type: 'runtime', state: 'disconnected' });
    await expect(banner.getByRole('button', { name: 'Reconnect now', exact: true })).toBeEnabled();
    await expect(banner).not.toContainText('could not be started');
    await emit({ type: 'runtime', state: 'connected', recovered: true, recovery: null });
    await expect(banner).toHaveCount(0);
    // A real crash: the runtime is relaunched and the banner goes once it is back. Reconnect now,
    // asked the moment the disconnect arrives (before the relaunch connects), retries: retrying is true.
    await page.evaluate(() => { const w = window as any; w.__retry = null; const off = w.journal.onEvent((event: any) => { if (event.type === 'runtime' && event.state === 'disconnected' && !w.__retry) { w.__retry = w.journal.request('reconnectRuntime', {}); off?.(); } }); });
    const before = f.runtimeInfo(); process.kill(before.pid, 'SIGKILL');
    await expect.poll(() => page.evaluate(async () => { const retry = (window as any).__retry; return retry ? await retry : null; }), { timeout: 20000 }).toEqual({ retrying: true });
    await expect.poll(() => { try { return f.runtimeInfo().runtimeId !== before.runtimeId; } catch { return false; } }, { timeout: 20000 }).toBe(true);
    await expect(page.getByText('Runtime connected')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('Lost connection to the session runtime')).toHaveCount(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('a provider removed after detection → "isn’t installed" with Install… and Check again; the task text is kept', async () => {
  // The Codex CLI disappears after detection: the runtime looks for it before preparing any
  // context, so the start is refused with PROVIDER_MISSING and nothing is sent (review I4).
  const f = setup('states-missing');
  const codexCli = resolve(f.bin, 'codex'); const fixture = readFileSync(codexCli);
  const { app, page } = await open(f.env, f.project);
  try {
    const codex = page.getByRole('radiogroup', { name: 'Agent' }).getByRole('radio', { name: 'Codex', exact: true });
    await expect(codex).toContainText('Installed');
    await chooseAgent(page, 'codex');
    await taskBox(page).fill('KEEP_THIS_TASK');
    rmSync(codexCli);
    await startButton(page).click();
    const card = startError(page);
    await expect(card).toHaveAttribute('role', 'alert');
    await expect(card).toContainText('Codex isn’t installed');
    await expect(card).toContainText('Your task text is kept. Nothing was sent.');
    // A missing agent's terminal action runs its installer, so it says so (review M8).
    await expect(card.getByRole('button', { name: 'Install…', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Open terminal', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Check again', exact: true })).toBeVisible();
    await expect(taskBox(page)).toHaveValue('KEEP_THIS_TASK');
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(f.launches()).toHaveLength(0);
    // No session and no receipt were recorded for the refused start.
    const state = await request(page, 'project', { projectId: (await request(page, 'bootstrap')).projects[0].id });
    expect(state.sessions).toHaveLength(0); expect(state.receipts).toHaveLength(0);
    // Installed again: Check again clears the card.
    writeFileSync(codexCli, fixture); chmodSync(codexCli, 0o755);
    await card.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect(card).toHaveCount(0, { timeout: 15000 });
    await expect(startButton(page)).toBeEnabled();
    await expect(taskBox(page)).toHaveValue('KEEP_THIS_TASK');
  } finally { await closeApp(app); f.cleanup(); }
});

test('a signed-out fixture provider → StartError with its login command, Copy command and Open terminal', async () => {
  const f = setup('states-signin', { codexAuth: true }); const { app, page } = await open(f.env, f.project);
  try {
    await app.evaluate(() => { (globalThis as any).__journalAuthProbes = true; });
    await request(page, 'providerStatus', { provider: 'codex', fresh: true });
    await chooseAgent(page, 'codex');
    const card = startError(page);
    await expect(card).toContainText('Codex isn’t signed in');
    await expect(card).toHaveAttribute('role', 'status');
    await expect(card).toContainText('Sign in once in a terminal, then start again. Journal never handles your login.');
    await expect(card.locator('code')).toHaveText('codex login');
    await expect(card.getByRole('button', { name: 'Copy command', exact: true })).toBeVisible();
    // Start stays enabled: the CLI shows its own login, and the check may lag.
    await expect(startButton(page)).toBeEnabled();
    // Open terminal runs main's constant `codex login` in a visible terminal; its exit checks again.
    await card.getByRole('button', { name: 'Open terminal', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Codex' });
    await expect(dialog).toContainText('Running codex login');
    await expect(dialog.getByText('Finished (exit 0).')).toBeVisible({ timeout: 15000 });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(card).toHaveCount(0, { timeout: 15000 });
    expect(f.launches()).toHaveLength(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('four idle sessions stay open while a fifth session starts from the composer', async () => {
  const f = setup('states-full'); const { app, page } = await open(f.env, f.project);
  try {
    for (let i = 0; i < 4; i++) {
      await startSession(page, i % 2 ? 'codex' : 'claude', { task: `FULL_${i}` });
      await expect(page.locator('.terminal-surface')).toContainText(`TASK FULL_${i}`);
    }
    await expect(slotsUsed(page, 4)).toBeVisible();
    const button = page.locator('.sidebar .new-session');
    await expect(button).toBeEnabled();
    await newSession(page);
    await taskBox(page).fill('WAITING_TASK');
    await expect(startButton(page)).toBeEnabled();
    await expect(taskBox(page)).toHaveValue('WAITING_TASK');
    await expect(startError(page)).toHaveCount(0);
    await startButton(page).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK WAITING_TASK');
    await expect.poll(() => f.launches().length).toBe(5);
    await expect(slotsUsed(page, 5)).toBeVisible();
  } finally { await closeApp(app); f.cleanup(); }
});
