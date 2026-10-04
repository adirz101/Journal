import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentProject, newSession, projectContextMenu, sessionStatus } from './support/ui';

test.skip(process.platform === 'win32', 'POSIX fixture CLIs');

// Native menus cannot be clicked by automation; in headless test runs main
// routes them through a hook that records the items and returns a choice.
async function menu(app: ElectronApplication, choice: string | null) {
  await app.evaluate((_electron, next) => { (globalThis as any).__journalMenuHook = (items: any[]) => { (globalThis as any).__lastMenu = items; return next; }; }, choice);
}
const lastMenu = (app: ElectronApplication) => app.evaluate(() => ((globalThis as any).__lastMenu as any[]).filter(i => i.id).map(i => `${i.id}${i.enabled === false ? ':disabled' : ''}`));
const answer = (app: ElectronApplication, response: number) => app.evaluate(({ dialog }, r) => { (dialog as any).showMessageBox = async (_w: unknown, options: any) => { (globalThis as any).__lastDialog = options; return { response: r }; }; }, response);

test('right-click menus manage projects and sessions without touching files or native IDs', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'menus-')); const project = resolve(root, 'menu project'); const bin = resolve(root, 'bin'); const extra = resolve(root, 'extra');
  mkdirSync(project); mkdirSync(bin); mkdirSync(extra);
  execFileSync('git', ['init', '-q', '-b', 'main', project]); writeFileSync(resolve(project, 'README.md'), 'x\n'); execFileSync('git', ['-C', project, 'add', '.']); execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init']);
  const ledger = resolve(root, 'launches.jsonl');
  const fixture = `#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})+'\\n');
console.log('PTY_READY '+JSON.stringify(process.argv.slice(2,4)));process.stdin.setRawMode(true);process.stdin.resume();`;
  for (const p of ['claude', 'codex']) { writeFileSync(resolve(bin, p), fixture); chmodSync(resolve(bin, p), 0o755); }
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' }; delete env.ELECTRON_RUN_AS_NODE;
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const app = await electron.launch({ args: ['.'], env });
  try {
    await app.evaluate(({ dialog, shell }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); (shell as any).showItemInFolder = (p: string) => { (globalThis as any).__revealed = p; }; }, project);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    // The switcher has no project menu until the project has opened.
    await expect(currentProject(page)).toHaveText('menu project');
    const projectButton = projectContextMenu(page);
    // Project menu: rename, pin, copy path, reveal, add folder.
    await menu(app, 'rename'); await projectButton.click({ button: 'right' });
    expect(await lastMenu(app)).toEqual(['open-project', 'manage', 'rename', 'pin', 'addFolder', 'reveal', 'copyPath', 'remove']);
    await page.getByLabel('Display name').fill('Menu Renamed'); await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(projectButton).toContainText('Menu Renamed');
    await menu(app, 'pin'); await projectButton.click({ button: 'right' });
    // Pin order shows in the switcher menu, labelled.
    await expect.poll(async () => { await menu(app, null); await projectButton.click(); return (await app.evaluate(() => ((globalThis as any).__lastMenu as any[]).find(i => String(i.id).startsWith('project:'))?.label)); }).toBe('Menu Renamed · Pinned · Current');
    await menu(app, 'copyPath'); await projectButton.click({ button: 'right' });
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(project);
    await menu(app, 'reveal'); await projectButton.click({ button: 'right' });
    await expect.poll(() => app.evaluate(() => (globalThis as any).__revealed)).toBe(project);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, extra);
    await menu(app, 'addFolder'); await projectButton.click({ button: 'right' });
    await expect(page.getByLabel('Workspace')).toContainText('Folder · extra');
    // Session menu while running: stop/interrupt, no resume.
    await newSession(page); await page.getByLabel('Initial task').fill('Write the release notes');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY');
    const sessionButton = page.getByRole('button', { name: /^Claude Code: Write the release notes/ });
    await menu(app, null); await sessionButton.click({ button: 'right' });
    const running = await lastMenu(app);
    expect(running).toContain('stop'); expect(running).toContain('interrupt'); expect(running).not.toContain('resume');
    const nativeId = launches()[0].argv[1];
    await menu(app, 'copyNativeId'); await sessionButton.click({ button: 'right' });
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(nativeId);
    await menu(app, 'rename'); await sessionButton.click({ button: 'right' });
    await page.getByLabel('Session name').fill('Notes draft'); await page.getByRole('button', { name: 'Save', exact: true }).click();
    const renamed = page.getByRole('button', { name: /^Claude Code: Notes draft/ });
    await expect(renamed).toBeVisible();
    // Removing a running session never kills silently: choose "Keep running and archive".
    await answer(app, 1); await menu(app, 'remove'); await renamed.click({ button: 'right' });
    expect(await app.evaluate(() => (globalThis as any).__lastDialog.buttons)).toEqual(['Stop and remove', 'Keep running and archive', 'Cancel']);
    // A running archived session stays visible in Active (it uses a slot), marked archived.
    await expect(renamed.locator('.archived-badge')).toBeVisible();
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive(launches()[0].pid)).toBe(true); // archiving left the agent running
    await menu(app, 'unarchive'); await renamed.click({ button: 'right' });
    await expect(renamed.locator('.archived-badge')).toHaveCount(0);
    await menu(app, 'stop'); await renamed.click({ button: 'right' });
    await expect(sessionStatus(page)).toContainText('Stopped');
    await menu(app, null); await renamed.click({ button: 'right' });
    expect(await lastMenu(app)).toContain('resume'); expect(await lastMenu(app)).not.toContain('stop');
    await menu(app, 'resume'); await renamed.click({ button: 'right' });
    await expect(page.getByRole('button', { name: /^Claude Code: Notes draft/ })).toBeVisible();
    await expect.poll(() => launches().length).toBe(2);
    expect(launches()[1].argv.slice(0, 2)).toEqual(['--resume', nativeId]);
    await expect(page.getByRole('button', { name: /^Claude Code: Resume · Notes draft/ })).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(sessionStatus(page)).toContainText('Stopped');
    // Cancel changes nothing; "Stop and remove" stops the agent first, then removes it.
    await newSession(page); await page.getByLabel('Initial task').fill('Throwaway run');
    await page.getByRole('button', { name: 'Start Codex', exact: true }).click();
    const throwaway = page.getByRole('button', { name: /^Codex: Throwaway run/ });
    await expect(throwaway).toBeVisible(); await expect.poll(() => launches().length).toBe(3);
    const throwawayPid = launches()[2].pid;
    await answer(app, 2); await menu(app, 'remove'); await throwaway.click({ button: 'right' });
    await expect(throwaway).toBeVisible(); expect(alive(throwawayPid)).toBe(true);
    await answer(app, 0); await menu(app, 'remove'); await throwaway.click({ button: 'right' });
    await expect(throwaway).toHaveCount(0); await expect.poll(() => alive(throwawayPid)).toBe(false);
    // Remove a stopped session; the project keeps its files.
    await answer(app, 0); await menu(app, 'remove'); await renamed.click({ button: 'right' });
    await expect(renamed).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as any).__lastDialog.buttons)).toEqual(['Remove from Journal', 'Remove and delete history', 'Cancel']);
    await answer(app, 0); await menu(app, 'remove'); await projectButton.click({ button: 'right' });
    await expect(projectButton).toHaveAccessibleName('No project open');
    expect(existsSync(resolve(project, 'README.md')) && existsSync(resolve(project, '.git')) && existsSync(extra)).toBe(true);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
