import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { newSession, openSettings, startSession, statusBar } from './support/ui';

// Development and test builds never contact GitHub; the update UI is driven by
// sending the window the same events the updater sends.
test('update notices: progress, restart only for a downloaded update, settings in Data and backups', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'updates-'));
  // A fixture Claude CLI, so a session (and its status bar) can be shown.
  const bin = resolve(root, 'bin'); mkdirSync(bin);
  writeFileSync(resolve(bin, 'claude'), `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}\nconsole.log('PTY_READY');process.stdin.setRawMode(true);process.stdin.resume();\n`); chmodSync(resolve(bin, 'claude'), 0o755);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Runtime connected')).toBeVisible();
    await expect(page.locator('.update-notice')).toHaveCount(0);

    await openSettings(page, 'updates');
    await expect(page.getByRole('heading', { name: 'Updates' })).toBeVisible();
    await expect(page.getByText(/Updates are available in installed builds only/)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    // Check for Updates… in the application menu reports the result in a dialog.
    const menuDialog = await app.evaluate(async ({ dialog, Menu }) => {
      let shown: { message?: string } | null = null;
      dialog.showMessageBox = (async (...args: unknown[]) => { shown = args.at(-1) as { message?: string }; return { response: 0, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
      Menu.getApplicationMenu()?.getMenuItemById('check-for-updates')?.click();
      for (let i = 0; i < 50 && !shown; i++) await new Promise(resolve => setTimeout(resolve, 50));
      return (shown as { message?: string } | null)?.message ?? null;
    });
    expect(menuDialog).toBe('Updates are available in installed builds only.');

    const emit = (state: object) => app.evaluate(({ BrowserWindow }, update) => {
      BrowserWindow.getAllWindows()[0].webContents.send('journal:event', { type: 'update', state: { mode: 'auto', current: '0.2.0-alpha.2', message: null, automatic: true, installing: false, ...update } });
    }, state);
    await emit({ status: 'downloading', version: '0.2.0-alpha.3', percent: 37 });
    await expect(page.locator('.update-notice')).toHaveText('Downloading Journal 0.2.0-alpha.3… 37%');
    await expect(page.getByRole('button', { name: 'Restart to update' })).toHaveCount(0);

    await emit({ status: 'ready', version: '0.2.0-alpha.3', percent: 100 });
    await expect(page.locator('.update-notice')).toContainText('Journal 0.2.0-alpha.3 is ready.');
    // The main process installs only what electron-updater downloaded, whatever the window shows.
    await page.getByRole('button', { name: 'Restart to update' }).click();
    await expect(page.getByRole('alert')).toContainText('No downloaded update is ready to install');
    await expect(page.getByRole('button', { name: 'Restart to update' })).toBeEnabled();

    await emit({ status: 'available', mode: 'notify', version: '0.2.0-alpha.3', percent: null });
    await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
    // A failure after the user chose to install is shown; background check failures are not.
    await emit({ status: 'error', version: null, percent: null, message: 'offline' });
    await expect(page.locator('.update-notice')).toHaveText('The update could not be installed: offline');
    await page.reload(); await expect(page.getByText('Runtime connected')).toBeVisible();
    await emit({ status: 'ready', version: '0.2.0-alpha.3', percent: 100 }); await expect(page.getByRole('button', { name: 'Restart to update' })).toBeVisible();
    await emit({ status: 'error', version: null, percent: null, message: 'offline' });
    await expect(page.locator('.update-notice')).toHaveCount(0);

    // With a project open but no session shown, the notice stays in the sidebar footer.
    const project = resolve(root, 'project'); mkdirSync(project);
    execFileSync('git', ['init', '-q', '-b', 'main', project]);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await expect(page.getByLabel('Task', { exact: true })).toBeVisible();
    await emit({ status: 'ready', version: '0.2.0-alpha.4', percent: 100 });
    await expect(page.locator('.sidebar-footer .update-notice')).toContainText('Journal 0.2.0-alpha.4 is ready.');
    // With a session shown, it moves to the right of the session's status bar.
    if (process.platform !== 'win32') {
      await startSession(page, 'claude');
      await expect(page.locator('.terminal-surface')).toContainText('PTY_READY');
      await expect(statusBar(page).locator('.update-notice')).toContainText('Journal 0.2.0-alpha.4 is ready.');
      await expect(page.locator('.sidebar-footer .update-notice')).toHaveCount(0);
      await expect(statusBar(page).getByRole('button', { name: 'Restart to update' })).toBeVisible();
    }
    if (process.env.JOURNAL_SCREENSHOT) { await page.screenshot({ path: process.env.JOURNAL_SCREENSHOT }); await statusBar(page).screenshot({ path: process.env.JOURNAL_SCREENSHOT.replace('.png', '-bar.png') }); }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
