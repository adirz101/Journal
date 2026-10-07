import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { fixtureEnv } from './support/env';
import { expectAccessible, expectVisibleFocus, tabTo } from './support/a11y';
import { chooseAgent, paletteDialog, paletteInput, startButton, startSession, taskBox } from './support/ui';

// Phase 9 part 2: the accessibility and keyboard pass over the Phase 8 screens (the command
// palette, open-file, the runtime banner, crash recovery, an agent that can't start and all
// slots in use). Each screen is audited in both themes (names, contrast, no live region inside
// the terminal), focus rings are checked against blur(), and focus must never fall to the page
// when a control goes away. Real Electron, runtime and node-pty with fixture CLIs; hidden
// windows, no notifications, no real provider logins.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

const mac = process.platform === 'darwin';

// codexAuth: the Codex fixture answers `login status` (signed out until the file signed-in exists).
// The fixture prints its task and echoes typed lines; `flood` prints 1000 lines over about 5 s.
function setup(name: string, { codexAuth = false } = {}) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`));
  const project = resolve(root, 'a11y project'); const bin = resolve(root, 'bin'); const home = resolve(root, 'home');
  for (const dir of [project, bin, home]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# Accessibility fixture\n'); git('add', '.'); git('commit', '-qm', 'init');
  const ledger = resolve(root, 'launches.jsonl'); const signedIn = resolve(root, 'codex-signed-in');
  const auth = `const a=process.argv.slice(2);
if(a.join(' ')==='--help'){console.log('Usage: codex [OPTIONS] [PROMPT]\\n\\nCommands:\\n  exec    Run non-interactively\\n  login   Manage login');process.exit(0)}
if(a.join(' ')==='login --help'){console.log('Usage: codex login [OPTIONS] [COMMAND]\\n\\nCommands:\\n  status  Show login status');process.exit(0)}
if(a.join(' ')==='login status'){if(fs.existsSync(${JSON.stringify(signedIn)})){console.error('Logged in using ChatGPT');process.exit(0)}console.error('Not logged in');process.exit(1)}`;
  const fixture = (withAuth: boolean) => `#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
${withAuth ? auth : ''}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})+'\\n');
console.log('TASK '+(process.argv.at(-1)||'').split('\\n').at(-1));process.stdin.setRawMode(true);let line='';
process.stdin.on('data',d=>{for(const c of d.toString()){if(c!=='\\r'){line+=c;continue}
if(line==='flood'){let n=0;const t=setInterval(()=>{process.stdout.write('flood line '+(++n)+' '+'x'.repeat(60)+'\\r\\n');if(n>=1000)clearInterval(t)},5)}
else process.stdout.write('\\r\\nECHO '+line+'\\r\\n');line=''}});`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture(codexAuth && provider === 'codex')); chmodSync(resolve(bin, provider), 0o755); }
  const env = fixtureEnv({ root, bin, home, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  delete env.ELECTRON_RUN_AS_NODE;
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const runtimeInfo = () => JSON.parse(readFileSync(resolve(root, 'data/runtime.json'), 'utf8'));
  const cleanup = () => {
    for (const pid of launches().map(entry => entry.pid)) { try { if (execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(root)) process.kill(pid, 'SIGKILL'); } catch {} }
    try { const info = runtimeInfo(); if (execFileSync('ps', ['-p', String(info.pid), '-o', 'command='], { encoding: 'utf8' }).includes('runtime.mjs')) process.kill(info.pid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { root, project, env, launches, runtimeInfo, signedIn, cleanup };
}

async function open(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    (globalThis as any).__journalFocused = () => true; // counts as focused: no OS notification
  }, project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
  await expect(taskBox(page)).toBeVisible();
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; }
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(done => setTimeout(done, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
const request = (page: Page, action: string, input: object = {}) => page.evaluate(([name, value]) => (window as any).journal.request(name, value), [action, input] as const);
const terminalInput = (page: Page) => page.locator('.terminal-surface .xterm-helper-textarea');
const terminalHasFocus = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('.xterm'));
// Where focus is: never the page itself after a control goes away.
const focusOnPage = (page: Page) => page.evaluate(() => !document.activeElement || document.activeElement === document.body);
const emit = (app: ElectronApplication, event: object) => app.evaluate(({ BrowserWindow }, data) => { BrowserWindow.getAllWindows()[0].webContents.send('journal:event', data); }, event);

// The palette's structure as assistive technology reads it.
function paletteStructure(page: Page) {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('dialog[open] input[role=combobox]')!;
    const nameOf = (el: Element) => (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim() || (el.getAttribute('aria-label') ?? '');
    const list = document.getElementById(input.getAttribute('aria-controls') ?? '');
    const options = list ? [...list.querySelectorAll('[role=option]')] : [];
    const activeId = input.getAttribute('aria-activedescendant');
    const active = activeId ? document.getElementById(activeId) : null;
    const plain = options.find(o => o !== active);
    return {
      dialog: input.closest('dialog')?.getAttribute('aria-label') ?? null, inputName: input.getAttribute('aria-label'), expanded: input.getAttribute('aria-expanded'),
      autocomplete: input.getAttribute('aria-autocomplete'), described: document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent?.trim() ?? '',
      listRole: list?.getAttribute('role') ?? null, listName: list ? nameOf(list) : null,
      groups: list ? [...list.querySelectorAll('[role=group]')].map(group => ({ name: nameOf(group), options: group.querySelectorAll('[role=option]').length })) : [],
      ungrouped: options.filter(option => !option.closest('[role=group]')).length,
      unnamedOptions: options.filter(option => !(option.textContent ?? '').trim()).length,
      activeInList: !!active && options.includes(active), selected: options.filter(option => option.getAttribute('aria-selected') === 'true').map(option => option.id),
      activeId, // The active option differs from another option by its bar (box-shadow) or its fill, not only by text colour.
      activeMarked: !!active && (plain ? getComputedStyle(active).boxShadow !== getComputedStyle(plain).boxShadow || getComputedStyle(active).backgroundColor !== getComputedStyle(plain).backgroundColor : getComputedStyle(active).boxShadow !== 'none'),
      // Only the input is a tab stop: options are reached with aria-activedescendant.
      tabStops: [...(input.closest('dialog')?.querySelectorAll<HTMLElement>('button,input,[tabindex]:not([tabindex="-1"]),a[href]') ?? [])].filter(el => !el.hasAttribute('disabled')).length,
    };
  });
}
async function expectPaletteStructure(page: Page, where: string) {
  const s = await paletteStructure(page);
  expect(s.inputName, where).toBe(s.dialog);
  expect(s.expanded, where).toBe('true'); expect(s.autocomplete, where).toBe('list');
  expect(s.described.length, `${where}: how to use it`).toBeGreaterThan(10);
  expect(s.listRole, where).toBe('listbox'); expect(s.listName, where).not.toBe('');
  for (const group of s.groups) { expect(group.name, `${where}: every group has a name`).not.toBe(''); expect(group.options, `${where}: ${group.name}`).toBeGreaterThan(0); }
  expect(s.ungrouped, `${where}: options outside a group`).toBe(0);
  expect(s.unnamedOptions, `${where}: options without a name`).toBe(0);
  if (s.groups.length) {
    expect(s.activeInList, `${where}: aria-activedescendant names a listed option`).toBe(true);
    expect(s.selected, `${where}: exactly the active option is selected`).toEqual([s.activeId]);
    expect(s.activeMarked, `${where}: the active option is marked by more than colour of text`).toBe(true);
  }
  expect(s.tabStops, `${where}: one tab stop`).toBe(1);
  return s;
}

// Counts changes to every live region while `during` runs.
async function liveRegionChanges(page: Page, during: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as any; w.__liveChanges = [];
    w.__liveObserver = new MutationObserver(records => { for (const record of records) { const region = (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('[aria-live]:not([aria-live=off]),[role=status],[role=alert],[role=log]'); if (region) w.__liveChanges.push(region.className || region.tagName); } });
    w.__liveObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await during();
  return page.evaluate(() => { const w = window as any; w.__liveObserver.disconnect(); return w.__liveChanges as string[]; });
}

test('palette and open-file: names and roles, contrast in both themes, one tab stop, focus back to the terminal, nothing announced per chunk', async () => {
  const f = setup('a11y-palette'); const { app, page } = await open(f.env, f.project);
  try {
    await startSession(page, 'claude', { task: 'PALETTE_A11Y' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK PALETTE_A11Y');
    await terminalInput(page).focus();

    // ⌘K / Ctrl+Shift+P from the terminal.
    await pressKey(app, mac ? 'K' : 'P', mac ? ['meta'] : ['control', 'shift']);
    await expect(paletteDialog(page)).toBeVisible();
    await expect(paletteInput(page)).toBeFocused(); await expectVisibleFocus(page);
    await expect(page.locator('#palette-list [role=option]').first()).toBeVisible();
    await expectPaletteStructure(page, 'Palette, empty query');
    await expectAccessible(page, 'Palette, empty query');
    // Arrows move the active option; it stays the only selected one and the input keeps focus.
    const before = (await paletteStructure(page)).activeId;
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await paletteStructure(page)).activeId).not.toBe(before);
    await expectPaletteStructure(page, 'Palette after ArrowDown');
    await expect(paletteInput(page)).toBeFocused();
    // Tab stays in the input (the only tab stop).
    await page.keyboard.press('Tab');
    await expect(paletteInput(page)).toBeFocused();

    // Actions only, with an unavailable one and its reason.
    await page.keyboard.type('>');
    await expect(page.locator('#palette-list [role=group]')).toHaveCount(1);
    await expectPaletteStructure(page, 'Palette, actions only');
    await expectAccessible(page, 'Palette, actions only');
    // No results: the message and the two fallbacks.
    await page.keyboard.press('Backspace'); await page.keyboard.type('zqxv no such thing');
    await expect(page.locator('.palette-none')).toBeVisible();
    await expectPaletteStructure(page, 'Palette, no results');
    await expectAccessible(page, 'Palette, no results');
    // The result count is announced once the query settles, in a region that stays mounted.
    await expect(page.locator('dialog[open] [aria-live=polite]')).toHaveText('No results');

    // While the terminal floods behind the palette, no live region changes.
    await page.keyboard.press('Escape');
    await expect(paletteDialog(page)).toHaveCount(0);
    await expect.poll(() => terminalHasFocus(page)).toBe(true);
    await terminalInput(page).pressSequentially('flood'); await terminalInput(page).press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('flood line');
    await pressKey(app, mac ? 'K' : 'P', mac ? ['meta'] : ['control', 'shift']);
    await expect(paletteInput(page)).toBeFocused();
    await page.waitForTimeout(400); // the count settles once
    const changes = await liveRegionChanges(page, () => page.waitForTimeout(1200));
    expect(changes, 'live regions changed during terminal output').toEqual([]);
    // ⇧⌘P (macOS alias) or the same key closes it from inside; focus goes back to the terminal.
    await pressKey(app, 'P', mac ? ['meta', 'shift'] : ['control', 'shift']);
    await expect(paletteDialog(page)).toHaveCount(0);
    await expect.poll(() => terminalHasFocus(page)).toBe(true);

    // Open-file (⌘P / Ctrl+Shift+O) from the terminal.
    await pressKey(app, mac ? 'P' : 'O', mac ? ['meta'] : ['control', 'shift']);
    await expect(paletteDialog(page, 'Open a file')).toBeVisible();
    await expect(paletteInput(page)).toBeFocused(); await expectVisibleFocus(page);
    await expectPaletteStructure(page, 'Open-file, empty');
    await expectAccessible(page, 'Open-file, empty');
    await page.keyboard.type('READ');
    await expect(page.locator('#palette-list [role=option]', { hasText: 'README.md' })).toBeVisible();
    await expectPaletteStructure(page, 'Open-file, a match');
    await expectAccessible(page, 'Open-file, a match');
    // The file note is one status region that stays mounted, empty while files are listed, so
    // "No file name matches…" after a list is announced.
    const note = page.locator('dialog[open] .palette-note[role=status]');
    await expect(note).toHaveCount(1); await expect(note).toHaveText('');
    await page.keyboard.type('zzqq');
    await expect(note).toHaveText('No file name matches “READzzqq”.');
    await page.keyboard.press('Escape');
    await expect(paletteDialog(page, 'Open a file')).toHaveCount(0);
    await expect.poll(() => terminalHasFocus(page)).toBe(true);
    // Keys still reach the agent.
    await terminalInput(page).pressSequentially('after'); await terminalInput(page).press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO after');
  } finally { await closeApp(app); f.cleanup(); }
});

test('runtime banner and crash recovery: announced, named, reachable by keyboard, and focus is kept when they go', async () => {
  const f = setup('a11y-recovery'); const { app, page } = await open(f.env, f.project);
  try {
    await startSession(page, 'claude', { task: 'RECOVER_ME' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK RECOVER_ME');
    await startSession(page, 'codex', { task: 'RECOVER_TOO' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK RECOVER_TOO');

    // Lost connection (a synthetic event): the banner sits in a status region that stays mounted.
    const live = page.locator('.runtime-live[role=status]');
    await expect(live).toHaveCount(1); await expect(live).toHaveText('');
    await emit(app, { type: 'runtime', state: 'disconnected' });
    await expect(live).toContainText('Lost connection to the session runtime');
    await expectAccessible(page, 'Runtime banner');
    const reconnect = live.getByRole('button', { name: 'Reconnect now', exact: true });
    await page.locator('.session-header button').first().focus();
    await tabTo(page, reconnect, { back: true }); await expectVisibleFocus(page);
    await page.keyboard.press('Enter');
    // Reconnecting… keeps focus (it is aria-disabled, not disabled).
    const waiting = live.getByRole('button', { name: 'Reconnecting…', exact: true });
    await expect(waiting).toBeFocused(); await expect(waiting).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Enter'); // a second press does nothing
    await expect(waiting).toBeFocused();
    // Connected again: the banner goes and focus moves to the session, not the page.
    await emit(app, { type: 'runtime', state: 'connected', recovery: null });
    await expect(live).toHaveText('');
    expect(await focusOnPage(page)).toBe(false);
    await expect.poll(() => terminalHasFocus(page)).toBe(true);

    // A real runtime crash: the recovery panel is announced once, named, and reachable.
    const before = f.runtimeInfo(); process.kill(before.pid, 'SIGKILL');
    const panel = page.getByRole('region', { name: 'The session runtime stopped unexpectedly' });
    await expect(panel).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.recovery-live[role=status]')).toContainText('The session runtime stopped unexpectedly. 2 sessions were interrupted.');
    await expect(page.getByText('Runtime connected')).toBeVisible({ timeout: 20000 });
    await expectAccessible(page, 'Recovery panel');
    await expect(panel.getByRole('list', { name: 'Interrupted sessions' }).getByRole('listitem')).toHaveCount(2);
    const done = panel.getByRole('button', { name: 'Done', exact: true });
    const confirm = panel.getByRole('button', { name: 'Confirm ID…', exact: true });
    const cont = panel.getByRole('button', { name: 'Continue', exact: true });
    await done.focus();
    await tabTo(page, cont, { back: true }); await expectVisibleFocus(page);
    await tabTo(page, confirm); await expectVisibleFocus(page);
    await tabTo(page, done); await expectVisibleFocus(page);
    expect(f.launches()).toHaveLength(2); // nothing was resent
    // Continue: its row goes; focus moves to the panel's next control, never the page.
    await cont.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => f.launches().length).toBe(3);
    await expect(cont).toHaveCount(0);
    expect(await focusOnPage(page)).toBe(false);
    // Done: the panel goes and focus moves to the session.
    await done.focus(); await page.keyboard.press('Enter');
    await expect(panel).toHaveCount(0);
    expect(await focusOnPage(page)).toBe(false);
    await expect(page.locator('.recovery-live[role=status]')).toHaveText('');
  } finally { await closeApp(app); f.cleanup(); }
});

test('an agent that can’t start: the card is named, its buttons are reachable with visible focus, and focus moves to Start when it goes', async () => {
  const f = setup('a11y-start-error', { codexAuth: true }); const { app, page } = await open(f.env, f.project);
  try {
    await app.evaluate(() => { (globalThis as any).__journalAuthProbes = true; });
    await request(page, 'providerStatus', { provider: 'codex', fresh: true });
    await chooseAgent(page, 'codex');
    const card = page.locator('.start-error');
    await expect(card).toContainText('Codex isn’t signed in');
    await expect(card).toHaveAttribute('role', 'status');
    await expect(page.getByRole('status', { name: 'Codex isn’t signed in' })).toBeVisible();
    await taskBox(page).fill('KEEP_THIS');
    await expectAccessible(page, 'Can’t start (signed out)');
    for (const name of ['Open terminal', 'Copy command', 'Check again']) {
      await tabTo(page, card.getByRole('button', { name, exact: true })); await expectVisibleFocus(page);
    }
    // Check again keeps focus while it runs (aria-disabled), and once Codex is signed in the card goes
    // and focus moves to Start, which is enabled.
    writeFileSync(f.signedIn, '');
    await page.keyboard.press('Enter');
    await expect(card).toHaveCount(0, { timeout: 15000 });
    await expect(startButton(page)).toBeFocused();
    await expectVisibleFocus(page);
    await expect(taskBox(page)).toHaveValue('KEEP_THIS');
    expect(f.launches()).toHaveLength(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('four idle sessions do not disable the keyboard launch path', async () => {
  const f = setup('a11y-full'); const { app, page } = await open(f.env, f.project);
  try {
    for (let i = 0; i < 4; i++) {
      await startSession(page, i % 2 ? 'codex' : 'claude', { task: `FULL_${i}` });
      await expect(page.locator('.terminal-surface')).toContainText(`TASK FULL_${i}`);
    }
    await terminalInput(page).focus();
    await pressKey(app, 'N', mac ? ['meta'] : ['control', 'shift']);
    await expect(taskBox(page)).toBeFocused(); await expectVisibleFocus(page);
    await page.keyboard.type('WAITING');
    await expect(startButton(page)).toBeEnabled();
    await expectAccessible(page, 'On-demand session start');
    await page.keyboard.press(mac ? 'Meta+Enter' : 'Control+Enter');
    await expect(page.locator('.terminal-surface')).toContainText('TASK WAITING');
    await expect.poll(() => f.launches().length).toBe(5);
  } finally { await closeApp(app); f.cleanup(); }
});
