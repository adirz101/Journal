import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openSettings } from './support/ui';
import { fixtureEnv } from './support/env';

// Cursor level 2 (plan 4.6): Settings shows the exact change to the (fixture) home's
// ~/.cursor/hooks.json and writes it only after the user presses the button under it.
// The fixture home is fixtureEnv's; the user's real ~/.cursor is never read or written.
test('Cursor turn status: the exact change is shown first, written only on confirmation, and removable', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'cursor-hooks-'));
  const bin = resolve(root, 'bin'); mkdirSync(bin);
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  const home = env.HOME; const file = resolve(home, '.cursor', 'hooks.json');
  mkdirSync(resolve(home, '.cursor'), { recursive: true });
  const theirs = { version: 1, hooks: { stop: [{ command: 'their-stop.sh' }] } };
  writeFileSync(file, JSON.stringify(theirs));
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Runtime connected')).toBeVisible();
    await openSettings(page);
    const section = page.getByRole('region', { name: 'Cursor turn status' });
    await expect(section.getByRole('status')).toHaveText(/Not set up/);
    await section.getByRole('button', { name: 'Show the change…' }).click();
    // Before and after are shown; nothing is written yet.
    await expect(section.getByText('their-stop.sh').first()).toBeVisible();
    await expect(section.locator('.cursor-hooks-text').nth(1)).toContainText('afterAgentResponse');
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(theirs));
    // Cancel writes nothing either.
    await section.getByRole('button', { name: 'Cancel' }).click();
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(theirs));
    // Show again, then make the change.
    await section.getByRole('button', { name: 'Show the change…' }).click();
    await section.getByRole('button', { name: 'Make this change' }).click();
    await expect(section.getByRole('status')).toHaveText(/Done/);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.hooks.stop[0]).toEqual({ command: 'their-stop.sh' });
    expect(written.hooks.stop).toHaveLength(2);
    expect(written.hooks.afterAgentResponse).toHaveLength(1);
    expect(written.hooks.stop[1].command).toContain('journal-hook');
    // Removing takes out only Journal's entries.
    await section.getByRole('button', { name: 'Remove Journal’s entries…' }).click();
    await section.getByRole('button', { name: 'Remove these entries' }).click();
    await expect(section.getByRole('status')).toHaveText(/Removed/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(theirs);
    // A plan whose file changed after it was shown is refused.
    await section.getByRole('button', { name: 'Show the change…' }).click();
    writeFileSync(file, JSON.stringify({ version: 1, hooks: { stop: [{ command: 'newer.sh' }] } }));
    await section.getByRole('button', { name: 'Make this change' }).click();
    await expect(section.getByRole('status')).toHaveText(/changed since/);
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.stop).toEqual([{ command: 'newer.sh' }]);
    expect(existsSync(resolve(home, '.cursor', 'hooks.json'))).toBe(true);
  } finally {
    await app.close(); rmSync(root, { recursive: true, force: true });
  }
});
