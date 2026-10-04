import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentProject, manageProject, openAnotherProject, projectNames, switchProject } from './support/ui';

test('projects can be renamed, pinned, given extra folders and removed from Journal without touching files', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'projects-'));
  const repo = (name: string) => { const dir = resolve(root, name); mkdirSync(dir); execFileSync('git', ['init', '-q', '-b', 'main', dir]); writeFileSync(resolve(dir, 'README.md'), `${name}\n`); execFileSync('git', ['-C', dir, 'add', '.']); execFileSync('git', ['-C', dir, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init']); return dir; };
  const alpha = repo('alpha'); const beta = repo('beta'); const docs = resolve(root, 'docs'); mkdirSync(docs);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    for (const dir of [alpha, beta]) {
      await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, dir);
      await openAnotherProject(app, page);
      await expect(currentProject(page)).toHaveText(dir.endsWith('alpha') ? 'alpha' : 'beta');
    }
    const names = () => projectNames(app, page);
    await expect.poll(names).toEqual(['beta', 'alpha']);
    await manageProject(app, page, 'alpha');
    await page.getByLabel('Display name').fill('Alpha Engine');
    await page.getByRole('button', { name: 'Save name' }).click();
    await page.getByLabel(/Pin to the top/).click();
    await expect(page.getByLabel(/Pin to the top/)).toBeChecked();
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, docs);
    await page.getByRole('button', { name: 'Add folder…' }).click();
    await expect(page.getByRole('list', { name: 'Project folders' })).toContainText('folder (no Git)');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect.poll(names).toEqual(['Alpha Engine', 'beta']);
    await switchProject(app, page, 'Alpha Engine');
    await expect(currentProject(page)).toHaveText('Alpha Engine');
    // The switcher names the current project for screen readers, not only visually.
    await expect(page.locator('.project-switcher')).toHaveAccessibleName('Switch project. Current: Alpha Engine');
    await expect(page.getByLabel('Workspace')).toContainText('Folder · docs');
    await manageProject(app, page, 'Alpha Engine');
    await page.getByRole('button', { name: 'Use folder name (alpha)' }).click();
    await expect(page.getByRole('heading', { name: 'Manage alpha' })).toBeVisible();
    // "Remove from Journal" (keep data) is the first button of the native confirmation.
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async (_w: unknown, options: any) => { (globalThis as any).lastRemoveDetail = options.detail; return { response: 0 }; }; });
    await page.getByRole('button', { name: 'Remove from Journal…' }).click();
    await expect.poll(names).toEqual(['beta']);
    expect(await app.evaluate(() => (globalThis as any).lastRemoveDetail)).toContain('Your files will not be deleted.');
    expect(existsSync(resolve(alpha, 'README.md')) && existsSync(resolve(alpha, '.git')) && existsSync(docs)).toBe(true);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
