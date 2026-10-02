import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';

test('empty-task launches carry an approved repo overview and current branch update to either provider', async () => {
  test.skip(process.platform === 'win32', 'POSIX provider fixture; native Windows is verified separately');
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'brief-')); const project = resolve(root, 'orientation project'); const bin = resolve(root, 'bin');
  mkdirSync(project); mkdirSync(bin);
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), 'REPO_PURPOSE: a fixture developer cockpit with reviewed project memory.\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture overview');
  const fixture = `#!${process.execPath}
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
console.log('PTY_READY '+process.stdout.isTTY);console.log(JSON.stringify(process.argv.slice(2)));
process.stdin.setRawMode(true);process.stdin.resume();`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env });
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await page.getByRole('button', { name: 'Add project brief', exact: true }).click();
    await expect(page.getByLabel('Scope')).toHaveValue('checkout');
    await page.getByLabel('Statement', { exact: true }).fill('REPO_PURPOSE: a fixture developer cockpit with reviewed project memory.');
    await page.getByLabel('Source type').selectOption('file'); await page.getByLabel('Source path').fill('README.md');
    await page.getByRole('button', { name: 'Save for review' }).click();
    await page.getByRole('button', { name: 'Preview context' }).click();
    await expect(page.getByTestId('context-packet')).not.toContainText('REPO_PURPOSE');
    await page.getByRole('tab', { name: /^Knowledge/ }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const addUpdate = async (statement: string) => {
      await page.getByRole('button', { name: 'Add project brief', exact: true }).click();
      await page.getByLabel('Scope').selectOption('branch');
      await page.getByLabel('Statement', { exact: true }).fill(statement);
      await page.getByLabel('Source note').fill('Explicit reviewed branch progress for the local fixture');
      await page.getByRole('button', { name: 'Save for review' }).click();
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
    };
    await addUpdate('MAIN_PROGRESS: baseline is complete; next is native lifecycle validation.');
    await expect(page.getByLabel('Initial task')).toHaveValue('');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('REPO_PURPOSE');
    await expect(page.locator('.terminal-surface')).toContainText('MAIN_PROGRESS');
    await expect(page.getByTestId('context-packet')).toContainText('Project brief');
    await expect(page.getByTestId('context-packet')).toContainText('Branch update');
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect(page.getByRole('button', { name: 'Start Codex', exact: true })).toBeEnabled();
    git('switch', '-c', 'feature');
    await page.getByRole('button', { name: /orientation project/ }).click();
    await page.getByRole('tab', { name: /^Knowledge/ }).click();
    await addUpdate('FEATURE_PROGRESS: feature work is underway; next is feature review.');
    await page.getByRole('button', { name: 'Start Codex', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('REPO_PURPOSE');
    await expect(page.locator('.terminal-surface')).toContainText('FEATURE_PROGRESS');
    await expect(page.locator('.terminal-surface')).not.toContainText('MAIN_PROGRESS');
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect(page.getByRole('button', { name: 'Start Claude', exact: true })).toBeEnabled();
    // Withdrawing a status update excludes it from subsequent context.
    await page.getByRole('tab', { name: /^Knowledge/ }).click();
    const card = page.locator('.memory-card').filter({ hasText: 'FEATURE_PROGRESS' });
    await card.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await page.getByRole('button', { name: 'Preview context' }).click();
    await expect(page.getByTestId('context-packet')).toContainText('REPO_PURPOSE');
    await expect(page.getByTestId('context-packet')).not.toContainText('FEATURE_PROGRESS');
    // Leaving a claim out applies to the next start only and is recorded.
    await page.getByRole('button', { name: 'Leave out for this task' }).first().click();
    await expect(page.getByTestId('context-packet')).not.toContainText('REPO_PURPOSE');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY');
    await expect(page.locator('.terminal-surface')).not.toContainText('REPO_PURPOSE');
    await expect(page.getByText(/left out by you/)).toBeAttached();
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await page.getByRole('button', { name: 'Preview context' }).click();
    await expect(page.getByTestId('context-packet')).toContainText('REPO_PURPOSE');
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
