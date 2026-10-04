import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { filesView, inspectContext, inspectorTab, inspectorToggle, newSession, openAnotherProject, projectContextMenu, sessionStatus, startSession, switchProject } from './support/ui';

// Real Electron, runtime and node-pty with fixture CLIs. Native menus are
// driven through the headless menu hook (see desktop-context-menus.spec.ts).
test.skip(process.platform === 'win32', 'POSIX fixture CLIs');

async function menu(app: ElectronApplication, choice: string | null) {
  await app.evaluate((_electron, next) => { (globalThis as any).__journalMenuHook = (items: any[]) => { (globalThis as any).__lastMenu = items; return next; }; }, choice);
}
const lastMenu = (app: ElectronApplication) => app.evaluate(() => ((globalThis as any).__lastMenu as any[]).filter(i => i.id).map(i => `${i.id}${i.enabled === false ? ':disabled' : ''}`));
const row = (page: Page, name: string | RegExp) => page.getByRole('treeitem', { name });

function setup() {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'explorer-'));
  const project = resolve(root, 'explorer project'); const bin = resolve(root, 'bin'); const other = resolve(root, 'other project'); const extra = resolve(root, 'extra');
  for (const dir of [project, bin, other, extra]) mkdirSync(dir);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git(project, 'init', '-q', '-b', 'main');
  mkdirSync(resolve(project, 'src')); writeFileSync(resolve(project, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  writeFileSync(resolve(project, 'README.md'), '# Explorer fixture\n'); writeFileSync(resolve(project, 'gone.txt'), 'bye\n');
  writeFileSync(resolve(project, '.gitignore'), 'node_modules/\n');
  mkdirSync(resolve(project, 'big'));
  for (let i = 0; i < 3000; i++) writeFileSync(resolve(project, 'big', `file-${String(i).padStart(4, '0')}.txt`), `${i}\n`);
  git(project, 'add', '.'); git(project, 'commit', '-qm', 'init');
  writeFileSync(resolve(project, '.env'), 'API_TOKEN=do-not-read\n'); writeFileSync(resolve(project, 'image.bin'), Buffer.from([0, 1, 2, 3]));
  mkdirSync(resolve(project, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(resolve(project, 'node_modules', 'pkg', 'index.js'), '1\n');
  symlinkSync(root, resolve(project, 'escape'));
  writeFileSync(resolve(extra, 'notes.md'), 'extra notes\n');
  git(other, 'init', '-q', '-b', 'main'); writeFileSync(resolve(other, 'OTHER_SECRET_FILE.md'), 'other\n'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'other');
  const ledger = resolve(root, 'launches.jsonl');
  const fixture = `#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({argv:process.argv.slice(2)})+'\\n');
console.log('PTY_READY');process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('IN:'+JSON.stringify(d)+'\\n'));`;
  for (const p of ['claude', 'codex']) { writeFileSync(resolve(bin, p), fixture); chmodSync(resolve(bin, p), 0o755); }
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' };
  delete env.ELECTRON_RUN_AS_NODE;
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  return { root, project, other, extra, env, launches };
}

test('the explorer browses, decorates, previews and references files without editing anything', async () => {
  test.setTimeout(120000); // one long end-to-end scenario; slower on Linux's virtual display
  const f = setup();
  const app = await electron.launch({ args: ['.'], env: f.env });
  try {
    let next = f.project;
    await app.evaluate(({ dialog, shell }) => { (shell as any).showItemInFolder = (p: string) => { (globalThis as any).__revealed = p; }; (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [(globalThis as any).__nextFolder] }); });
    const choose = (path: string) => app.evaluate((_e, p) => { (globalThis as any).__nextFolder = p; }, path);
    const page = await app.firstWindow();
    await choose(next); await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    await inspectorTab(page, 'Files'); await filesView(page, 'all');

    // Tree: the primary root is open; .git is never listed; links, sensitive files and ignored folders are marked.
    await expect(row(page, /^explorer project \(checkout\)/)).toBeVisible();
    await expect(row(page, /^README\.md/)).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /^\.git$/ })).toHaveCount(0);
    await expect(row(page, /^escape, link \(not followed\)/)).toBeVisible();
    await expect(row(page, /^\.env, may contain credentials, untracked/)).toBeVisible();
    await expect(row(page, /^node_modules, ignored by Git/)).toBeVisible();

    // Large folder: virtualized, so only a window of rows is in the DOM.
    await row(page, /^big/).click();
    await expect(row(page, /^file-0000\.txt/)).toBeVisible();
    expect(await page.getByRole('treeitem').count()).toBeLessThan(120);
    await row(page, /^big/).click();

    // Keyboard: arrows, type-ahead and Enter to preview.
    await row(page, /^README\.md/).click(); await page.getByRole('button', { name: 'Back to files' }).click();
    await row(page, /^README\.md/).focus();
    await page.keyboard.press('Home');
    await expect(row(page, /^explorer project \(checkout\)/)).toBeFocused();
    // Each step waits for its effect: the tree moves DOM focus asynchronously.
    await page.keyboard.press('ArrowDown'); await expect(row(page, /^big/)).toBeFocused();
    await page.keyboard.press('s'); await expect(page.locator('.tree-search')).toBeFocused();
    await page.keyboard.type('rc'); await expect(page.locator('.tree-search')).toHaveValue('src');
    await page.keyboard.press('Enter');
    await expect(row(page, /^src/)).toBeFocused();
    await page.keyboard.press('ArrowRight'); await expect(row(page, /^a\.ts/)).toBeVisible();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await expect(page.locator('.file-preview-editor')).toContainText('export const b = 2;');
    await expect(page.locator('.preview-path')).toHaveText('src/a.ts');
    // Selecting lines through the gutter offers a line reference.
    await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^2$/ }).click();
    await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^3$/ }).click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Add to next task' }).click();
    await expect(page.getByRole('list', { name: 'Files referenced for the next task' })).toContainText('src/a.ts:2-3');
    await page.keyboard.press('Escape');
    await expect(row(page, /^a\.ts/)).toBeVisible();

    // Previews refuse what they must not read.
    await menu(app, null); await row(page, /^\.env/).click({ button: 'right' });
    expect(await lastMenu(app)).toContain('preview:disabled');
    await row(page, /^image\.bin/).click();
    await expect(page.locator('.preview-message')).toContainText('Binary file');
    await page.getByRole('button', { name: 'Back to files' }).click();

    // Git state follows external changes through the watcher.
    writeFileSync(resolve(f.project, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 22;\nexport const c = 3;\n');
    writeFileSync(resolve(f.project, 'fresh.ts'), 'new\n'); unlinkSync(resolve(f.project, 'gone.txt'));
    // Linux does not watch files (no native recursive watching): status refreshes on request.
    if (process.platform === 'linux') await page.getByRole('button', { name: 'Refresh files' }).click();
    await expect(row(page, /^a\.ts, modified/)).toBeVisible();
    await expect(row(page, /^fresh\.ts, untracked/)).toBeVisible();
    await expect(row(page, /^src, contains changes/)).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /^gone\.txt/ })).toHaveCount(0);
    await page.getByRole('button', { name: /^Uncommitted/ }).click();
    const changed = page.getByRole('list', { name: 'Changed files' });
    await expect(changed).toContainText('gone.txt'); await expect(changed).toContainText('fresh.ts');
    await changed.getByRole('button', { name: /gone\.txt/ }).click();
    await expect(page.locator('.file-preview-editor')).toContainText('-bye');
    await page.getByRole('button', { name: 'Back to files' }).click();
    await page.getByRole('button', { name: 'All', exact: true }).click();

    // Context menu: copy relative path, reveal (stubbed), never anything destructive.
    await menu(app, 'copyRel'); await row(page, /^a\.ts/).click({ button: 'right' });
    expect(await lastMenu(app)).toEqual(['preview', 'diff', 'refSession:disabled', 'refNext', 'copyRel', 'copyAbs', 'reveal', 'editor']);
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('src/a.ts');
    await menu(app, 'reveal'); await row(page, /^a\.ts/).click({ button: 'right' });
    await expect.poll(() => app.evaluate(() => (globalThis as any).__revealed)).toBe(resolve(f.project, 'src', 'a.ts'));

    // Next-task references reach the receipt and the launch, as paths and hashes only.
    await inspectContext(page);
    await page.getByRole('button', { name: /Show exact/ }).click();
    await expect(page.getByTestId('context-packet').first()).toContainText('Referenced by the user');
    await expect(page.getByTestId('context-packet').first()).toContainText('src/a.ts lines 2-3');
    await expect(page.getByTestId('context-packet').first()).not.toContainText('export const');
    await startSession(page, 'claude', { task: 'Check the constants' });
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY');
    expect(f.launches()[0].argv.at(-1)).toContain('src/a.ts lines 2-3');
    await expect(page.getByRole('list', { name: 'Files referenced for the next task' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: /Referenced for this task/ })).toContainText('src/a.ts:2-3');

    // A running session: the fixture reports no readiness, so the reference is copied, never typed.
    await inspectorTab(page, 'Files'); await filesView(page, 'all');
    await menu(app, 'refSession'); await row(page, /^README\.md/).click({ button: 'right' });
    await expect(page.locator('.explorer-note')).toContainText('Copied @README.md');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('@README.md');
    await expect(page.locator('.terminal-surface')).not.toContainText('IN:');
    await inspectorTab(page, 'Session');
    await expect(page.getByRole('region', { name: 'Referenced during this session' })).toContainText('README.md');
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(sessionStatus(page)).toContainText('Stopped');

    // Additional folders appear as their own roots.
    await inspectorTab(page, 'Files'); await filesView(page, 'all');
    await choose(f.extra); await menu(app, 'addFolder'); await projectContextMenu(page).click({ button: 'right' });
    await expect(row(page, /^extra/)).toBeVisible();
    await row(page, /^extra/).click(); await expect(row(page, /^notes\.md/)).toBeVisible();

    // Collapse the side panel and open Files from the keyboard: ⌘I and ⌥⌘2 on macOS,
    // Ctrl+Shift+B and Alt+Shift+2 elsewhere.
    const mac = process.platform === 'darwin';
    await pressKey(app, mac ? 'I' : 'B', mac ? ['meta'] : ['control', 'shift']);
    await expect(inspectorToggle(page, 'show')).toBeVisible();
    await pressKey(app, '2', mac ? ['meta', 'alt'] : ['alt', 'shift']);
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');

    // Another project shows only its own files: no stale tree, preview or reference carries over.
    await menu(app, 'refNext'); await row(page, /^README\.md/).click({ button: 'right' });
    await expect(page.locator('.explorer-note')).toContainText('Added README.md to the next task.');
    // The next task's references show in the New session view.
    await newSession(page);
    await expect(page.getByRole('list', { name: 'Files referenced for the next task' })).toContainText('README.md');
    await row(page, /^README\.md/).click(); await expect(page.locator('.preview-path')).toHaveText('README.md');
    await choose(f.other); await openAnotherProject(app, page);
    await expect(page.getByLabel('Task', { exact: true })).toBeVisible();
    await expect(page.locator('.file-preview')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Files referenced for the next task' })).toHaveCount(0);
    await expect(row(page, /^OTHER_SECRET_FILE\.md/)).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /^README\.md/ })).toHaveCount(0);
    await switchProject(app, page, 'explorer project');
    await expect(row(page, /^README\.md/)).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /^OTHER_SECRET_FILE/ })).toHaveCount(0);

    // Nothing was written to the project by browsing.
    expect(execFileSync('git', ['-C', f.project, 'status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort())
      .toEqual([' D gone.txt', ' M src/a.ts', '?? .env', '?? escape', '?? fresh.ts', '?? image.bin']);
  } finally { await app.close(); rmSync(f.root, { recursive: true, force: true }); }
});
