import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chooseAgent, chooseMode, contextPreview, inspectContext, inspectorTab, startButton, taskBox } from './support/ui';
import { fixtureEnv } from './support/env';

// The New session composer (Phase 4, boards B5 and B13) with fixture agents:
// Claude and Codex are fake CLIs on PATH, Cursor is not installed. Nothing
// here signs in or talks to a provider.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs');

const NOTE = 'Worktree removal refuses locked worktrees and keeps the branch';
const BRIEF = 'COMPOSER_BRIEF: a fixture project for the composer.';

function setup() {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'composer-')); const project = resolve(root, 'composer project'); const bin = resolve(root, 'bin'); const home = resolve(root, 'home');
  for (const dir of [project, bin, home]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# Composer fixture\n'); git('add', '.'); git('commit', '-qm', 'init');
  const ledger = resolve(root, 'launches.jsonl');
  const fixture = `#!${process.execPath}
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
require('node:fs').appendFileSync(${JSON.stringify(ledger)},JSON.stringify({bin:require('node:path').basename(process.argv[1]),argv:process.argv.slice(2)})+'\\n');
console.log('PTY_READY '+JSON.stringify(process.argv.slice(2,4)));process.stdin.setRawMode(true);process.stdin.resume();`;
  for (const p of ['claude', 'codex']) { writeFileSync(resolve(bin, p), fixture); chmodSync(resolve(bin, p), 0o755); }
  // No Cursor CLI: fixtureEnv (tests/support/env.ts) puts only the fixtures and a few tools on PATH, and HOME is empty.
  const env = fixtureEnv({ root, bin, home, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, project, env, launches, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function open(f: ReturnType<typeof setup>) {
  const app = await electron.launch({ args: ['.'], env: f.env });
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, f.project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
  await expect(taskBox(page)).toBeVisible();
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => { await app.close().catch(() => {}); };

// Remembers notes through the store (the same requests the Memory tab sends).
async function remember(page: Page, notes: { statement: string; category?: string; scope?: string }[]) {
  return page.evaluate(async items => {
    const journal = (window as any).journal; const projectId = (await journal.request('projects'))[0].id; const ids: string[] = [];
    for (const { statement, category = 'constraint', scope = 'checkout' } of items) {
      const memory = await journal.request('proposeMemory', { projectId, input: { statement, category, scope, area: '', source: { kind: 'user', note: 'Fixture' } } });
      await journal.request('setMemoryStatus', { id: memory.id, status: 'active' }); ids.push(memory.id);
    }
    return ids;
  }, notes);
}
const receiptCount = (page: Page) => page.evaluate(async () => {
  const journal = (window as any).journal; const projectId = (await journal.request('projects'))[0].id;
  return (await journal.request('project', { projectId })).receipts.length;
});
const relevant = (page: Page) => contextPreview(page).getByRole('region', { name: 'Relevant to your task' });

test('typing updates the preview without storing receipts', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await remember(page, [{ statement: NOTE }]);
    const before = await receiptCount(page);
    await taskBox(page).fill('worktree removal');
    await expect(relevant(page)).toContainText(NOTE, { timeout: 2000 });
    await expect(contextPreview(page).getByRole('meter', { name: 'Notes' })).toBeVisible();
    await expect(contextPreview(page)).toContainText('Notes');
    expect(await receiptCount(page)).toBe(before);
    // About a second later the full check has validated the sources, still without storing anything.
    await expect(contextPreview(page).getByText('Sources checked', { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(contextPreview(page).getByRole('meter', { name: 'Notes' })).toHaveAttribute('aria-valuenow', '1');
    expect(await receiptCount(page)).toBe(before);
  } finally { await closeApp(app); f.cleanup(); }
});

test('matched words are underlined and the hover card leaves a note out', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await remember(page, [{ statement: NOTE }]);
    await taskBox(page).fill('worktree removal');
    const mark = page.locator('.task-mirror mark', { hasText: /^worktree$/ });
    await expect(mark).toHaveText('worktree');
    // The card is closed until the pointer rests on an underline.
    await expect(page.getByRole('dialog', { name: /Notes matching/ })).toHaveCount(0);
    const box = (await mark.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const card = page.getByRole('dialog', { name: 'Notes matching “worktree”' });
    await expect(card).toContainText(NOTE);
    // NoteCard's Leave out (Phase 5): its name is "Leave out"; the inspector's preview keeps "Leave out for this task".
    await card.getByRole('button', { name: 'Leave out', exact: true }).click();
    await expect(relevant(page)).not.toContainText(NOTE);
    await expect(contextPreview(page)).toContainText('1 left out by you');
    await contextPreview(page).getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(relevant(page)).toContainText(NOTE);
    await expect(contextPreview(page)).not.toContainText('left out by you');
  } finally { await closeApp(app); f.cleanup(); }
});

test('a hover card closes when the task box scrolls; Cmd/Ctrl+Enter in the card starts nothing', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await remember(page, [{ statement: NOTE }]);
    const long = Array.from({ length: 12 }, (_, i) => `line ${i} keeps going long enough to wrap inside the task box`).join('\n') + '\nworktree removal';
    await taskBox(page).fill(long);
    const mark = page.locator('.task-mirror mark', { hasText: /^worktree$/ });
    await expect(mark).toHaveCount(1);
    await page.evaluate(() => { const area = document.querySelector<HTMLTextAreaElement>('#task')!; area.scrollTop = area.scrollHeight; });
    await expect(mark).toBeInViewport();
    const box = (await mark.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const card = page.getByRole('dialog', { name: 'Notes matching “worktree”' });
    await expect(card).toBeVisible();
    // The word moves away under the card: the card closes.
    await page.evaluate(() => { const area = document.querySelector<HTMLTextAreaElement>('#task')!; area.scrollTop = 0; });
    await expect(card).toHaveCount(0);
    // Opened from the button, the card holds focus; the start shortcut does nothing there.
    await page.mouse.move(0, 0);
    await page.getByRole('button', { name: '1 note matches', exact: true }).click();
    const fromButton = page.getByRole('dialog', { name: 'Notes matching your task' });
    await expect(fromButton).toBeFocused();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(fromButton).toBeVisible();
    await expect(taskBox(page)).toBeVisible();
    expect(f.launches()).toHaveLength(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('underlines stay aligned through wrapping, scrolling and right-to-left text', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await remember(page, [{ statement: NOTE }]);
    // Twelve wrapped lines: past eight rows the box scrolls, and the mirror scrolls with it.
    const long = Array.from({ length: 12 }, (_, i) => `line ${i} keeps going long enough to wrap inside the task box`).join('\n') + '\nworktree removal';
    await taskBox(page).fill(long);
    await expect(page.locator('.task-mirror mark', { hasText: /^worktree$/ })).toHaveCount(1);
    const metrics = () => page.evaluate(() => {
      const area = document.querySelector<HTMLTextAreaElement>('#task')!; const mirror = document.querySelector<HTMLElement>('.task-mirror')!;
      return { width: [area.clientWidth, mirror.clientWidth], height: [area.scrollHeight, mirror.scrollHeight], top: [area.scrollTop, mirror.scrollTop], scrolls: area.scrollHeight > area.clientHeight };
    });
    await page.evaluate(() => { const area = document.querySelector<HTMLTextAreaElement>('#task')!; area.scrollTop = area.scrollHeight; area.dispatchEvent(new Event('scroll')); });
    await expect.poll(async () => { const m = await metrics(); return m.top[0] > 0 && m.top[0] === m.top[1]; }).toBe(true);
    const m = await metrics();
    expect(m.scrolls).toBe(true); expect(m.width[0]).toBe(m.width[1]); expect(m.height[0]).toBe(m.height[1]);
    // The underline sits inside the visible box after scrolling.
    const box = (await taskBox(page).boundingBox())!; const mark = (await page.locator('.task-mirror mark', { hasText: /^worktree$/ }).boundingBox())!;
    expect(mark.y).toBeGreaterThanOrEqual(box.y); expect(mark.y + mark.height).toBeLessThanOrEqual(box.y + box.height);
    // Right-to-left text: the mirror takes the same direction as the textarea, and each underline
    // sits on its own characters. A click on a mark's left and right edges (and centre) puts the
    // textarea's caret inside that word, for the right-to-left word and the left-to-right one.
    await remember(page, [{ statement: 'The \u05e9\u05dc\u05d5\u05dd banner greets returning users' }]);
    const task = '\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd worktree';
    await taskBox(page).fill(task);
    await expect.poll(() => page.evaluate(() => [getComputedStyle(document.querySelector('#task')!).direction, getComputedStyle(document.querySelector('.task-mirror')!).direction])).toEqual(['rtl', 'rtl']);
    for (const word of ['\u05e9\u05dc\u05d5\u05dd', 'worktree']) {
      const mark = page.locator('.task-mirror mark', { hasText: new RegExp(`^${word}$`) });
      await expect(mark).toHaveCount(1);
      const rect = (await mark.boundingBox())!; const start = task.indexOf(word); const end = start + word.length;
      for (const x of [rect.x + 2, rect.x + rect.width / 2, rect.x + rect.width - 2]) {
        await page.mouse.click(x, rect.y + rect.height / 2);
        const caret = await taskBox(page).evaluate(el => (el as HTMLTextAreaElement).selectionStart);
        expect(caret, `${word} at x=${Math.round(x - rect.x)} of ${Math.round(rect.width)}`).toBeGreaterThanOrEqual(start);
        expect(caret, `${word} at x=${Math.round(x - rect.x)} of ${Math.round(rect.width)}`).toBeLessThanOrEqual(end);
      }
    }
  } finally { await closeApp(app); f.cleanup(); }
});

test('N notes match is keyboard reachable', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await remember(page, [{ statement: NOTE }]);
    await taskBox(page).fill('worktree removal');
    const matches = page.getByRole('button', { name: '1 note matches', exact: true });
    await expect(matches).toBeVisible();
    await expect(taskBox(page)).toHaveAttribute('aria-describedby', 'task-hint task-matches');
    await taskBox(page).focus(); await page.keyboard.press('Tab');
    await expect(matches).toBeFocused();
    await page.keyboard.press('Enter');
    const card = page.getByRole('dialog', { name: 'Notes matching your task' });
    await expect(card).toContainText(NOTE);
    await expect(matches).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(matches).toBeFocused();
    // Leaving out the only match from the keyboard closes the card and returns focus to the task box.
    await page.keyboard.press('Enter'); await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Leave out', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(card).toHaveCount(0);
    await expect(taskBox(page)).toBeFocused();
  } finally { await closeApp(app); f.cleanup(); }
});

test('Codex keeps Plan selected but blocks Start', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await chooseAgent(page, 'claude'); await chooseMode(page, 'plan');
    await expect(page.locator('#mode-help')).toHaveText(/Claude plan mode/);
    await chooseAgent(page, 'codex');
    const plan = page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'Plan', exact: true });
    await expect(plan).toHaveAttribute('aria-checked', 'true');
    await expect(plan).toHaveAttribute('aria-disabled', 'true');
    await expect(startButton(page)).toHaveText(/^Start Codex/);
    await expect(startButton(page)).toBeDisabled();
    await expect(page.getByRole('status').filter({ hasText: 'Codex has no plan mode' })).toBeVisible();
    // An unsupported mode cannot be chosen again by click; Read-only can.
    await chooseMode(page, 'read-only');
    await expect(plan).toHaveAttribute('aria-checked', 'false');
    await expect(startButton(page)).toBeEnabled();
    await startButton(page).click();
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY ["--sandbox","read-only"]');
  } finally { await closeApp(app); f.cleanup(); }
});

test('Cmd/Ctrl+Enter starts from the task box', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await chooseAgent(page, 'claude'); await chooseMode(page, 'build');
    await expect(startButton(page)).toHaveAttribute('aria-keyshortcuts', process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await taskBox(page).fill('KEYBOARD_START_TASK');
    // The shortcut obeys the same rules as the button (it waits while opening the project finishes).
    await expect(startButton(page)).toBeEnabled();
    await taskBox(page).press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY');
    const query = await page.evaluate(async () => {
      const journal = (window as any).journal; const live = (await journal.request('sessions')).live[0];
      return (await journal.request('getReceipt', { id: live.receiptId })).query;
    });
    expect(query).toBe('KEYBOARD_START_TASK');
    expect(f.launches()).toHaveLength(1);
  } finally { await closeApp(app); f.cleanup(); }
});

test('Backspace on a focused preview note leaves it out', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await remember(page, [{ statement: NOTE }, { statement: 'Worktree names follow the journal/ prefix', category: 'convention' }]);
    await taskBox(page).fill('worktree');
    const rows = relevant(page).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await rows.first().focus(); await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    const second = (await rows.nth(1).textContent())!;
    await page.keyboard.press('Backspace');
    await expect(rows).toHaveCount(1);
    await expect(relevant(page)).not.toContainText(second.includes('prefix') ? 'prefix' : 'keeps the branch');
    await expect(contextPreview(page)).toContainText('1 left out by you');
    // Focus moves to the remaining note, so the next Backspace keeps working; after the last
    // one, focus stays in the preview instead of falling to the page.
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(contextPreview(page)).toContainText('2 left out by you');
    await expect(contextPreview(page)).toBeFocused();
  } finally { await closeApp(app); f.cleanup(); }
});

test('Tab passes each preview list in at most two stops', async () => {
  // One tab stop per list (roving rows) plus the active row's Leave out: from Start, Tab reaches
  // the brief's row and button, the first relevant row and its button, then Inspect all, however
  // many notes match. Inactive rows' buttons are out of the Tab order, yet Delete still works.
  const f = setup(); const { app, page } = await open(f);
  try {
    await remember(page, [{ statement: BRIEF, category: 'brief' }, { statement: NOTE }, { statement: 'Worktree names follow the journal/ prefix', category: 'convention' }, { statement: 'Worktree folders live under .worktrees', category: 'decision' }]);
    await taskBox(page).fill('worktree');
    const rows = relevant(page).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1).getByRole('button', { name: /Leave out/ })).toHaveAttribute('tabindex', '-1');
    await expect(rows.first().getByRole('button', { name: /Leave out/ })).not.toHaveAttribute('tabindex', '-1');
    const inspect = contextPreview(page).getByRole('button', { name: 'Inspect all', exact: true });
    await startButton(page).focus();
    let presses = 0;
    while (presses < 20 && !(await inspect.evaluate(el => el === document.activeElement))) { await page.keyboard.press('Tab'); presses++; }
    expect(presses).toBe(5);
    // Arrows move the active row; its button joins the Tab order and the previous one leaves it.
    await rows.first().focus(); await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    await expect(rows.nth(1).getByRole('button', { name: /Leave out/ })).not.toHaveAttribute('tabindex', '-1');
    await expect(rows.first().getByRole('button', { name: /Leave out/ })).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('Delete');
    await expect(rows).toHaveCount(2);
    await expect(contextPreview(page)).toContainText('1 left out by you');
  } finally { await closeApp(app); f.cleanup(); }
});

test('agent cards are honest', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    const cards = page.getByRole('radiogroup', { name: 'Agent' });
    await expect(cards.getByRole('radio', { name: 'Claude Code', exact: true })).toContainText('Installed · 1.0');
    await expect(cards.getByRole('radio', { name: 'Codex', exact: true })).toContainText('Installed · 1.0');
    await expect(cards).not.toContainText('Signed in');
    const cursor = cards.getByRole('radio', { name: 'Cursor', exact: true });
    await expect(cursor).toContainText('Not installed');
    await expect(cards.getByRole('button', { name: 'Install Cursor…', exact: true })).toBeVisible();
    // Unavailable agents stay selectable, and Start says why it waits.
    await chooseAgent(page, 'cursor');
    await expect(startButton(page)).toBeDisabled();
    await expect(page.getByRole('status').filter({ hasText: 'Cursor isn’t installed on this computer. Choose Install… on its card.' })).toBeVisible();
    // Arrow keys move the choice (roving tabIndex).
    await cursor.focus(); await page.keyboard.press('Home');
    await expect(cards.getByRole('radio', { name: 'Claude Code', exact: true })).toBeFocused();
    await expect(cards.getByRole('radio', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-checked', 'true');
  } finally { await closeApp(app); f.cleanup(); }
});

test('a start refused for a missing agent checks that agent again', async () => {
  // The Cursor CLI disappears after detection: the start fails with PROVIDER_MISSING, Journal
  // asks main for a fresh check (instead of marking the card by hand) and the reason beside
  // Start keeps saying what to do.
  const f = setup();
  const cursorCli = `#!${process.execPath}
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('2026.10.01-e373342');process.exit(0)}
if(a[0]==='--help'){console.log('Start the Cursor Agent\\n  --resume [chatId]\\n  --mode <mode>\\n  login\\n  create-chat');process.exit(0)}
if(a[0]==='status'){console.log(a.includes('--format')?JSON.stringify({authenticated:true}):'Logged in');process.exit(0)}
process.exit(1)`;
  const agent = resolve(f.root, 'bin', 'agent'); writeFileSync(agent, cursorCli); chmodSync(agent, 0o755);
  const { app, page } = await open(f);
  try {
    // Headless runs look for Cursor only when a spec allows Cursor's probes: allow them, then check.
    await app.evaluate(() => { (globalThis as any).__journalAuthProbes = ['cursor']; });
    await page.evaluate(() => (window as any).journal.request('providerStatus', { provider: 'cursor', fresh: true }));
    const cursor = page.getByRole('radiogroup', { name: 'Agent' }).getByRole('radio', { name: 'Cursor', exact: true });
    await expect(cursor).toContainText('Signed in');
    await chooseAgent(page, 'cursor');
    rmSync(agent);
    await startButton(page).click();
    await expect(cursor).toContainText('Not installed');
    const reason = page.getByRole('form', { name: 'Start a session' }).locator('.start-reason');
    await expect(reason).toHaveText('Cursor isn’t installed on this computer. Choose Install… on its card.');
    await expect(startButton(page)).toBeDisabled();
    // Phase 8: the refused start is explained above Start (StartError), never in the app's error banner.
    await expect(page.locator('.start-error')).toContainText('Cursor isn’t installed');
    await expect(page.locator('.error-banner')).toHaveCount(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('the empty Relevant state shows the first-session copy', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await remember(page, [{ statement: BRIEF, category: 'brief' }]);
    await taskBox(page).fill('anything at all');
    await expect(contextPreview(page).getByRole('region', { name: 'Every session knows' })).toContainText('COMPOSER_BRIEF');
    await expect(relevant(page)).toContainText('Nothing here yet.');
  } finally { await closeApp(app); f.cleanup(); }
});

test('Relevant asks for a task while the task box is empty', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await remember(page, [{ statement: NOTE }]);
    await taskBox(page).fill('worktree');
    await expect(relevant(page)).toContainText(NOTE);
    await taskBox(page).fill('');
    await expect(relevant(page)).toContainText('Type a task to see matching notes.');
    await taskBox(page).fill('nothing relevant here');
    await expect(relevant(page)).toContainText('No remembered note matches this task yet.');
  } finally { await closeApp(app); f.cleanup(); }
});

test('Inspect all shows the checked packet in the Session tab', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    const [id] = await remember(page, [{ statement: NOTE }]);
    await taskBox(page).fill('worktree removal');
    await inspectContext(page);
    await expect(page.getByRole('tab', { name: /^Session/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('context-packet')).toContainText(id);
    // A leave-out in the composer reaches the inspector's preview too: one state.
    await relevant(page).getByRole('button', { name: 'Leave out', exact: true }).click();
    await expect(page.getByTestId('context-packet')).not.toContainText(id);
    await inspectorTab(page, 'Session');
  } finally { await closeApp(app); f.cleanup(); }
});

test('preview errors stay in the preview', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await taskBox(page).fill('use password=hunter22 for the fixture');
    await expect(contextPreview(page).getByRole('status')).toContainText('Preview unavailable:');
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Fixing the task clears it.
    await taskBox(page).fill('use the fixture');
    // The live region stays (so the next error is announced); only its text goes.
    await expect(contextPreview(page).getByRole('status')).toHaveText('');
    await expect(contextPreview(page).getByRole('status')).toHaveCount(1);
  } finally { await closeApp(app); f.cleanup(); }
});

test('the composer fits a 900×640 window and every control is reachable by keyboard', async () => {
  const f = setup(); const { app, page } = await open(f);
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 640));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(900);
    // No horizontal overflow; the main column scrolls vertically.
    expect(await page.evaluate(() => { const view = document.querySelector('.new-session-view')!; return view.scrollWidth <= view.clientWidth; })).toBe(true);
    await expect(startButton(page)).toBeEnabled();
    await taskBox(page).focus();
    const reached = new Set<string>();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      reached.add(await page.evaluate(() => { const el = document.activeElement as HTMLElement; return el.getAttribute('aria-label') || el.textContent?.trim() || el.id; }));
    }
    const order = [...reached].join(' | ');
    for (const pattern of [/^Claude Code$/, /^Build$/, /^Workspace$/, /^Manage workspaces$/, /^Start Claude Code/]) expect([...reached].some(entry => pattern.test(entry)), `${pattern} in ${order}`).toBe(true);
    await startButton(page).scrollIntoViewIfNeeded();
    await expect(startButton(page)).toBeInViewport();
  } finally { await closeApp(app); f.cleanup(); }
});

// The composer's geometry in the main column: the form keeps a usable width or
// the preview stacks under it, nothing overlaps, no text column collapses and
// nothing scrolls sideways. Measured in the page, so a failure names the cause.
async function composerGeometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
    const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const form = rect('.composer-form'), header = rect('.new-session-header'), preview = rect('.context-preview');
    // Text that wraps (not a single-line truncated label) needs room for words.
    const squeezed: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.new-session-inner *')) {
      const own = [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join('').trim();
      if (own.length < 12) continue;
      const style = getComputedStyle(el); const r = el.getBoundingClientRect();
      if (style.whiteSpace === 'nowrap' || r.width === 0) continue;
      if (r.width < 120) squeezed.push(`${el.tagName.toLowerCase()}.${el.className} ${Math.round(r.width)}px "${own.slice(0, 30)}"`);
    }
    const view = document.querySelector('.new-session-view')!; const main = document.querySelector('main.workspace')!;
    return { main: Math.round(main.getBoundingClientRect().width), form: Math.round(form.width), stacked: preview.top >= form.bottom - 0.5,
      overlap: overlaps(form, preview) || overlaps(header, preview), squeezed,
      overflow: view.scrollWidth > view.clientWidth || main.scrollWidth > main.clientWidth };
  });
}
async function expectSaneComposer(page: Page, label: string) {
  const g = await composerGeometry(page);
  expect(g.form >= 420 || g.stacked, `${label}: form ${g.form}px beside the preview in a ${g.main}px column`).toBe(true);
  expect(g.overlap, `${label}: the preview overlaps the form or header`).toBe(false);
  expect(g.squeezed, `${label}: text squeezed into a narrow column`).toEqual([]);
  expect(g.overflow, `${label}: horizontal overflow`).toBe(false);
  return g;
}
const sizeWindow = async (app: ElectronApplication, page: Page, width: number, height: number) => {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
};

// After a reload the app may reopen the shown project on its own, replacing Welcome while a click
// is on its way: open the project only while Welcome is still there, until the composer shows.
const openAfterReload = (page: Page) => expect.poll(async () => {
  if (await taskBox(page).isVisible()) return true;
  await page.locator('.welcome-primary').click({ timeout: 1000 }).catch(() => {});
  return taskBox(page).isVisible();
}, { timeout: 20000 }).toBe(true);

test('the composer lays out sanely with a wide stored inspector and sidebar (regression)', async () => {
  const f = setup();
  execFileSync('git', ['-C', f.project, 'checkout', '-qb', 'feat/editor-core-workbench-chat-f141044']);
  const app = await electron.launch({ args: ['.'], env: f.env });
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, f.project);
  const page = await app.firstWindow();
  try {
    await sizeWindow(app, page, 1440, 900);
    // The user's layout: a 340 px sidebar and a 525 px inspector, stored by earlier drags.
    await page.evaluate(() => localStorage.setItem('journal-panel-widths', JSON.stringify({ project: 340, knowledge: 525 })));
    await page.reload(); await openAfterReload(page);
    await expect(page.locator('.knowledge-panel')).toBeVisible();
    const g = await expectSaneComposer(page, '1440 with stored widths');
    expect(g.main).toBeLessThan(760);
    // The checkout line truncates on one line and keeps the full text in a tooltip.
    const line = page.locator('.new-session-header p');
    await expect(line).toHaveAttribute('title', /feat\/editor-core-workbench-chat-f141044/);
    expect(await line.evaluate(el => { const s = getComputedStyle(el); return [s.whiteSpace, s.textOverflow]; })).toEqual(['nowrap', 'ellipsis']);
    // The defaults at 1440, 1024 and 900×640.
    await page.evaluate(() => localStorage.removeItem('journal-panel-widths'));
    await page.reload(); await openAfterReload(page);
    await expectSaneComposer(page, '1440 default');
    await sizeWindow(app, page, 1024, 768);
    await expectSaneComposer(page, '1024 default');
    await sizeWindow(app, page, 900, 640);
    await expectSaneComposer(page, '900×640 default');
  } finally { await closeApp(app); f.cleanup(); }
});
