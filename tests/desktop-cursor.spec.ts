import { test, expect, type ElectronApplication, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chooseAgent, filesView, inspectorTab, newSession, sessionStatus, startButton, startSession } from './support/ui';

// Cursor as a third provider with fake CLIs: install (confirmed, visible,
// failure and success), PATH not refreshed, sign-in, launch with an exact chat
// ID, Ask mode, references, exact resume and side-by-side sessions.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs');

const CHAT = '11111111-2222-4333-8444-555555555555';
const answer = (app: ElectronApplication, response: number) => app.evaluate(({ dialog }, r) => { (dialog as any).showMessageBox = async (_w: unknown, options: any) => { (globalThis as any).__lastDialog = options; return { response: r }; }; }, response);
async function menu(app: ElectronApplication, choice: string | null) {
  await app.evaluate((_electron, next) => { (globalThis as any).__journalMenuHook = (items: any[]) => { (globalThis as any).__lastMenu = items; return next; }; }, choice);
}

test('Cursor installs visibly after confirmation, signs in with its own flow and runs beside Claude', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'cursor-')); const project = resolve(root, 'cursor project'); const bin = resolve(root, 'bin'); const home = resolve(root, 'home');
  for (const dir of [project, bin, home]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# Cursor fixture\n'); git('add', '.'); git('commit', '-qm', 'init');
  const ledger = resolve(root, 'launches.jsonl');
  const interactive = `if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
require('node:fs').appendFileSync(${JSON.stringify(ledger)},JSON.stringify({bin:require('node:path').basename(process.argv[1]),argv:process.argv.slice(2),cwd:process.cwd()})+'\\n');
console.log('RAN '+JSON.stringify(process.argv.slice(2,4)));process.stdin.setRawMode(true);process.stdin.resume();`;
  for (const p of ['claude', 'codex']) { writeFileSync(resolve(bin, p), `#!${process.execPath}\n${interactive}`); chmodSync(resolve(bin, p), 0o755); }
  // The fake Cursor CLI the fixture installer puts in ~/.local/bin (not on Journal's PATH).
  const cursorDir = resolve(home, '.local', 'bin'); const loggedIn = resolve(home, '.cursor-fake-login');
  const cursorCli = `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('2026.10.01-e373342');process.exit(0)}
if(a[0]==='--help'){console.log('Start the Cursor Agent\\n  --resume [chatId]\\n  --mode <mode>\\n  login\\n  create-chat');process.exit(0)}
if(a[0]==='create-chat'){console.log(${JSON.stringify(CHAT)});process.exit(0)}
if(a[0]==='status'){const ok=fs.existsSync(${JSON.stringify(loggedIn)});console.log(a.includes('--format')?JSON.stringify({authenticated:ok}):ok?'Logged in':'Not logged in');process.exit(0)}
if(a[0]==='login'){console.log('Open this URL to sign in: https://cursor.example/login');fs.writeFileSync(${JSON.stringify(loggedIn)},'');console.log('Logged in');process.exit(0)}
${interactive}`;
  const installer = resolve(root, 'installer.js'); const failInstall = resolve(root, 'fail-install');
  writeFileSync(installer, `#!${process.execPath}
const fs=require('node:fs');console.log('Installing Cursor Agent CLI…');
if(fs.existsSync(${JSON.stringify(failInstall)})){console.error('Download failed');process.exit(3)}
fs.mkdirSync(${JSON.stringify(cursorDir)},{recursive:true});fs.writeFileSync(${JSON.stringify(resolve(cursorDir, 'agent'))},${JSON.stringify(cursorCli)});fs.chmodSync(${JSON.stringify(resolve(cursorDir, 'agent'))},0o755);
console.log('Installed to ~/.local/bin/agent. Add ~/.local/bin to your PATH.');`);
  chmodSync(installer, 0o755); writeFileSync(failInstall, '');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin${delimiter}${resolve(process.execPath, '..')}`, HOME: home, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' };
  delete env.ELECTRON_RUN_AS_NODE;
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const app = await electron.launch({ args: ['.'], env });
  try {
    await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, project);
    await app.evaluate((_e, file) => { (globalThis as any).__journalCursorInstall = { file, args: [] }; }, installer);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    // The Cursor card is honest about the missing CLI and holds its one action; the details
    // under the cards (while Cursor is chosen) explain it and keep Check again.
    await chooseAgent(page, 'cursor');
    const card = page.getByRole('radio', { name: 'Cursor', exact: true });
    await expect(card).toContainText('Not installed');
    const install = page.getByRole('radiogroup', { name: 'Agent' }).getByRole('button', { name: 'Install… Cursor', exact: true });
    const status = page.getByRole('region', { name: 'Cursor provider status' });
    await expect(status).toContainText('Runs Cursor’s official installer in a visible terminal.');
    await expect(status.getByRole('button', { name: 'Check again: Cursor' })).toBeVisible();
    await expect(startButton(page)).toHaveText(/^Start Cursor/);
    await expect(startButton(page)).toBeDisabled();

    // Cancel: nothing runs. The dialog shows the exact official command.
    await answer(app, 1); await install.click();
    const detail = await app.evaluate(() => (globalThis as any).__lastDialog.detail as string);
    expect(detail).toContain('curl https://cursor.com/install -fsS | bash'); expect(detail).toContain('will not receive or store your Cursor credentials');
    await expect(page.locator('.process-dialog')).toHaveCount(0);

    // A failed install is shown with its exit code and never reported as installed.
    await answer(app, 0); await install.click();
    const processDialog = page.locator('.process-dialog');
    await expect(processDialog).toContainText('Download failed');
    await expect(processDialog.getByRole('status')).toContainText('exit code 3');
    await processDialog.getByRole('button', { name: 'Done' }).click();
    await expect(status).toContainText('cannot find the agent command');
    await expect(startButton(page)).toBeDisabled();

    // A successful install into ~/.local/bin, which is not on Journal's PATH.
    rmSync(failInstall);
    await install.click();
    await expect(processDialog).toContainText('Installed to ~/.local/bin/agent');
    await expect(processDialog.getByRole('status')).toContainText('exit 0');
    await processDialog.getByRole('button', { name: 'Done' }).click();
    await expect(card).toContainText('Sign in needed');
    await expect(status).toContainText('not on your PATH');

    // Sign in through Cursor's own flow, visibly.
    await page.getByRole('radiogroup', { name: 'Agent' }).getByRole('button', { name: 'Sign in… Cursor', exact: true }).click();
    await expect(processDialog).toContainText('Open this URL to sign in');
    await expect(processDialog.getByRole('status')).toContainText('exit 0');
    await processDialog.getByRole('button', { name: 'Done' }).click();
    await expect(startButton(page)).toBeEnabled();
    await expect(card).not.toContainText('Sign in needed');

    // Launch with an exact chat ID in Ask mode, beside a Claude session.
    await startSession(page, 'cursor', { task: 'Summarise the readme', mode: 'read-only' });
    await expect(page.locator('.terminal-surface')).toContainText(`RAN ["--resume=${CHAT}","--mode=ask"]`);
    await expect(sessionStatus(page)).toContainText('Read-only');
    const cursorLaunch = launches().find(l => l.bin === 'agent')!;
    expect(cursorLaunch.argv.slice(-2)).toEqual(['--', 'Summarise the readme']); // no approved knowledge yet: the task alone
    expect(cursorLaunch.argv).not.toContain('--force');
    await startSession(page, 'claude', { task: 'Claude side task', mode: 'build' });
    await expect(page.getByRole('button', { name: /^Cursor: Summarise the readme/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Claude Code: Claude side task/ })).toBeVisible();

    // A File Explorer reference is copied (never typed) and the Cursor terminal gets focus.
    await page.getByRole('button', { name: /^Cursor: Summarise the readme/ }).click();
    await inspectorTab(page, 'Files'); await filesView(page, 'all');
    await menu(app, 'refSession'); await page.getByRole('treeitem', { name: /^README\.md/ }).click({ button: 'right' });
    await expect(page.locator('.explorer-note')).toContainText('Copied README.md');
    await expect(page.locator('.explorer-note')).toContainText('Journal cannot see when Cursor is ready');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('README.md');
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.terminal-surface'))).toBe(true);

    // Stop and resume the exact chat.
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(sessionStatus(page)).toContainText('Stopped');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => launches().filter(l => l.bin === 'agent').length).toBe(2);
    expect(launches().filter(l => l.bin === 'agent')[1].argv.slice(0, 2)).toEqual([`--resume=${CHAT}`, '--mode=ask']);
    // Journal's data never contains Cursor sign-in output.
    expect(readFileSync(resolve(root, 'data', 'journal.sqlite')).includes('cursor.example/login')).toBe(false);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
