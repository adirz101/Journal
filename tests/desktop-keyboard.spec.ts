import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { fixtureEnv } from './support/env';
import { audit, expectAccessible, expectVisibleFocus, focusRingProblem, tabTo } from './support/a11y';
import { taskBox } from './support/ui';

// Phase 9: the three usability tasks of board B15, walked with the keyboard only.
// After launch, every user action is a key press: Tab and Shift+Tab, Enter, Space,
// arrows and typing in the page, and app shortcuts through the shortcut router
// (pressKey, which goes through before-input-event like a real key). The open
// dialog is stubbed (it is the operating system's), notes are seeded through the
// store as fixture data, and the fixture agent is a local script. At each step the
// visible screen is audited in both themes: every control has a name, text meets
// its contrast minimum, and no live region sits inside the terminal.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

const mac = process.platform === 'darwin';
type Modifier = 'meta' | 'control' | 'alt' | 'shift';
const keys: Record<string, [string, Modifier[]]> = {
  openProject: mac ? ['O', ['meta']] : ['O', ['control']],
  newSession: mac ? ['N', ['meta']] : ['N', ['control', 'shift']],
  nextNeedsYou: mac ? ['J', ['meta']] : ['J', ['control', 'shift']],
  focusTerminal: mac ? ['E', ['meta']] : ['E', ['control', 'shift']],
  slot1: mac ? ['1', ['meta']] : ['1', ['alt']],
};
const press = (app: ElectronApplication, key: 'openProject' | 'newSession' | 'nextNeedsYou' | 'focusTerminal' | 'slot1') => pressKey(app, keys[key][0], keys[key][1]);
const startKey = mac ? 'Meta+Enter' : 'Control+Enter';

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`)); const bin = resolve(root, 'bin'); const home = resolve(root, 'home');
  const project = resolve(root, 'keyboard project'); for (const dir of [bin, home, project, resolve(project, 'src')]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(resolve(project, 'README.md'), '# Keyboard fixture\n\nA fixture project for the keyboard walkthroughs.\n');
  writeFileSync(resolve(project, 'src/a.js'), 'const graceMs = 3000;\nexport function stop() {}\nexport const other = 1;\n');
  git('add', '.'); git('commit', '-qm', 'init');
  const ledger = resolve(root, 'launches.jsonl');
  // Prints its task. Commands typed into its terminal: perm <command> (runs Journal's real
  // permission hook, as Claude would), setline <file> <n> <text>, exit-with <n>; anything else echoes.
  const fixture = `#!${process.execPath}
const fs=require('node:fs');const {spawn}=require('node:child_process');
if(process.argv.includes('--version')){console.log('2.1.0 (Claude Code)');process.exit(0)}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({argv:process.argv.slice(2)})+'\\n');
const task=(process.argv.at(-1)||'').split('\\n').at(-1);console.log('TASK '+task);
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let input='';
process.stdin.on('data',data=>{for(const char of data){
if(char==='\\x1b'){console.log('ESC');continue}
if(char!=='\\r'&&char!=='\\n'){input+=char;continue}
const command=input;input='';const [verb,...rest]=command.split(' ');
if(verb==='perm'){const a=process.argv;const hook=JSON.parse(fs.readFileSync(a[a.indexOf('--settings')+1],'utf8')).hooks.PermissionRequest[0].hooks[0].command;
const c=spawn('/bin/sh',['-c',hook],{stdio:['pipe','ignore','ignore']});c.on('exit',()=>console.log('ASKED'));
c.stdin.end(JSON.stringify({hook_event_name:'PermissionRequest',session_id:a[a.indexOf('--session-id')+1],cwd:process.cwd(),tool_name:'Bash',tool_use_id:'perm1',tool_input:{command:rest.join(' ')}}))}
else if(verb==='setline'){const lines=fs.readFileSync(rest[0],'utf8').split('\\n');lines[Number(rest[1])-1]=rest.slice(2).join(' ');fs.writeFileSync(rest[0],lines.join('\\n'));console.log('WROTE '+rest[0])}
else if(verb==='exit-with')process.exit(Number(rest[0]));
else console.log('ECHO '+command);
}});`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env = fixtureEnv(root, bin, { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' });
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { argv: string[] }) : [];
  return { root, project, env, launches, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function launch(f: ReturnType<typeof setup>, { firstRun = false } = {}) {
  const app = await electron.launch({ args: ['.'], env: f.env });
  await app.evaluate(({ dialog }, state) => {
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [state.project] });
    (globalThis as any).__journalFocused = () => true; // the window counts as focused: no OS notification
    if (state.firstRun) (globalThis as any).__journalFirstRun = true;
  }, { project: f.project, firstRun });
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Your agents remember your project' })).toBeVisible();
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; }
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(done => setTimeout(done, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
const terminal = (page: Page) => page.locator('.terminal-surface');
const request = (page: Page, action: string, input: object = {}) => page.evaluate(([name, value]) => (window as any).journal.request(name, value), [action, input] as const);

// Starts a session from the composer with the keyboard: the task box has focus after
// New session, the task is typed and ⌘↵ / Ctrl+Enter starts it.
async function startByKeyboard(app: ElectronApplication, page: Page, task: string) {
  await press(app, 'newSession');
  await expect(taskBox(page)).toBeFocused();
  await page.keyboard.type(task);
  // ⌘↵ does nothing while Start is disabled (agents still being checked after launch).
  await expect(page.getByRole('form', { name: 'Start a session' }).getByRole('button', { name: /^Start / })).toBeEnabled();
  await page.keyboard.press(startKey);
  await expect(terminal(page)).toContainText(`TASK ${task}`, { timeout: 15000 });
}
// Types a line into the terminal: ⌘E / Ctrl+Shift+E focuses it first.
async function typeInTerminal(app: ElectronApplication, page: Page, line: string, expected: string) {
  await press(app, 'focusTerminal');
  await expect(page.locator('.terminal-surface .xterm-helper-textarea')).toBeFocused();
  // Keys typed before the replay finishes are dropped: retry until the fixture echoes.
  await expect(async () => {
    await page.keyboard.type(line); await page.keyboard.press('Enter');
    await expect(terminal(page)).toContainText(expected, { timeout: 2000 });
  }).toPass({ timeout: 20000 });
}

test('task 1 (first run): open a project, Remember both, then start the first session, by keyboard', async () => {
  const f = setup('kbd-first-run'); const { app, page } = await launch(f, { firstRun: true });
  try {
    await expectAccessible(page, 'Welcome');
    // Tab reaches Open a project… with a visible focus ring; Enter opens the (stubbed) dialog.
    const open = page.getByRole('button', { name: 'Open a project…', exact: true });
    await tabTo(page, open); await expectVisibleFocus(page);
    await page.keyboard.press('Enter');

    // Getting to know your project: its heading has focus, so the keys work at once.
    const title = page.getByRole('heading', { name: 'I read your project. Here’s what I’d tell an agent.' });
    await expect(title).toBeVisible(); await expect(title).toBeFocused();
    await expectAccessible(page, 'Getting to know your project');
    const branch = page.getByRole('region', { name: 'Where this branch stands' });
    await tabTo(page, branch.getByRole('textbox', { name: 'Working on now' })); await expectVisibleFocus(page);
    await page.keyboard.type('Keyboard walkthrough');
    await page.keyboard.press('Enter'); // Enter moves to the next field
    await expect(branch.getByRole('textbox', { name: 'Next', exact: true })).toBeFocused();
    await page.keyboard.type('Ship the polish pass');
    const rememberBoth = page.getByRole('button', { name: /^Remember both/ });
    await tabTo(page, rememberBoth); await expectVisibleFocus(page);
    await page.keyboard.press('Enter');

    // The first session: back in New session with focus in the task box.
    await expect(title).toHaveCount(0);
    await expect(taskBox(page)).toBeFocused();
    await expect(page.locator('.first-note')).toContainText('First note remembered.');
    await expectAccessible(page, 'New session after the first notes');
    // The agent is a radio group: arrows move between agents, and the checked one is the Start button's.
    const agents = page.getByRole('radiogroup', { name: 'Agent' });
    await tabTo(page, agents.getByRole('radio', { checked: true }), { back: true }); await expectVisibleFocus(page);
    await expect(agents.getByRole('radio', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-checked', 'true');
    // Back to the task box, type the task, Tab to Start and press it.
    await tabTo(page, taskBox(page)); await page.keyboard.type('Add a keyboard test');
    const start = page.getByRole('form', { name: 'Start a session' }).getByRole('button', { name: /^Start / });
    await tabTo(page, start); await expectVisibleFocus(page);
    await expect(start).toHaveText(/^Start Claude Code/);
    await page.keyboard.press('Enter');
    await expect(terminal(page)).toContainText('TASK Add a keyboard test', { timeout: 15000 });
    expect(f.launches()).toHaveLength(1);
    // A started session takes focus in its terminal.
    await expect(page.locator('.terminal-surface .xterm-helper-textarea')).toBeFocused();
    await expectAccessible(page, 'Running session');
  } finally { await closeApp(app); f.cleanup(); }
});

test('task 2 (a session needs you): ⌘J / Ctrl+Shift+J finds the waiting session and the banner names the command', async () => {
  const f = setup('kbd-needs-you'); const { app, page } = await launch(f);
  try {
    await press(app, 'openProject');
    await expect(taskBox(page)).toBeVisible();
    await startByKeyboard(app, page, 'CALM_ONE');
    await startByKeyboard(app, page, 'ASKING_TWO');
    await typeInTerminal(app, page, 'perm npm publish --dry-run', 'ASKED');
    await expect(page.locator('.session-header .session-meta')).toContainText('Needs approval');
    // Go elsewhere with the slot key, then let ⌘J / Ctrl+Shift+J find the session that needs you.
    // Slot keys are ignored while a switch is still loading (busy).
    await expect(page.locator('main.workspace')).not.toHaveAttribute('aria-busy', 'true');
    await press(app, 'slot1');
    const row = (task: string) => page.getByRole('button', { name: new RegExp(`: ${task}\\.`) });
    await expect(row('CALM_ONE')).toHaveAttribute('aria-current', 'true');
    // The waiting row says so in its name, not by colour alone.
    await expect(row('ASKING_TWO')).toHaveAttribute('aria-label', /Needs approval, npm publish --dry-run.*needs attention/);
    await expect(page.locator('main.workspace')).not.toHaveAttribute('aria-busy', 'true');
    await press(app, 'nextNeedsYou');
    await expect(row('ASKING_TWO')).toHaveAttribute('aria-current', 'true');
    // Keyboard switches never animate (review-animations): nothing is running after the switch.
    expect(await page.evaluate(() => document.getAnimations().map(a => (a as CSSAnimation).animationName ?? a.constructor.name))).toEqual([]);
    // The banner is announced (a status region that stays mounted) and names the command.
    const status = page.locator('.attention-live[role=status]');
    await expect(status).toContainText('Claude is waiting for your approval');
    await expect(status).toContainText('npm publish --dry-run');
    await expectAccessible(page, 'Waiting session with its banner');
    // Answering in the terminal (Esc) clears it; the region stays and empties.
    await press(app, 'focusTerminal'); await page.keyboard.press('Escape');
    await expect(page.locator('.session-header .session-meta')).toContainText('Your turn');
    await expect(status).toHaveText('');
  } finally { await closeApp(app); f.cleanup(); }
});

test('task 3 (an out-of-date note): read the catch, Still true, then Continue, by keyboard', async () => {
  const f = setup('kbd-catch'); const { app, page } = await launch(f);
  try {
    await press(app, 'openProject');
    await expect(taskBox(page)).toBeVisible();
    // Fixture data: one remembered note based on src/a.js lines 1-2.
    const projectId = (await request(page, 'bootstrap') as any).projects[0].id;
    const note = await request(page, 'proposeMemory', { projectId, input: { statement: 'Stop waits 3 s before it kills the process', category: 'decision', scope: 'checkout', area: '', source: { kind: 'file', path: 'src/a.js', startLine: 1, endLine: 2 } } }) as any;
    await request(page, 'setMemoryStatus', { id: note.id, status: 'active' });
    await startByKeyboard(app, page, 'Raise the grace period');
    await typeInTerminal(app, page, 'setline src/a.js 1 const graceMs = 5000;', 'WROTE src/a.js');
    await page.keyboard.type('exit-with 0'); await page.keyboard.press('Enter');

    // The wrap-up takes focus on its heading when the session ends with nothing else focused.
    const card = page.locator('.stale-catch');
    await expect(card.getByRole('heading', { name: 'This session changed a.js. 1 note is based on it.' })).toBeVisible({ timeout: 15000 });
    await expect(card.getByRole('table')).toBeVisible();
    await expect(card.getByRole('columnheader')).toHaveText(['Saved line', 'Line now', 'Change', 'Text']);
    await expectAccessible(page, 'Wrap-up with the out-of-date catch');
    const stillTrue = card.getByRole('button', { name: 'Still true', exact: true });
    await tabTo(page, stillTrue); await expectVisibleFocus(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('.wrap-resolved')).toContainText('Marked still true.');
    // Focus is not lost when the card is replaced: it moves to Undo, and Undo brings it back to Still true.
    const undo = page.locator('.wrap-resolved').getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeFocused(); await expectVisibleFocus(page);
    await page.keyboard.press('Enter');
    await expect(stillTrue).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(undo).toBeFocused();
    await expect(page.locator('.wrap-up [role=status]').first()).toContainText('Marked still true.');
    // Continue reopens the same conversation (exact ID).
    const cont = page.locator('.wrap-up').getByRole('button', { name: /^Continue/ }).first();
    await tabTo(page, cont); await expectVisibleFocus(page);
    await page.keyboard.press('Enter');
    await expect.poll(() => f.launches().length, { timeout: 15000 }).toBe(2);
    const [first, second] = f.launches();
    const id = first.argv[first.argv.indexOf('--session-id') + 1];
    expect(second.argv).toContain('--resume'); expect(second.argv).toContain(id);
    await expect(page.locator('.terminal-surface .xterm-helper-textarea')).toBeFocused();
    // Leaving the wrap-up committed the check.
    await expect.poll(async () => (await request(page, 'getMemory', { id: note.id }) as any).revision).toBe(2);
  } finally { await closeApp(app); f.cleanup(); }
});

test('every dialog gives focus back; the inspector tabs, Memory and the status bar work from the keyboard', async () => {
  const f = setup('kbd-dialogs'); const { app, page } = await launch(f);
  const settingsKey = mac ? [',', ['meta']] as const : [',', ['control']] as const;
  const addNoteKey = mac ? ['K', ['meta', 'shift']] as const : ['K', ['control', 'shift']] as const;
  const memoryTabKey = mac ? ['3', ['meta', 'alt']] as const : ['3', ['alt', 'shift']] as const;
  const filesTabKey = mac ? ['2', ['meta', 'alt']] as const : ['2', ['alt', 'shift']] as const;
  try {
    await press(app, 'openProject');
    await expect(taskBox(page)).toBeFocused();
    await expectAccessible(page, 'New session with the inspector');

    // Settings from its sidebar button: Escape closes it and focus is back on the button.
    const settingsButton = page.locator('.sidebar-footer').getByRole('button', { name: 'Settings', exact: true });
    await tabTo(page, settingsButton); await expectVisibleFocus(page);
    await page.keyboard.press('Enter');
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
    await expectAccessible(page, 'Settings');
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0); await expect(settingsButton).toBeFocused();

    // Manage workspaces from the composer, closed with its Close button.
    const manage = page.getByRole('button', { name: 'Manage workspaces', exact: true });
    await tabTo(page, manage); await page.keyboard.press('Enter');
    const workspaces = page.getByRole('dialog');
    await expect(workspaces).toBeVisible();
    await expectAccessible(page, 'Workspaces dialog');
    await page.keyboard.press('Escape');
    await expect(workspaces).toHaveCount(0); await expect(manage).toBeFocused();

    // Fixture data: a note the task matches, so the status bar says what was sent.
    const projectId = (await request(page, 'bootstrap') as any).projects[0].id;
    const note = await request(page, 'proposeMemory', { projectId, input: { statement: 'Dialogs return focus to their opener', category: 'decision', scope: 'checkout', area: '', source: { kind: 'user', note: 'Fixture' } } }) as any;
    await request(page, 'setMemoryStatus', { id: note.id, status: 'active' });
    // From a running session's terminal: ⌘, and ⇧⌘K (Ctrl+, and Ctrl+Shift+K) return focus to the terminal.
    await startByKeyboard(app, page, 'dialogs focus');
    const xterm = page.locator('.terminal-surface .xterm-helper-textarea');
    await expect(xterm).toBeFocused();
    await expectAccessible(page, 'Running session with the status bar');
    await pressKey(app, settingsKey[0], [...settingsKey[1]]);
    await expect(settings).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0); await expect(xterm).toBeFocused();
    await pressKey(app, addNoteKey[0], [...addNoteKey[1]]);
    const form = page.getByRole('dialog');
    await expect(form).toBeVisible();
    await expectAccessible(page, 'Add a note');
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0); await expect(xterm).toBeFocused();

    // Inspector tabs: ⌥⌘3 / Alt+Shift+3 shows Memory and the terminal keeps focus (Tab belongs to the CLI there).
    await pressKey(app, memoryTabKey[0], [...memoryTabKey[1]]);
    const memoryTab = page.getByRole('tab', { name: /^Memory/ });
    await expect(memoryTab).toHaveAttribute('aria-selected', 'true'); await expect(xterm).toBeFocused();
    await expectAccessible(page, 'Memory tab');
    // The keyboard's ways out of the terminal: ⌥⌘2 / Alt+Shift+2 focuses the Files tree, ⌘N the task box.
    await pressKey(app, filesTabKey[0], [...filesTabKey[1]]);
    // No changes yet, so Files shows All files and its tree takes focus.
    await expect(page.locator('.inspector-panel [role=treeitem]').first()).toBeFocused(); await expectVisibleFocus(page);
    await expectAccessible(page, 'Files tab');
    // Arrows move between the tabs (roving focus).
    const filesTab = page.getByRole('tab', { name: /^Files/ });
    await tabTo(page, filesTab, { back: true }); await expectVisibleFocus(page);
    await page.keyboard.press('ArrowRight');
    await expect(memoryTab).toBeFocused(); await expect(memoryTab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    const sessionTab = page.getByRole('tab', { name: /^Session/ });
    await expect(sessionTab).toBeFocused(); await expect(sessionTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await sessionTab.getAttribute('id') ?? '');
    await expectAccessible(page, 'Session tab');
    // The status bar's "See what was sent" (before the inspector in the tab order) opens the packet.
    const sent = page.locator('.status-bar').getByRole('button', { name: 'See what was sent' });
    await expect(page.locator('.status-bar')).toContainText('Agent got 1 note');
    await tabTo(page, sent, { back: true }); await expectVisibleFocus(page);
    await page.keyboard.press('Enter');
    await expect(sessionTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.inspector-panel')).toContainText('Dialogs return focus to their opener');
  } finally { await closeApp(app); f.cleanup(); }
});

// ----- Phase 9 review fixes -----
const tabKey = (n: 1 | 2 | 3): [string, Modifier[]] => mac ? [String(n), ['meta', 'alt']] : [String(n), ['alt', 'shift']];
const focusTerminalKey: [string, Modifier[]] = mac ? ['E', ['meta']] : ['E', ['control', 'shift']];
async function seedFileNote(page: Page, statement: string) {
  const projectId = (await request(page, 'bootstrap') as any).projects[0].id;
  const note = await request(page, 'proposeMemory', { projectId, input: { statement, category: 'decision', scope: 'checkout', area: '', source: { kind: 'file', path: 'src/a.js', startLine: 1, endLine: 2 } } }) as any;
  await request(page, 'setMemoryStatus', { id: note.id, status: 'active' });
  return note.id as string;
}
// A session that changes src/a.js line 1 and exits: the wrap-up shows the out-of-date catch.
async function reachCatch(app: ElectronApplication, page: Page, task: string, value: number) {
  await startByKeyboard(app, page, task);
  await typeInTerminal(app, page, `setline src/a.js 1 const graceMs = ${value};`, 'WROTE src/a.js');
  await page.keyboard.type('exit-with 0'); await page.keyboard.press('Enter');
  const card = page.locator('.stale-catch').first();
  await expect(card).toBeVisible({ timeout: 15000 });
  return card;
}

test('the audit reports an unnamed dialog, listbox and comboboxes, and accepts named ones (review I3)', async () => {
  const f = setup('kbd-names'); const { app, page } = await launch(f);
  try {
    await page.evaluate(() => {
      const box = document.createElement('div'); box.id = 'probe';
      box.innerHTML = '<dialog open id="bad-dialog"><ul role="listbox" id="bad-list"><li role="option">Alpha</li></ul><input role="combobox" id="bad-input"><div role="combobox" tabindex="0" id="bad-div">Pick one</div></dialog>';
      document.body.append(box);
    });
    const unnamed = (await audit(page)).unnamed;
    for (const id of ['dialog#bad-dialog', 'ul#bad-list', 'input#bad-input', 'div#bad-div']) expect(unnamed, id).toContain(id);
    expect(unnamed.filter(entry => entry.startsWith('li'))).toEqual([]); // an option is named by its text
    await page.evaluate(() => {
      document.getElementById('bad-dialog')!.setAttribute('aria-label', 'Probe'); document.getElementById('bad-list')!.setAttribute('aria-label', 'Choices');
      document.getElementById('bad-div')!.setAttribute('aria-label', 'Choice');
      const label = document.createElement('label'); label.htmlFor = 'bad-input'; label.textContent = 'Search'; document.getElementById('bad-dialog')!.prepend(label);
    });
    const after = (await audit(page)).unnamed;
    expect(after.filter(entry => /#bad-/.test(entry))).toEqual([]);
  } finally { await closeApp(app); f.cleanup(); }
});

test('the focus check fails a shadow-only or transparent ring and passes the real one', async () => {
  const f = setup('kbd-ring'); const { app, page } = await launch(f);
  try {
    await page.evaluate(() => {
      const add = (label: string, style: string) => { const b = document.createElement('button'); b.textContent = label; b.setAttribute('style', style); document.querySelector('.welcome, main')!.prepend(b); };
      add('Ring control', '');
      add('Transparent outline', 'outline:2px solid transparent !important');
      add('Card shadow only', 'outline:none !important;box-shadow:0 1px 3px rgba(0,0,0,.6)');
    });
    for (const [name, ok] of [['Card shadow only', false], ['Transparent outline', false], ['Ring control', true]] as const) {
      await tabTo(page, page.getByRole('button', { name, exact: true }));
      const problem = await focusRingProblem(page);
      if (ok) expect(problem, name).toBeNull(); else expect(problem, name).not.toBeNull();
    }
  } finally { await closeApp(app); f.cleanup(); }
});

test('catch: Update and Forget leave focus on the resolved line, not the page', async () => {
  const f = setup('kbd-catch-focus'); const { app, page } = await launch(f);
  try {
    await press(app, 'openProject'); await expect(taskBox(page)).toBeVisible();
    // Two notes cite src/a.js, so the catch shows two cards: Update the first, Forget the second.
    await seedFileNote(page, 'Stop waits 3 s before it kills the process');
    await seedFileNote(page, 'Other code reads the grace period from a.js');
    await reachCatch(app, page, 'Update the grace', 5000);
    const cards = page.locator('.stale-catch');
    await expect(cards).toHaveCount(2);
    await tabTo(page, cards.first().getByRole('button', { name: 'Update note…', exact: true })); await page.keyboard.press('Enter');
    const form = page.getByRole('dialog');
    await expect(form).toBeVisible();
    await tabTo(page, form.getByRole('button', { name: 'Save for review', exact: true })); await page.keyboard.press('Enter');
    await expect(form).toHaveCount(0);
    const updated = page.locator('.wrap-resolved').filter({ hasText: 'Note updated.' });
    await expect(updated).toBeFocused(); await expectVisibleFocus(page);

    // Forget… (the OS confirmation is stubbed to Forget).
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await expect(cards).toHaveCount(1);
    await tabTo(page, cards.first().getByRole('button', { name: 'Forget…', exact: true })); await page.keyboard.press('Enter');
    await expect(page.locator('.wrap-resolved').filter({ hasText: 'Note forgotten.' })).toBeFocused();
  } finally { await closeApp(app); f.cleanup(); }
});

test('catch: Undo gives focus to the card heading when Still true can no longer be pressed', async () => {
  // Part 1 (review M2): Undo returns focus to Still true, or to the card's heading when Still true is
  // gone or disabled again. Fixture data reaches that state: while Still true is staged on card A,
  // the catch reloads (card B's whole change comes from a newer file) and now says A's note cannot be
  // marked still true here (wrong-branch, as after a branch switch). The file and its hash are
  // unchanged, so card A keeps its staged choice and its Undo.
  const f = setup('kbd-catch-undo'); const { app, page } = await launch(f);
  try {
    await press(app, 'openProject'); await expect(taskBox(page)).toBeVisible();
    const a = await seedFileNote(page, 'Stop waits 3 s before it kills the process');
    const b = await seedFileNote(page, 'Other code reads the grace period from a.js');
    await app.evaluate((_electron, ids) => {
      const g = globalThis as any; g.__catchReloaded = false;
      g.__journalRequestHook = async (action: string, run: () => Promise<any>) => {
        const value = await run();
        if (action === 'staleNotes' && value?.notes) for (const item of value.notes) {
          if (item.note.id === ids.b) item.truncated = true; // B offers Show the whole change
          if (g.__catchReloaded && item.note.id === ids.a) item.reaffirm = { allowed: false, reason: 'wrong-branch' };
        }
        if (action === 'staleNoteDiff' && g.__catchReloaded) return { ...value, available: true, reason: null, text: '+ newer', contentHash: 'a-newer-file' };
        return value;
      };
    }, { a, b });
    await reachCatch(app, page, 'Raise the grace again', 7000);
    const cards = page.locator('.stale-catch');
    await expect(cards).toHaveCount(2);
    const cardA = cards.filter({ hasText: 'Stop waits 3 s before it kills the process' });
    const cardB = cards.filter({ hasText: 'Other code reads the grace period from a.js' });
    await tabTo(page, cardA.getByRole('button', { name: 'Still true', exact: true })); await page.keyboard.press('Enter');
    const resolved = page.locator('.wrap-resolved').filter({ hasText: 'Marked still true.' });
    const undo = resolved.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeFocused();

    // Card B's whole change is from a newer file: the catch reloads with A's note now not allowed.
    await app.evaluate(() => { (globalThis as any).__catchReloaded = true; });
    await tabTo(page, cardB.getByRole('button', { name: 'Show the whole change', exact: true })); await page.keyboard.press('Enter');
    await expect(cardB).toContainText('The file changed again');
    await expect(undo).toBeVisible(); // A kept its staged choice across the reload

    await tabTo(page, undo, { back: true }); await page.keyboard.press('Enter');
    await expect(cardA.getByRole('button', { name: 'Still true', exact: true })).toHaveCount(0);
    await expect(cardA.getByRole('heading')).toBeFocused();
    await expectVisibleFocus(page);
    // Nothing was marked: the note is still at its first revision.
    await expect.poll(async () => (await request(page, 'getMemory', { id: a }) as any).revision).toBe(1);
  } finally { await closeApp(app); f.cleanup(); }
});

test('inspector keys: ⌥⌘1 keeps the terminal; ⌥⌘2 focuses Changed; a pending Files focus never steals the terminal', async () => {
  const f = setup('kbd-files'); const { app, page } = await launch(f);
  try {
    await press(app, 'openProject'); await expect(taskBox(page)).toBeVisible();
    await startByKeyboard(app, page, 'FILES_KEYS');
    const xterm = page.locator('.terminal-surface .xterm-helper-textarea');
    await typeInTerminal(app, page, 'echo-only', 'ECHO echo-only');

    // ⌥⌘1 / Alt+Shift+1 shows Session and leaves focus in the terminal.
    await pressKey(app, ...tabKey(1));
    await expect(page.getByRole('tab', { name: /^Session/ })).toHaveAttribute('aria-selected', 'true');
    await expect(xterm).toBeFocused();

    // A Files key whose tree has not loaded yet, then ⌘E: the late rows must not take focus.
    await app.evaluate(() => {
      const g = globalThis as any; g.__gate = new Promise(done => { g.__release = done; });
      g.__journalRequestHook = async (method: string, run: () => unknown) => { if (method === 'fileRoots' || method === 'listDirectory') await g.__gate; return run(); };
    });
    await pressKey(app, ...tabKey(2));
    await expect(page.getByRole('tab', { name: /^Files/ })).toHaveAttribute('aria-selected', 'true');
    await pressKey(app, ...focusTerminalKey);
    await expect(xterm).toBeFocused();
    await app.evaluate(() => { (globalThis as any).__release(); (globalThis as any).__journalRequestHook = undefined; });
    await expect(page.locator('.inspector-panel [role=treeitem]').first()).toBeVisible();
    await page.waitForTimeout(300);
    await expect(xterm).toBeFocused();

    // Without ⌘E, the same late rows do take focus (the pending focus itself works).
    await pressKey(app, ...tabKey(1));
    await app.evaluate(() => {
      const g = globalThis as any; g.__gate = new Promise(done => { g.__release = done; });
      g.__journalRequestHook = async (method: string, run: () => unknown) => { if (method === 'fileRoots' || method === 'listDirectory') await g.__gate; return run(); };
    });
    await pressKey(app, ...tabKey(2));
    await app.evaluate(() => { (globalThis as any).__release(); (globalThis as any).__journalRequestHook = undefined; });
    await expect(page.locator('.inspector-panel [role=treeitem]').first()).toBeFocused();

    // With Changed chosen (the view a session with changes opens on), the key focuses the view choice.
    const view = page.getByRole('radiogroup', { name: 'Files view' });
    await tabTo(page, view.getByRole('radio', { checked: true }), { back: true });
    await page.keyboard.press('ArrowLeft');
    const changed = view.getByRole('radio', { name: /^Changed/ });
    await expect(changed).toBeChecked();
    await pressKey(app, ...focusTerminalKey); await expect(xterm).toBeFocused();
    await pressKey(app, ...tabKey(2));
    await expect(changed).toBeFocused(); await expectVisibleFocus(page);
  } finally { await closeApp(app); f.cleanup(); }
});
