import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('a Git-drafted branch update is saved only after review and approved before delivery', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'status-')); const project = resolve(root, 'status project'); mkdirSync(project);
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  const commit = (path: string, message: string) => {
    writeFileSync(resolve(project, path), `${message}\n`); git('add', path);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', message);
  };
  git('init', '-b', 'main'); commit('README.md', 'Fixture ledger for refunds');
  git('switch', '-c', 'feature/refunds'); commit('model.txt', 'REFUND_MODEL_DONE');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env });
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await page.getByRole('button', { name: 'Propose branch update' }).click();
    await expect(page.getByRole('heading', { name: 'Review branch update' })).toBeVisible();
    // React renders a textarea's initial value as label text, so match by role name.
    const statement = page.getByRole('textbox', { name: 'Statement', exact: true });
    await expect(statement).toHaveValue(/REFUND_MODEL_DONE/);
    await expect(page.getByLabel('Source type')).toHaveValue('git');
    await page.getByRole('button', { name: 'Save for review' }).click();
    await expect(page.getByRole('alert')).toContainText('placeholders');
    await page.getByRole('button', { name: 'Close knowledge form' }).click();
    // BUG-1: a preview is not stored as a receipt.
    const receiptCount = () => page.evaluate(async () => {
      const boot = await (window as any).journal.request('bootstrap');
      return (await (window as any).journal.request('project', { projectId: boot.projects[0].id })).receipts.length;
    });
    const receiptsBefore = await receiptCount();
    await page.getByRole('button', { name: 'Preview context' }).click();
    await expect(page.getByTestId('context-packet')).not.toContainText('REFUND_MODEL_DONE');
    expect(await receiptCount()).toBe(receiptsBefore);

    await page.getByRole('tab', { name: /^Knowledge/ }).click();
    await page.getByRole('button', { name: 'Propose branch update' }).click();
    const draft = await statement.inputValue();
    await statement.fill(draft.replace(/Current work: .*/, 'Current work: REFUND_ROUTE_IN_PROGRESS').replace(/Next: .*/, 'Next: validate partial refunds'));
    await page.getByRole('button', { name: 'Save for review' }).click();
    await page.getByRole('button', { name: 'Preview context' }).click();
    await expect(page.getByTestId('context-packet')).not.toContainText('REFUND_ROUTE_IN_PROGRESS');
    await page.getByRole('tab', { name: /^Knowledge/ }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Preview context' }).click();
    await expect(page.getByTestId('context-packet')).toContainText('REFUND_ROUTE_IN_PROGRESS');
    await expect(page.getByTestId('context-packet')).toContainText('Git history');

    commit('route.txt', 'REFUND_ROUTE_DONE');
    await page.getByRole('button', { name: /^status project/ }).click();
    await page.getByRole('tab', { name: /^Knowledge/ }).click();
    await expect(page.getByText(/Updated 0 day\(s\) ago · 1 commit since/)).toBeVisible();
    await page.getByRole('button', { name: 'Propose update', exact: true }).click();
    await expect(statement).toHaveValue(/REFUND_ROUTE_DONE/);
    await expect(statement).toHaveValue(/Current work: REFUND_ROUTE_IN_PROGRESS/);
    await expect(page.getByText(/Saving creates revision 2/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
