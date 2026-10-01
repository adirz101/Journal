import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('the branded macOS runtime opens Journal without an app argument and keeps explicit user data', async () => {
  test.skip(process.platform !== 'darwin', 'Local macOS bundle identity');
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const directory = mkdtempSync(resolve('.cache/tmp', 'identity-'));
  const data = resolve(directory, 'data');
  const executablePath = execFileSync(process.execPath, ['--input-type=module', '-e', "import { journalElectron } from './scripts/electron-runtime.mjs'; process.stdout.write(journalElectron());"], { encoding: 'utf8' });
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), JOURNAL_DATA_DIR: data, JOURNAL_QUIT_POLICY: 'stop' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath, args: [], env });
  try {
    const identity = await app.evaluate(({ app }) => ({ name: app.getName(), data: app.getPath('userData'), executable: app.getPath('exe') }));
    expect(identity.name).toBe('Journal');
    expect(identity.data).toBe(data);
    expect(identity.executable).toContain('/Journal.app/');
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Your project, remembered.' })).toBeVisible();
    const images = await page.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0));
    expect(images).toBe(true);
  } finally {
    await app.close(); rmSync(directory, { recursive: true, force: true });
  }
});
