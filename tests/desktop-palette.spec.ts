import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { resolve, delimiter, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { inspectorTab, newSession, openPalette, paletteDialog, paletteInput, referenceChips, startSession, taskBox } from './support/ui';

// Phase 8 Group B: the command palette and open-file (board 7). Real Electron, runtime
// and node-pty with fixture CLIs; hidden windows, no notifications, no provider logins.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`));
  const project = resolve(root, 'palette project'); const bin = resolve(root, 'bin'); const home = resolve(root, 'home'); mkdirSync(project); mkdirSync(bin); mkdirSync(home);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(resolve(project, 'src', 'core'), { recursive: true });
  writeFileSync(resolve(project, 'README.md'), '# Palette fixture\n'); writeFileSync(resolve(project, 'src', 'core', 'terminal.mjs'), 'export {};\n');
  git('add', '.'); git('commit', '-qm', 'init');
  writeFileSync(resolve(project, '.env'), 'API_TOKEN=do-not-read\n'); writeFileSync(resolve(project, 'id_rsa'), 'secret\n');
  const ledger = resolve(root, 'launches.jsonl');
  // Prints its task and echoes each typed line, so a test sees keys reach the PTY.
  const fixture = `#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})+'\\n');
console.log('TASK '+(process.argv.at(-1)||'').split('\\n').at(-1));process.stdin.setRawMode(true);let line='';
process.stdin.on('data',d=>{for(const c of d.toString()){if(c==='\\r'){process.stdout.write('\\r\\nECHO '+line+'\\r\\n');line=''}else line+=c}});`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PATH: [bin, '/usr/bin', '/bin', dirname(process.execPath)].join(delimiter), HOME: home, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' };
  // PATH holds only the fixtures, system tools and node, and HOME is empty: a real provider CLI
  // (for example Cursor's ~/.local/bin/agent) is never found.
  delete env.ELECTRON_RUN_AS_NODE;
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const cleanup = () => {
    for (const pid of launches().map(entry => entry.pid)) { try { if (execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(root)) process.kill(pid, 'SIGKILL'); } catch {} }
    try { const info = JSON.parse(readFileSync(resolve(root, 'data/runtime.json'), 'utf8')); if (execFileSync('ps', ['-p', String(info.pid), '-o', 'command='], { encoding: 'utf8' }).includes('runtime.mjs')) process.kill(info.pid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { root, project, env, launches, cleanup };
}

async function open(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
  await expect(taskBox(page)).toBeVisible();
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; }
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(resolveWait => setTimeout(resolveWait, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
const mac = process.platform === 'darwin';
const combobox = paletteInput;
const results = (page: Page) => page.locator('#palette-list');
const activeOption = (page: Page) => page.evaluate(() => { const id = document.querySelector('dialog[open] input[role=combobox]')?.getAttribute('aria-activedescendant'); return id ? document.getElementById(id)?.textContent ?? null : null; });
const terminalHasFocus = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('.xterm'));
const remember = (page: Page, statement: string) => page.evaluate(async text => {
  const journal = (window as any).journal; const projectId = (await journal.request('projects'))[0].id;
  const memory = await journal.request('proposeMemory', { projectId, input: { statement: text, category: 'constraint', scope: 'checkout', area: '', source: { kind: 'user', note: 'Fixture' } } });
  await journal.request('setMemoryStatus', { id: memory.id, status: 'active' });
}, statement);

test('the palette key opens it while the terminal has focus; Escape and the key itself return focus to the terminal', async () => {
  const f = setup('palette-focus'); const { app, page } = await open(f.env, f.project);
  try {
    await startSession(page, 'claude', { task: 'FOCUS_ME' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK FOCUS_ME');
    await page.locator('.xterm-helper-textarea').focus();
    expect(await terminalHasFocus(page)).toBe(true);
    await openPalette(app, page);
    await expect(combobox(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(paletteDialog(page)).toHaveCount(0);
    await expect.poll(() => terminalHasFocus(page)).toBe(true);
    // The toggle key inside the open palette closes it (main does not route keys while a dialog is open).
    await openPalette(app, page);
    await pressKey(app, mac ? 'K' : 'P', mac ? ['meta'] : ['control', 'shift']);
    await expect(paletteDialog(page)).toHaveCount(0);
    await expect.poll(() => terminalHasFocus(page)).toBe(true);
    // Keys still reach the PTY afterwards.
    await page.locator('.xterm-helper-textarea').pressSequentially('after-palette'); await page.locator('.xterm-helper-textarea').press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO after-palette');
  } finally { await closeApp(app); f.cleanup(); }
});

test('keyboard only: type, arrow down and Enter open a session; aria-activedescendant follows the active option', async () => {
  const f = setup('palette-keys'); const { app, page } = await open(f.env, f.project);
  try {
    await startSession(page, 'claude', { task: 'ALPHA_TASK' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK ALPHA_TASK');
    await startSession(page, 'codex', { task: 'BETA_TASK' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK BETA_TASK');
    await openPalette(app, page);
    await page.keyboard.type('_task');
    const list = page.getByRole('listbox');
    await expect(list.getByRole('group', { name: 'Sessions' }).getByRole('option')).toHaveCount(2);
    const first = await combobox(page).getAttribute('aria-activedescendant');
    expect(await activeOption(page)).toContain('ALPHA_TASK');
    await page.keyboard.press('ArrowDown');
    await expect(combobox(page)).not.toHaveAttribute('aria-activedescendant', first!);
    expect(await activeOption(page)).toContain('BETA_TASK');
    await expect(page.locator(`#${await combobox(page).getAttribute('aria-activedescendant')}`)).toHaveAttribute('aria-selected', 'true');
    // Up from the first option wraps to the last; Tab never leaves the input.
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Tab'); await expect(combobox(page)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    expect(await activeOption(page)).toContain('ALPHA_TASK');
    await page.keyboard.press('Enter');
    await expect(paletteDialog(page)).toHaveCount(0);
    await expect(page.locator('.terminal-surface')).toContainText('TASK ALPHA_TASK');
    await expect(page.locator('.session-header')).toContainText('ALPHA_TASK');
    expect(f.launches()).toHaveLength(2);
  } finally { await closeApp(app); f.cleanup(); }
});

test('> lists only actions; Enter on New session shows the composer', async () => {
  const f = setup('palette-actions'); const { app, page } = await open(f.env, f.project);
  try {
    await startSession(page, 'claude', { task: 'ACTIONS_TASK' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK ACTIONS_TASK');
    await openPalette(app, page);
    await page.keyboard.type('>');
    const groups = page.getByRole('listbox').getByRole('group');
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toHaveAccessibleName('Actions');
    await expect(results(page).getByRole('option', { name: /Settings/ })).toBeVisible();
    await page.keyboard.type('new session');
    expect(await activeOption(page)).toContain('New session⌘N');
    await page.keyboard.press('Enter');
    await expect(paletteDialog(page)).toHaveCount(0);
    await expect(taskBox(page)).toBeVisible();
    await expect(taskBox(page)).toBeFocused();
    expect(f.launches()).toHaveLength(1);
    // A blocked action stays listed with its reason and does nothing.
    await openPalette(app, page);
    await page.keyboard.type('>focus the terminal');
    const blocked = results(page).getByRole('option', { name: /Focus the terminal/ });
    await expect(blocked).toHaveAttribute('aria-disabled', 'true');
    await expect(blocked).toContainText('Open a session first');
    await page.keyboard.press('Enter');
    await expect(paletteDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
  } finally { await closeApp(app); f.cleanup(); }
});

test('memory search finds a remembered note and opens it in the Memory tab', async () => {
  const f = setup('palette-memory'); const { app, page } = await open(f.env, f.project);
  try {
    await remember(page, 'Zebracorn migrations always run inside a transaction');
    await openPalette(app, page);
    await page.keyboard.type('zebracorn');
    const memory = page.getByRole('listbox').getByRole('group', { name: 'Project memory' });
    await expect(memory.getByRole('option')).toHaveCount(1);
    await expect(memory.getByRole('option')).toContainText('Rule');
    expect(await activeOption(page)).toContain('Zebracorn migrations');
    await page.keyboard.press('Enter');
    await expect(paletteDialog(page)).toHaveCount(0);
    const card = page.getByRole('article', { name: /Zebracorn migrations/ });
    await expect(card).toBeFocused();
    await expect(page.getByRole('tab', { name: /^Memory/ })).toHaveAttribute('aria-selected', 'true');
  } finally { await closeApp(app); f.cleanup(); }
});

test('open-file finds README.md and previews it; .env and id_rsa never appear', async () => {
  const f = setup('palette-files'); const { app, page } = await open(f.env, f.project);
  try {
    await openPalette(app, page, 'files');
    await expect(combobox(page)).toHaveAttribute('placeholder', /^Open a file in /);
    await expect(page.getByText('Type part of a file name')).toBeVisible();
    for (const query of ['env', 'rsa', 'id_']) {
      await combobox(page).fill(query);
      await expect(page.getByText(`No file name matches “${query}”.`)).toBeVisible();
      await expect(results(page).getByRole('option')).toHaveCount(0);
    }
    await combobox(page).fill('term');
    await expect(results(page).getByRole('option', { name: /terminal\.mjs/ })).toHaveAttribute('title', 'src/core/terminal.mjs');
    await combobox(page).fill('readme');
    await expect(results(page).getByRole('option')).toHaveCount(1);
    await expect(results(page).getByRole('option').locator('mark')).toHaveText('README');
    await page.keyboard.press('Enter');
    await expect(paletteDialog(page)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Preview of README.md' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Preview of README.md' })).toContainText('Palette fixture');
    // Handled once: showing the Files tab again does not reopen it.
    await page.getByRole('button', { name: 'Back to files' }).click();
    await inspectorTab(page, 'Memory'); await inspectorTab(page, 'Files');
    await expect(page.getByRole('tree', { name: 'Files' })).toBeVisible();
    await expect(page.getByRole('region', { name: /Preview of/ })).toHaveCount(0);
    // ⌘P / Ctrl+Shift+O inside the command palette switches to files and keeps the text.
    await openPalette(app, page);
    await page.keyboard.type('readme');
    await pressKey(app, mac ? 'P' : 'O', mac ? ['meta'] : ['control', 'shift']);
    await expect(paletteDialog(page, 'Open a file')).toBeVisible();
    await expect(combobox(page)).toHaveValue('readme');
    await expect(results(page).getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Escape');
  } finally { await closeApp(app); f.cleanup(); }
});

test('no results: New session with this task fills the task box without starting', async () => {
  const f = setup('palette-none'); const { app, page } = await open(f.env, f.project);
  try {
    await startSession(page, 'claude', { task: 'EXISTING' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK EXISTING');
    await openPalette(app, page);
    await page.keyboard.type('flaky ci on windows');
    await expect(page.getByText('No sessions, commands or notes match “flaky ci on windows”.')).toBeVisible();
    await expect(page.getByText('Terminal output isn’t saved, so it isn’t searched.', { exact: false })).toBeVisible();
    expect(await activeOption(page)).toContain('New session with this task');
    await page.keyboard.press('Enter');
    await expect(taskBox(page)).toHaveValue('flaky ci on windows');
    // A draft is never discarded: the query goes on a new line.
    await openPalette(app, page);
    await page.keyboard.type('second idea xyzzy');
    await expect(results(page).getByRole('option', { name: /New session with this task/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(taskBox(page)).toHaveValue('flaky ci on windows\nsecond idea xyzzy');
    await page.waitForTimeout(500);
    expect(f.launches()).toHaveLength(1);
  } finally { await closeApp(app); f.cleanup(); }
});

test('Add as a note opens the note form with the statement', async () => {
  const f = setup('palette-note'); const { app, page } = await open(f.env, f.project);
  try {
    await openPalette(app, page);
    await page.keyboard.type('quokka builds need node 24');
    await expect(results(page).getByRole('option', { name: 'Add as a note' })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    expect(await activeOption(page)).toBe('Add as a note');
    await page.keyboard.press('Enter');
    const form = page.getByRole('dialog', { name: 'Add a note' });
    await expect(form).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Statement' })).toHaveValue('quokka builds need node 24');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally { await closeApp(app); f.cleanup(); }
});

test('Add reference… in the composer adds a file chip', async () => {
  const f = setup('palette-reference'); const { app, page } = await open(f.env, f.project);
  try {
    await newSession(page);
    await page.getByRole('button', { name: 'Add reference…', exact: true }).click();
    await expect(paletteDialog(page, 'Reference a file')).toBeVisible();
    await page.keyboard.type('term');
    await expect(results(page).getByRole('option', { name: /terminal\.mjs/ })).toBeVisible();
    // Enter right after typing waits for this query's results: the earlier match is never taken.
    await combobox(page).fill('readme'); await page.keyboard.press('Enter');
    await expect(paletteDialog(page, 'Reference a file')).toHaveCount(0);
    await expect(referenceChips(page)).toContainText('README.md');
    await expect(referenceChips(page)).not.toContainText('terminal.mjs');
    await expect(page.getByRole('region', { name: /Preview of/ })).toHaveCount(0);
    expect(f.launches()).toHaveLength(0);
    // The Files tab is untouched; the memory tab still works.
    await inspectorTab(page, 'Memory');
  } finally { await closeApp(app); f.cleanup(); }
});

test('opening and closing has no transition', async () => {
  const f = setup('palette-motion'); const { app, page } = await open(f.env, f.project);
  try {
    await openPalette(app, page);
    const durations = await page.evaluate(() => {
      const dialog = document.querySelector('dialog.palette')!;
      const all = [dialog, ...dialog.querySelectorAll('*')];
      return { dialog: getComputedStyle(dialog).transitionDuration, backdrop: getComputedStyle(dialog, '::backdrop').transitionDuration,
        moving: all.filter(element => getComputedStyle(element).transitionDuration.split(',').some(value => parseFloat(value) > 0) || getComputedStyle(element).animationName !== 'none').length,
        options: [...dialog.querySelectorAll('[role=option]')].map(option => getComputedStyle(option).transitionDuration) };
    });
    expect(durations.dialog).toBe('0s'); expect(durations.backdrop).toBe('0s'); expect(durations.moving).toBe(0);
    expect(durations.options.length).toBeGreaterThan(0); expect(new Set(durations.options)).toEqual(new Set(['0s']));
    await page.keyboard.press('Escape');
  } finally { await closeApp(app); f.cleanup(); }
});
