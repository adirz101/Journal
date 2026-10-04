import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureWide, inspectorTab, newSession, sessionStatus } from './support/ui';

// Phase 5 (memory trust): note cards show where a note came from, whether its file
// still matches and how many conversations it was sent to; the Memory tab filters by
// category, Check needed and Other branches. Fixture provider, hidden windows.

const fixture = `#!${process.execPath}
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
console.log('PTY_READY '+process.stdout.isTTY);
process.stdin.setRawMode(true);process.stdin.resume();`;

async function launch(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'memory-')); const project = resolve(root, name); const bin = resolve(root, 'bin');
  mkdirSync(project); mkdirSync(bin);
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); writeFileSync(resolve(project, 'tests.md'), 'Integration tests start Docker containers.\nClean them up after each run.\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env });
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
  const page = await app.firstWindow();
  await ensureWide(app, page);
  await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  return { app, page, root, project, git, close: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}

// Adds a note through the form and remembers it. file: a tests.md line range as its source.
async function remember(page: Page, statement: string, category: string, file?: [number, number]) {
  await page.getByRole('button', { name: 'Add a note' }).first().click();
  const form = page.getByRole('dialog');
  await form.getByRole('textbox', { name: 'Statement', exact: true }).fill(statement);
  await form.getByLabel('Category').selectOption(category);
  if (file) { await form.getByLabel('Source type').selectOption('file'); await form.getByLabel('Source path').fill('tests.md'); await form.getByLabel('Start line').fill(String(file[0])); await form.getByLabel('End line').fill(String(file[1])); }
  else await form.getByLabel('Why (your words)').fill('Agreed in review');
  await form.getByRole('button', { name: 'Save for review' }).click();
  await expect(form).toHaveCount(0);
  const card = cardFor(page, statement);
  await card.getByRole('button', { name: 'Remember', exact: true }).click();
  await expect(card.locator('.memory-state')).toHaveText('Remembered');
}
const cardFor = (page: Page, statement: string) => page.locator('.note-card').filter({ hasText: statement });
const chips = (page: Page) => page.getByRole('group', { name: 'Category' });
const chip = (page: Page, label: string) => chips(page).getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
const toggle = (page: Page, label: string) => page.getByRole('button', { name: new RegExp(`^${label} `) });
const today = () => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());
const color = (page: Page, name: string) => page.evaluate(token => { const probe = document.createElement('span'); probe.style.color = `var(${token})`; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; }, name);

test('category chips count and filter; Check needed finds a changed file; keyboard reaches every control', async () => {
  test.setTimeout(120_000);
  test.skip(process.platform === 'win32', 'POSIX provider fixture; native Windows is verified separately');
  const { page, project, close } = await launch('memory filters');
  try {
    await inspectorTab(page, 'Memory');
    await remember(page, 'Use SQLite for local storage', 'decision');
    await remember(page, 'Docker containers need cleanup after integration runs', 'lesson', [1, 2]);
    await remember(page, 'Rebuild node-pty after npm ci', 'lesson');
    await remember(page, 'Never force push to main', 'constraint');
    // Chips count every category; Lessons lists two cards.
    await expect(chip(page, 'All')).toHaveText('All 4');
    await expect(chip(page, 'Lessons')).toHaveText('Lessons 2');
    await expect(chip(page, 'Rules')).toHaveText('Rules 1');
    await expect(chip(page, 'Conventions')).toHaveCount(0);
    await chip(page, 'Lessons').click();
    await expect(chip(page, 'Lessons')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.memory-list .note-card')).toHaveCount(2);
    // Searching updates the counts; a chip at zero is hidden unless it is selected.
    await page.getByLabel('Search project memory').fill('docker');
    await expect(chip(page, 'All')).toHaveText('All 1');
    await expect(chip(page, 'Lessons')).toHaveText('Lessons 1');
    await expect(chip(page, 'Decisions')).toHaveCount(0);
    await page.getByLabel('Search project memory').fill('');
    await chip(page, 'All').click();
    await expect(page.locator('.memory-list .note-card')).toHaveCount(4);
    // Trust lines: a manual note and its file.
    const fileCard = cardFor(page, 'Docker containers need cleanup');
    await expect(fileCard).toContainText(`You added this on ${today()}`);
    await expect(fileCard).toContainText('Based on tests.md:1–2 · file unchanged since you saved it');
    await expect(fileCard).toContainText('Not sent yet');
    await expect(toggle(page, 'Check needed')).toHaveText('Check needed 0');
    // The file changes outside Journal; focusing the window checks again.
    writeFileSync(resolve(project, 'tests.md'), 'Integration tests start Podman containers.\nClean them up after each run.\n');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(toggle(page, 'Check needed')).toHaveText('Check needed 1');
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: /need a check|needs a check/ })).toHaveText('1 note needs a check');
    const amber = fileCard.locator('.note-evidence');
    await expect(amber).toHaveText('Check needed · file changed');
    await expect(amber).toHaveAttribute('title', 'tests.md:1–2');
    expect(await amber.evaluate(element => getComputedStyle(element).color)).toBe(await color(page, '--amb'));
    expect(await toggle(page, 'Check needed').evaluate(element => getComputedStyle(element).color)).toBe(await color(page, '--amb'));
    await toggle(page, 'Check needed').click();
    await expect(page.locator('.memory-list .note-card')).toHaveCount(1);
    await expect(page.locator('.memory-list .note-card')).toContainText('Docker containers need cleanup');
    // Filters are kept while switching tabs.
    await inspectorTab(page, 'Session'); await inspectorTab(page, 'Memory');
    await expect(toggle(page, 'Check needed')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.memory-list .note-card')).toHaveCount(1);
    await toggle(page, 'Check needed').click();
    await expect(page.locator('.memory-list .note-card')).toHaveCount(4);

    // Keyboard: Tab reaches the chips, then the status tabs and both toggles, in order; Enter and Space toggle them; each shows a focus ring.
    // Keyboard focus from the search field, so the ring is the keyboard one (:focus-visible).
    await page.getByLabel('Search project memory').focus(); await page.keyboard.press('Tab'); await expect(page.locator(':focus')).toHaveText('＋ Add'); await page.keyboard.press('Tab');
    const order = ['All 4', 'Decisions 1', 'Rules 1', 'Lessons 2', 'Current', 'Needs review 0', 'Remembered', 'History', 'Check needed 1', 'Other branches 0'];
    for (const [index, name] of order.entries()) {
      if (index) await page.keyboard.press('Tab');
      const focused = page.locator(':focus');
      await expect(focused).toHaveText(name);
      expect(await focused.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none')).toBe(true);
    }
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter');
    await expect(toggle(page, 'Check needed')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Space');
    await expect(toggle(page, 'Check needed')).toHaveAttribute('aria-pressed', 'false');
    await chip(page, 'Rules').focus(); await page.keyboard.press('Space');
    await expect(chip(page, 'Rules')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.memory-list .note-card')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(chip(page, 'Rules')).toHaveAttribute('aria-pressed', 'true');
    await chip(page, 'All').focus(); await page.keyboard.press('Enter');
    await expect(chip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  } finally { await close(); }
});

test('Other branches lists notes of another branch without Revise or Remember', async () => {
  test.setTimeout(90_000);
  test.skip(process.platform === 'win32', 'POSIX provider fixture; native Windows is verified separately');
  const { page, git, close } = await launch('memory branches');
  try {
    await inspectorTab(page, 'Memory');
    // Journal notices a branch switch made outside it on focus (or within 3 s); the note form then offers that branch.
    git('switch', '-c', 'feature/x');
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.getByRole('button', { name: 'Add a note' }).first().click();
      const offered = await page.getByRole('dialog').getByLabel('Scope').locator('option', { hasText: 'Only on feature/x' }).count();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(offered).toBe(1);
    }).toPass({ timeout: 15000 });
    await remember(page, 'Feature flags live in config/flags.json', 'decision');
    await expect(cardFor(page, 'Feature flags')).toContainText('⑂ Only on feature/x');
    await expect(toggle(page, 'Other branches')).toHaveText('Other branches 0');
    git('switch', 'main');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(toggle(page, 'Other branches')).toHaveText('Other branches 1');
    await toggle(page, 'Other branches').click();
    const card = cardFor(page, 'Feature flags');
    await expect(page.locator('.memory-list .note-card')).toHaveCount(1);
    await expect(card.getByRole('button', { name: 'Revise', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Remember', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Forget…', exact: true })).toBeVisible();
    await toggle(page, 'Other branches').click();
    await expect(toggle(page, 'Other branches')).toHaveAttribute('aria-pressed', 'false');
  } finally { await close(); }
});

test('a session note says where it came from and how many conversations it was sent to', async () => {
  test.setTimeout(150_000);
  test.skip(process.platform === 'win32', 'POSIX provider fixture; native Windows is verified separately');
  const { page, close } = await launch('memory origins');
  try {
    // A rule stated in a task becomes a suggestion when its session ends.
    await newSession(page); await page.getByLabel('Initial task').fill('rule: Integration tests always need Docker running');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    await inspectorTab(page, 'Memory');
    const suggestion = page.locator('.proposal').filter({ hasText: 'Integration tests always need Docker running' });
    await expect(suggestion).toBeVisible({ timeout: 10000 });
    await suggestion.getByRole('button', { name: 'Add for review', exact: true }).click();
    const rule = cardFor(page, 'Integration tests always need Docker running');
    await expect(rule).toContainText("From the session 'Integration tests always need Docker running' (Claude Code) ›");
    await rule.getByRole('button', { name: 'Remember', exact: true }).click();
    await expect(rule).toContainText("You remembered this today, from the session 'Integration tests always need Docker running' (Claude Code) ›");
    await expect(rule).toContainText('Not sent yet');
    await remember(page, 'Docker cleanup steps are in tests.md', 'lesson', [1, 2]);
    // The origin link opens its session.
    await newSession(page);
    await rule.getByRole('button', { name: /^You remembered this today, from the session/ }).click();
    await expect(page.locator('.session-header')).toContainText('Integration tests always need Docker running');
    // A second session gets both notes: each was sent to one conversation (the first launched before the rule existed).
    await newSession(page); await page.getByLabel('Initial task').fill('Fix the docker integration tests');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY');
    await inspectorTab(page, 'Memory');
    await expect(rule).toContainText('Sent to 1 session');
    await expect(cardFor(page, 'Docker cleanup steps')).toContainText('Sent to 1 session');
    await expect(cardFor(page, 'Docker cleanup steps')).toContainText(`You added this on ${today()}`);
    // The Session tab shows the delivered notes as cards, with freshness at launch.
    await inspectorTab(page, 'Session');
    const delivered = page.locator('.receipt-items .note-card.receipt').filter({ hasText: 'Docker cleanup steps are in tests.md' });
    await expect(delivered).toContainText('Based on tests.md:1–2 · checked when the session started');
    await expect(delivered).toContainText('Sent to 1 session');
    await expect(page.locator('.receipt-items .note-card.receipt').filter({ hasText: 'Integration tests always need Docker running' })).toContainText('You remembered this today, from the session');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
  } finally { await close(); }
});
