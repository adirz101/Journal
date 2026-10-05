import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { filesView, inspectorTab, projectContextMenu, sessionStatus, startSession } from './support/ui';
import { fixtureEnv } from './support/env';

// The branch picker: one repository at a time (the checkout, a worktree or an added Git
// folder), searched and switched from the keyboard; refused while a session runs there.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs');

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
const commit = (repo: string, file: string, body: string, message: string) => { writeFileSync(resolve(repo, file), body); git(repo, 'add', '.'); git(repo, 'commit', '-qm', message); };

function setup() {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'branches-'));
  const seed = resolve(root, 'seed'); const origin = resolve(root, 'origin.git'); const project = resolve(root, 'branch project'); const api = resolve(root, 'api'); const bin = resolve(root, 'bin');
  for (const dir of [seed, api, bin]) mkdirSync(dir);
  git(seed, 'init', '-q', '-b', 'main'); commit(seed, 'README.md', '# Branch fixture\n', 'init');
  git(seed, 'switch', '-qc', 'remote-only'); commit(seed, 'remote.txt', 'remote\n', 'remote work'); git(seed, 'switch', '-q', 'main');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', origin, project], { stdio: 'pipe' });
  git(project, 'switch', '-qc', 'feature/login'); commit(project, 'login.txt', 'login\n', 'Add login'); git(project, 'switch', '-q', 'main');
  for (const name of ['Fix-Typo', 'docs/readme', 'release/1.0']) git(project, 'branch', name);
  git(api, 'init', '-q', '-b', 'develop'); commit(api, 'api.txt', 'api\n', 'api init'); git(api, 'branch', 'release');
  const fixture = `#!${process.execPath}
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
console.log('PTY_READY');process.stdin.setRawMode(true);process.stdin.resume();`;
  for (const p of ['claude', 'codex']) { writeFileSync(resolve(bin, p), fixture); chmodSync(resolve(bin, p), 0o755); }
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  return { root, project, api, env };
}

async function open(app: ElectronApplication, f: ReturnType<typeof setup>) {
  await app.evaluate(({ dialog }) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [(globalThis as any).__nextFolder] }); });
  const choose = (path: string) => app.evaluate((_e, p) => { (globalThis as any).__nextFolder = p; }, path);
  const page = await app.firstWindow();
  await choose(f.project); await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
  await inspectorTab(page, 'Files'); await filesView(page, 'all');
  await expect(page.getByRole('treeitem', { name: /^branch project \(checkout\)/ })).toBeVisible();
  // The api repository joins the project as an additional folder (Add folder… in the project menu).
  await choose(f.api);
  await app.evaluate(() => { (globalThis as any).__journalMenuHook = () => 'addFolder'; });
  await projectContextMenu(page).click({ button: 'right' });
  await expect(page.getByRole('treeitem', { name: /^api/ })).toBeVisible();
  await app.evaluate(() => { (globalThis as any).__journalMenuHook = undefined; });
  return page;
}
const picker = (page: Page, repo: string) => page.getByRole('dialog', { name: `Switch branch of ${repo}`, exact: true });
const search = (page: Page) => page.locator('dialog[open] input[role=combobox]');
const trigger = (page: Page) => page.getByRole('button', { name: /^Branch of branch project \(checkout\):/ });

test('search, switch and create a tracking branch across the project\'s repositories, from the keyboard', async () => {
  test.setTimeout(90000);
  const f = setup();
  const app = await electron.launch({ args: ['.'], env: f.env });
  try {
    const page = await open(app, f);
    await expect(trigger(page)).toContainText('main');

    // Opened by keyboard on the shown checkout; the input takes focus and lists local branches first.
    await trigger(page).focus(); await page.keyboard.press('Enter');
    const dialog = picker(page, 'branch project (checkout)');
    await expect(dialog).toBeVisible(); await expect(search(page)).toBeFocused();
    const list = dialog.getByRole('listbox', { name: 'Branches' });
    await expect(list.getByRole('group').first()).toContainText('Local branches');
    await expect(list.getByRole('option', { name: /main/ }).first()).toHaveAttribute('aria-current', 'true');
    await expect(list.getByRole('group', { name: 'Remote branches' }).getByRole('option')).toHaveText([/origin\/remote-only/]);

    // Type to filter (case-insensitive substring); Enter switches to the active branch.
    await page.keyboard.type('LOGIN');
    await expect(list.getByRole('option')).toHaveCount(1);
    await expect(search(page)).toHaveAttribute('aria-activedescendant', /branch-option-0/);
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(trigger(page)).toContainText('feature/login');
    await expect(trigger(page)).toBeFocused();
    expect(git(f.project, 'branch', '--show-current')).toBe('feature/login');

    // Escape closes without switching and gives focus back.
    await page.keyboard.press('Enter'); await expect(dialog).toBeVisible();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(trigger(page)).toBeFocused();
    expect(git(f.project, 'branch', '--show-current')).toBe('feature/login');

    // The added folder is its own repository: chosen first, then switched on its own.
    await page.keyboard.press('Enter'); await expect(dialog).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    const repo = page.locator('dialog[open]').getByRole('combobox', { name: 'Repository' });
    await expect(repo).toBeFocused();
    await repo.selectOption({ label: 'api · develop' });
    const apiDialog = picker(page, 'api');
    await expect(apiDialog).toBeVisible();
    await search(page).focus(); await page.keyboard.type('rel');
    await expect(apiDialog.getByRole('listbox').getByRole('option')).toHaveText([/release/]);
    await page.keyboard.press('Enter');
    await expect(apiDialog).toHaveCount(0);
    expect(git(f.api, 'branch', '--show-current')).toBe('release');
    expect(git(f.project, 'branch', '--show-current')).toBe('feature/login');
    await expect(page.getByRole('treeitem', { name: /^api/ })).toContainText('⑂ release');

    // A remote-only branch asks before it creates the local tracking branch.
    await trigger(page).focus(); await page.keyboard.press('Enter'); await expect(dialog).toBeVisible();
    await page.keyboard.type('remote-only'); await page.keyboard.press('Enter');
    await expect(dialog.getByText('Create a local branch?')).toBeVisible();
    await expect(dialog.getByText('Journal will create the local branch remote-only tracking origin/remote-only, and switch branch project (checkout) to it.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create and switch' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(trigger(page)).toContainText('remote-only');
    expect(git(f.project, 'rev-parse', '--abbrev-ref', 'remote-only@{upstream}')).toBe('origin/remote-only');

    // Git's refusal is shown in plain words and nothing changes.
    writeFileSync(resolve(f.project, 'README.md'), 'local edit\n');
    git(f.project, 'switch', '-q', '-c', 'conflicting', 'main'); writeFileSync(resolve(f.project, 'README.md'), 'other\n'); git(f.project, 'commit', '-qam', 'conflict'); git(f.project, 'switch', '-q', 'remote-only');
    writeFileSync(resolve(f.project, 'README.md'), 'local edit\n');
    await trigger(page).focus(); await page.keyboard.press('Enter'); await expect(dialog).toBeVisible();
    await page.keyboard.type('conflicting'); await page.keyboard.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('your uncommitted changes to README.md would be overwritten');
    await expect(search(page)).toBeFocused();
    expect(git(f.project, 'branch', '--show-current')).toBe('remote-only');
    expect(git(f.project, 'status', '--porcelain')).toBe('M README.md');
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('switching is refused while a session runs in that repository', async () => {
  test.setTimeout(90000);
  const f = setup();
  const app = await electron.launch({ args: ['.'], env: f.env });
  try {
    const page = await open(app, f);
    await startSession(page, 'claude', { task: 'Fix the login' });
    await expect(sessionStatus(page)).toContainText('⑂ main');
    await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();

    // The session header's branch opens the picker on the session's repository.
    await sessionStatus(page).getByRole('button', { name: /⑂ main, switch branch/ }).click();
    const dialog = picker(page, 'branch project (checkout)');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('status').filter({ hasText: 'is running in branch project (checkout)' })).toContainText('Stop it before switching branches');
    const login = dialog.getByRole('option', { name: /feature\/login/ });
    await expect(login).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.type('login'); await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    // A branch in another worktree says why it cannot be chosen.
    git(f.project, 'worktree', 'add', '-q', resolve(f.root, 'side-tree'), 'Fix-Typo');
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await sessionStatus(page).getByRole('button', { name: /⑂ main, switch branch/ }).click();
    await page.keyboard.type('fix-typo'); await page.keyboard.press('Enter');
    await expect(dialog.locator('.palette-note')).toHaveText('Checked out in another worktree');
    // The store refuses too, whatever the window sends.
    const refused = await page.evaluate(async () => {
      const journal = (window as any).journal; const project = (await journal.request('projects')).find((p: any) => p.name === 'branch project');
      return journal.settle('switchBranch', { projectId: project.id, rootKey: 'checkout', kind: 'local', name: 'feature/login' });
    });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/^Not switched: “Fix the login” is running in branch project \(checkout\)/) });
    expect(git(f.project, 'branch', '--show-current')).toBe('main');
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);

    // The added folder is another repository: its root's Switch Branch… opens it, and it switches.
    await inspectorTab(page, 'Files'); await filesView(page, 'all');
    await app.evaluate(() => { (globalThis as any).__journalMenuHook = () => 'branch'; });
    await page.getByRole('treeitem', { name: /^api/ }).click({ button: 'right' });
    await app.evaluate(() => { (globalThis as any).__journalMenuHook = undefined; });
    const apiDialog = picker(page, 'api');
    await expect(apiDialog).toBeVisible(); await expect(search(page)).toBeFocused();
    await expect(apiDialog.locator('.branch-blocked')).toHaveCount(0);
    await page.keyboard.type('release'); await page.keyboard.press('Enter');
    await expect(apiDialog).toHaveCount(0);
    expect(git(f.api, 'branch', '--show-current')).toBe('release');
    expect(git(f.project, 'branch', '--show-current')).toBe('main');
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});
