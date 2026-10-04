import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { startSession } from './support/ui';

// Boards B10 and B11: smaller windows fold the side panes into rails and
// overlays without refitting the terminal. Real Electron, runtime and node-pty with a fixture CLI.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`)); const bin = resolve(root, 'bin'); mkdirSync(bin);
  const project = resolve(root, 'small project'); mkdirSync(project);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), 'Small window fixture\n'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'init');
  // `size` prints the PTY size; every resize prints RESIZED; Esc prints ESC.
  const fixture = `#!${process.execPath}
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
const task=(process.argv.at(-1)||'').split('\\n').at(-1);console.log('TASK '+task);
process.stdout.on('resize',()=>console.log('RESIZED'));
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let input='';
process.stdin.on('data',data=>{for(const char of data){
if(char==='\\x1b'){console.log('ESC');continue}
if(char!=='\\r'&&char!=='\\n'){input+=char;continue}
const command=input;input='';
if(command==='size')console.log('SIZE '+process.stdout.columns+'x'+process.stdout.rows);else console.log('ECHO '+command);
}});`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' };
  delete env.ELECTRON_RUN_AS_NODE;
  return { project, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function open(env: Record<string, string>, project: string, width: number, height: number): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); (globalThis as any).__journalFocused = () => true; }, project);
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; }
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(resolveWait => setTimeout(resolveWait, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
async function start(page: Page, task: string) {
  await startSession(page, 'claude', { task: task });
  await expect(page.locator('.terminal-surface')).toContainText(`TASK ${task}`);
}
const terminal = (page: Page) => page.locator('.xterm-helper-textarea');
const typeLine = async (page: Page, text: string) => { await terminal(page).pressSequentially(text); await terminal(page).press('Enter'); };
// The newest SIZE line the fixture printed.
async function size(page: Page) {
  const before = await page.locator('.xterm-rows').innerText();
  await typeLine(page, 'size');
  await expect.poll(async () => (await page.locator('.xterm-rows').innerText()).match(/SIZE \d+x\d+/g)?.length ?? 0).toBeGreaterThan(before.match(/SIZE \d+x\d+/g)?.length ?? 0);
  const [cols, rows] = (await page.locator('.xterm-rows').innerText()).match(/SIZE (\d+)x(\d+)/g)!.at(-1)!.slice(5).split('x').map(Number);
  return { cols, rows };
}
const resizes = async (page: Page) => ((await page.locator('.xterm-rows').innerText()).match(/RESIZED/g) ?? []).length;
const mac = process.platform === 'darwin';
const inspectorKeys = mac ? ['I', ['meta']] as const : ['B', ['control', 'shift']] as const;

test('1280×800: the terminal has at least 100 columns, and the overlay never refits it', async () => {
  const f = setup('small-1280'); const { app, page } = await open(f.env, f.project, 1280, 800);
  try {
    await expect(page.getByRole('separator', { name: 'Resize side panel' })).toHaveCount(0);
    await expect(page.getByRole('separator', { name: 'Resize project sidebar' })).toHaveCount(1);
    await expect(page.locator('.inspector-rail .rail-tile')).toHaveCount(4); // three tabs and Show inspector
    await start(page, 'WIDE_ENOUGH');
    const first = await size(page);
    expect(first.cols).toBeGreaterThanOrEqual(100);
    const surface = await page.locator('.terminal-surface').evaluate(element => element.getBoundingClientRect().width);
    const resized = await resizes(page);
    // Open with the shortcut while the terminal has focus; Esc from inside the overlay closes it.
    await terminal(page).focus();
    await expect(async () => {
      await pressKey(app, inspectorKeys[0], [...inspectorKeys[1]]);
      await expect(page.locator('.inspector-overlay')).toBeVisible({ timeout: 1000 });
    }).toPass();
    await expect(page.locator('.inspector-overlay [role=tab][aria-selected=true]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector-overlay')).toHaveCount(0);
    await expect(terminal(page)).toBeFocused();
    expect(await page.locator('.terminal-surface').evaluate(element => element.getBoundingClientRect().width)).toBe(surface);
    expect(await size(page)).toEqual(first);
    expect(await resizes(page)).toBe(resized);
  } finally { await closeApp(app); f.cleanup(); }
});

test('Esc in the terminal reaches the CLI while the overlay is open', async () => {
  const f = setup('small-esc'); const { app, page } = await open(f.env, f.project, 1280, 800);
  try {
    await start(page, 'ESC_KEY');
    await page.locator('.inspector-rail').getByRole('button', { name: /^Memory/ }).click();
    await expect(page.locator('.inspector-overlay')).toBeVisible();
    // A click into the terminal closes it (light dismiss).
    await page.locator('.terminal-surface').click();
    await expect(page.locator('.inspector-overlay')).toHaveCount(0);
    await expect(async () => {
      await pressKey(app, inspectorKeys[0], [...inspectorKeys[1]]);
      await expect(page.locator('.inspector-overlay')).toBeVisible({ timeout: 1000 });
    }).toPass();
    await pressKey(app, mac ? 'E' : 'E', mac ? ['meta'] : ['control', 'shift']);
    await expect(terminal(page)).toBeFocused();
    await terminal(page).press('Escape');
    await expect(page.locator('.terminal-surface')).toContainText('ESC');
    await expect(page.locator('.inspector-overlay')).toBeVisible();
  } finally { await closeApp(app); f.cleanup(); }
});

test('rail tab buttons open the overlay on that tab, with the Memory badge', async () => {
  const f = setup('small-rail'); const { app, page } = await open(f.env, f.project, 1280, 800);
  try {
    // A rule in the task becomes a suggestion after the session ends.
    await start(page, 'rule: Release tags must be signed by maintainers');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    const rail = page.locator('.inspector-rail');
    await expect(rail.getByRole('button', { name: /^Memory, 1 suggestion/ })).toBeVisible({ timeout: 15000 });
    await expect(rail.locator('.count-badge')).toHaveText('1');
    for (const name of ['Files', 'Session', 'Memory']) {
      await rail.getByRole('button', { name: new RegExp(`^${name}`) }).click();
      await expect(page.locator('.inspector-overlay').getByRole('tab', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-selected', 'true');
      await expect(rail.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-pressed', 'true');
    }
  } finally { await closeApp(app); f.cleanup(); }
});

test('900×640: at least 10 terminal rows; the sidebar overlay toggles with its shortcut', async () => {
  const f = setup('small-900'); const { app, page } = await open(f.env, f.project, 900, 640);
  try {
    await expect(page.getByRole('separator')).toHaveCount(0);
    await expect(page.locator('.sidebar-rail')).toBeVisible(); await expect(page.locator('.inspector-rail')).toBeVisible();
    await start(page, 'ROWS');
    expect(await page.locator('.xterm-rows > div').count()).toBeGreaterThanOrEqual(10);
    expect((await size(page)).rows).toBeGreaterThanOrEqual(10);
    await terminal(page).focus();
    await expect(async () => {
      await pressKey(app, '\\', mac ? ['meta'] : ['control', 'shift']);
      await expect(page.locator('.sidebar-overlay')).toBeVisible({ timeout: 1000 });
    }).toPass();
    const row = page.locator('.sidebar-overlay').getByRole('button', { name: /: ROWS\./ });
    await expect(row).toBeFocused();
    await row.click();
    await expect(page.locator('.sidebar-overlay')).toHaveCount(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('1280×800: Esc closes the file preview first, then the overlay; the docked sidebar keeps its own Esc', async () => {
  const f = setup('small-esc-layers'); const { app, page } = await open(f.env, f.project, 1280, 800);
  try {
    await start(page, 'ESC_LAYERS');
    const overlay = page.locator('.inspector-overlay'); const rail = page.locator('.inspector-rail');
    await expect(rail.getByRole('button', { name: 'Show inspector', exact: true })).toBeVisible();
    await rail.getByRole('button', { name: /^Files/ }).click();
    await expect(overlay).toBeVisible();
    // While the overlay is open, the rail's toggle names what it does.
    await expect(rail.getByRole('button', { name: 'Hide inspector', exact: true })).toBeVisible();
    await overlay.getByRole('treeitem', { name: /^README\.md/ }).click();
    await expect(overlay.getByRole('region', { name: 'Preview of README.md' })).toBeVisible();
    await overlay.getByRole('button', { name: 'Back to files' }).focus();
    await page.keyboard.press('Escape');
    await expect(overlay.getByRole('region', { name: 'Preview of README.md' })).toHaveCount(0);
    await expect(overlay).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.inspector-overlay'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await expect(rail.getByRole('button', { name: 'Show inspector', exact: true })).toBeVisible();
    // Medium mode docks the sidebar: Esc there neither closes the overlay nor moves focus.
    await rail.getByRole('button', { name: /^Memory/ }).click();
    await expect(overlay).toBeVisible();
    const row = page.locator('.sidebar').getByRole('button', { name: /: ESC_LAYERS\./ });
    await row.focus();
    await page.keyboard.press('Escape');
    await expect(overlay).toBeVisible();
    await expect(row).toBeFocused();
    // Choosing a session in the sidebar closes the overlay.
    await row.click();
    await expect(overlay).toHaveCount(0);
  } finally { await closeApp(app); f.cleanup(); }
});
