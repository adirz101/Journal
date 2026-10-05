import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chooseAgent, inspectContext, inspectorTab, newSession, sessionStatus, startButton, startSession, switchProject } from './support/ui';
import { fixtureEnv } from './support/env';

test('empty-task launches carry an approved repo overview and current branch update to either provider', async () => {
  // A long scenario: each start now begins with New session (Phase 3 split view), and hidden test windows click slowly.
  test.setTimeout(120_000);
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
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  const app = await electron.launch({ args: ['.'], env });
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    await page.getByRole('button', { name: 'Add project summary', exact: true }).click();
    await expect(page.getByLabel('Scope')).toHaveValue('checkout');
    await page.getByLabel('Statement', { exact: true }).fill('REPO_PURPOSE: a fixture developer cockpit with reviewed project memory.');
    await page.getByLabel('Source type').selectOption('file'); await page.getByLabel('Source path').fill('README.md');
    await page.getByRole('button', { name: 'Save for review' }).click();
    await inspectContext(page);
    await expect(page.getByTestId('context-packet')).not.toContainText('REPO_PURPOSE');
    await inspectorTab(page, 'Memory');
    await page.getByRole('button', { name: 'Remember', exact: true }).click();
    const addUpdate = async (statement: string) => {
      await page.getByRole('button', { name: 'Add project summary', exact: true }).click();
      await page.getByLabel('Scope').selectOption('branch');
      await page.getByLabel('Statement', { exact: true }).fill(statement);
      await page.getByLabel('Why (your words)').fill('Explicit reviewed branch progress for the local fixture');
      await page.getByRole('button', { name: 'Save for review' }).click();
      await page.getByRole('button', { name: 'Remember', exact: true }).click();
    };
    await addUpdate('MAIN_PROGRESS: baseline is complete; next is native lifecycle validation.');
    await expect(page.getByLabel('Task', { exact: true })).toHaveValue('');
    await startSession(page, 'claude');
    await expect(page.locator('.terminal-surface')).toContainText('REPO_PURPOSE');
    await expect(page.locator('.terminal-surface')).toContainText('MAIN_PROGRESS');
    await expect(page.getByTestId('context-packet')).toContainText('Project brief');
    await expect(page.getByTestId('context-packet')).toContainText('Branch update');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    await newSession(page); await chooseAgent(page, 'codex');
    await expect(startButton(page)).toBeEnabled();
    git('switch', '-c', 'feature');
    await switchProject(app, page, 'orientation project');
    await inspectorTab(page, 'Memory');
    await addUpdate('FEATURE_PROGRESS: feature work is underway; next is feature review.');
    await startSession(page, 'codex');
    await expect(page.locator('.terminal-surface')).toContainText('REPO_PURPOSE');
    await expect(page.locator('.terminal-surface')).toContainText('FEATURE_PROGRESS');
    await expect(page.locator('.terminal-surface')).not.toContainText('MAIN_PROGRESS');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    await newSession(page); await chooseAgent(page, 'claude');
    await expect(startButton(page)).toBeEnabled();
    // Withdrawing a status update excludes it from subsequent context.
    await inspectorTab(page, 'Memory');
    const card = page.locator('.memory-card').filter({ hasText: 'FEATURE_PROGRESS' });
    // Forgetting cannot be undone, so it asks first: Cancel keeps the note, Forget archives it.
    const answer = (response: number) => app.evaluate(({ dialog }, r) => { (dialog as any).showMessageBox = async (_w: unknown, options: any) => { (globalThis as any).__lastDialog = options; return { response: r }; }; }, response);
    await answer(1);
    await card.getByRole('button', { name: 'Forget…', exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__lastDialog?.message)).toBe('Forget this note?');
    expect(await app.evaluate(() => (globalThis as any).__lastDialog.detail)).toContain('FEATURE_PROGRESS');
    await expect(card.locator('.memory-state')).toHaveText('Remembered');
    await answer(0);
    await card.getByRole('button', { name: 'Forget…', exact: true }).click();
    await expect(card).toHaveCount(0);
    await inspectContext(page);
    await expect(page.getByTestId('context-packet')).toContainText('REPO_PURPOSE');
    await expect(page.getByTestId('context-packet')).not.toContainText('FEATURE_PROGRESS');
    // Leaving a claim out applies to the next start only and is recorded.
    await page.getByRole('button', { name: 'Leave out for this task' }).first().click();
    await expect(page.getByTestId('context-packet')).not.toContainText('REPO_PURPOSE');
    await startSession(page, 'claude');
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY');
    await expect(page.locator('.terminal-surface')).not.toContainText('REPO_PURPOSE');
    await expect(page.getByText(/left out by you/)).toBeAttached();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    await newSession(page);
    await inspectContext(page);
    await expect(page.getByTestId('context-packet')).toContainText('REPO_PURPOSE');
    // Suggestions are fetched once for the window (App) and reach the Memory tab:
    // a rule stated in a task becomes one shortly after its session ends, and dismissing it refetches.
    await startSession(page, 'claude', { task: 'rule: Release tags must be signed by maintainers' });
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await inspectorTab(page, 'Memory');
    const suggestion = page.locator('.proposal').filter({ hasText: 'Release tags must be signed by maintainers' });
    await expect(suggestion).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('region', { name: 'Suggestions' })).toContainText(/Suggestions · \d/);
    await suggestion.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(suggestion).toHaveCount(0);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
