import { test, expect } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentProject, sessionStatus, startSession, taskBox } from './support/ui';
import { fixtureEnv } from './support/env';

test.skip(process.platform === 'win32', 'POSIX fixture CLIs');

function setup() {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'reload-')); const project = resolve(root, 'reload project'); const bin = resolve(root, 'bin'); const home = resolve(root, 'home');
  for (const dir of [project, bin, home]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# Reload fixture\n'); git('add', '.'); git('commit', '-qm', 'init');
  const other = resolve(root, 'second project'); mkdirSync(other);
  const git2 = (...args: string[]) => execFileSync('git', ['-C', other, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git2('init', '-q', '-b', 'main'); writeFileSync(resolve(other, 'README.md'), '# Second\n'); git2('add', '.'); git2('commit', '-qm', 'init');
  const fixture = `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}\nconsole.log('TASK '+(process.argv.at(-1)||''));process.stdin.resume();`;
  for (const p of ['claude', 'codex']) { writeFileSync(resolve(bin, p), fixture); chmodSync(resolve(bin, p), 0o755); }
  const env = fixtureEnv(root, bin, { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' });
  return { root, project, other, env };
}

// A renderer reload (⌘R / Ctrl+R in development builds; released builds have no
// Reload item, decision D13) reopens the project that was showing, even when it
// comes straight after Open a project…, before the workspace list has answered.
test('a renderer reload straight after opening a project keeps it open', async () => {
  const f = setup();
  const app = await electron.launch({ args: ['.'], env: f.env });
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, f.project);
  const page = await app.firstWindow();
  try {
    // Hold the workspace list so the reload lands before it answers (the window in which the project used to be forgotten).
    await app.evaluate(() => {
      (globalThis as any).__journalRequestHook = async (method: string, run: () => unknown) => { if (method === 'workspaces') await new Promise(done => setTimeout(done, 1500)); return run(); };
    });
    await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
    await expect(taskBox(page)).toBeVisible();
    await expect(currentProject(page)).toHaveText(/^reload project/);
    await page.reload();
    await expect(taskBox(page)).toBeVisible();
    await expect(currentProject(page)).toHaveText(/^reload project/);
    await expect(page.getByRole('button', { name: 'Open a project…', exact: true })).toHaveCount(0);
  } finally { await app.close().catch(() => {}); rmSync(f.root, { recursive: true, force: true }); }
});

// Selecting a session of another project (here through a notification click, as the palette and
// the recovery list do) shows that project; a reload must reopen it, not the one shown before.
test('a reload after selecting a session in another project reopens that project', async () => {
  const f = setup();
  const app = await electron.launch({ args: ['.'], env: f.env });
  const page = await app.firstWindow();
  const openReturns = (path: string) => app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, path);
  try {
    await openReturns(f.project);
    await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
    await expect(taskBox(page)).toBeVisible();
    await startSession(page, 'claude', { task: 'FIRST_PROJECT_TASK' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    const sessionId = await page.evaluate(async () => {
      const journal = (window as any).journal; const projectId = (await journal.request('projects'))[0].id;
      return (await journal.request('project', { projectId })).sessions[0].id as string;
    });
    await openReturns(f.other);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('journal:event', { type: 'command', id: 'open-project' }));
    await expect(currentProject(page)).toHaveText(/^second project/);
    await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.getAllWindows()[0].webContents.send('journal:event', { type: 'focus-session', sessionId: id }); }, sessionId);
    await expect(currentProject(page)).toHaveText(/^reload project/);
    await page.reload();
    await expect(currentProject(page)).toHaveText(/^reload project/);
  } finally { await app.close().catch(() => {}); rmSync(f.root, { recursive: true, force: true }); }
});
