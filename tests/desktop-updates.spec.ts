import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Development and test builds never contact GitHub; the update UI is driven by
// sending the window the same events the updater sends.
test('update notices: progress, restart only for a downloaded update, settings in Data and backups', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'updates-'));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Runtime connected')).toBeVisible();
    await expect(page.locator('.update-notice')).toHaveCount(0);

    await page.getByRole('button', { name: 'Data and backups' }).click();
    await expect(page.getByRole('heading', { name: 'Updates' })).toBeVisible();
    await expect(page.getByText(/Updates are available in installed builds only/)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    const emit = (state: object) => app.evaluate(({ BrowserWindow }, update) => {
      BrowserWindow.getAllWindows()[0].webContents.send('journal:event', { type: 'update', state: { mode: 'auto', current: '0.2.0-alpha.2', message: null, automatic: true, ...update } });
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
    await emit({ status: 'error', version: null, percent: null, message: 'offline' });
    await expect(page.locator('.update-notice')).toHaveCount(0);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
