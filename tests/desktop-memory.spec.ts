import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureWide, inspectorTab, newSession, openAnotherProject, sessionStatus, startSession, switchProject } from './support/ui';

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
  await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
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
// A focus within 5 s of the last finished scan is ignored (a focus storm): keep focusing until the count follows.
const focusUntil = (page: Page, label: string, text: string) => expect(async () => {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(toggle(page, label)).toHaveText(text, { timeout: 1000 });
}).toPass({ timeout: 20_000 });
// Samples the Check needed toggle for `ms`, so a count that only flickers is caught.
const sampleCount = (page: Page, ms: number) => page.evaluate(async span => {
  const seen = new Set<string>(); const end = performance.now() + span;
  while (performance.now() < end) { const node = [...document.querySelectorAll('.attention-toggle')].find(element => element.textContent?.startsWith('Check needed')); if (node) seen.add(node.textContent ?? ''); await new Promise(resolve => setTimeout(resolve, 20)); }
  return [...seen];
}, ms);
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
    await focusUntil(page, 'Check needed', 'Check needed 1');
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
    await startSession(page, 'claude', { task: 'rule: Integration tests always need Docker running' });
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
    // The origin link opens its session, from the keyboard: Tab reaches it with a focus ring, and Enter opens it.
    await newSession(page);
    const link = rule.getByRole('button', { name: /^You remembered this today, from the session/ });
    await page.getByLabel('Search project memory').focus();
    await expect(async () => {
      await page.keyboard.press('Tab');
      expect(await link.evaluate(element => element === document.activeElement)).toBe(true);
    }).toPass({ timeout: 20_000, intervals: [0] });
    expect(await link.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none')).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.locator('.session-header')).toContainText('Integration tests always need Docker running');
    // A second session gets both notes: each was sent to one conversation (the first launched before the rule existed).
    await startSession(page, 'claude', { task: 'Fix the docker integration tests' });
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

test('Check needed: scans never overlap across remounts; counts follow the project and current notes; filters reset per project', async () => {
  test.setTimeout(180_000);
  test.skip(process.platform === 'win32', 'POSIX provider fixture; native Windows is verified separately');
  const { app, page, root, project, close } = await launch('checks a');
  try {
    await inspectorTab(page, 'Memory');
    await remember(page, 'Docker containers need cleanup after integration runs', 'lesson', [1, 2]);
    await remember(page, 'The first line names the container tool', 'lesson', [1, 1]);
    // Forget the second note: it moves to History and is no longer counted.
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 0 }); });
    await cardFor(page, 'The first line names').getByRole('button', { name: 'Forget…', exact: true }).click();
    await expect(cardFor(page, 'The first line names')).toHaveCount(0);
    writeFileSync(resolve(project, 'tests.md'), 'Integration tests start Podman containers.\nClean them up after each run.\n');
    await focusUntil(page, 'Check needed', 'Check needed 1');

    // Spy on memoryChecks in main: count calls and the most in flight at once, each slowed to 250 ms.
    await app.evaluate(() => {
      const spy = { calls: 0, inFlight: 0, max: 0 }; (globalThis as any).__checksSpy = spy;
      (globalThis as any).__journalRequestHook = async (action: string, run: () => Promise<unknown>) => {
        if (action !== 'memoryChecks') return run();
        spy.calls++; spy.inFlight++; spy.max = Math.max(spy.max, spy.inFlight);
        try { await new Promise(resolve => setTimeout(resolve, 250)); return await run(); } finally { spy.inFlight--; }
      };
    });
    const spy = () => app.evaluate(() => ({ ...(globalThis as any).__checksSpy }) as { calls: number; inFlight: number; max: number });

    // History lists the forgotten note (its file changed too); the count stays at the current notes.
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(cardFor(page, 'The first line names')).toBeVisible();
    await expect(cardFor(page, 'The first line names').locator('.note-evidence')).toHaveText('Check needed · file changed');
    await inspectorTab(page, 'Session'); await inspectorTab(page, 'Memory');
    expect(await sampleCount(page, 1500)).toEqual(['Check needed 1']);
    // The filters were kept across the tab switch.
    await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await spy()).inFlight).toBe(0);

    // Many notes: a full scan takes 3 chunks. Switching tabs quickly never runs two scans at once,
    // and a scan cancelled by an unmount stops after its chunk.
    await page.evaluate(async () => {
      const journal = (window as any).journal; const projectId = (await journal.request('projects'))[0].id;
      for (let index = 0; index < 110; index++) {
        const memory = await journal.request('proposeMemory', { projectId, input: { statement: `Fixture convention number ${index}`, category: 'convention', scope: 'checkout', area: '', source: { kind: 'user', note: 'Fixture' } } });
        await journal.request('setMemoryStatus', { id: memory.id, status: 'active' });
      }
    });
    await inspectorTab(page, 'Session');
    await expect.poll(async () => (await spy()).inFlight, { timeout: 20_000 }).toBe(0);
    await page.waitForTimeout(500);
    const before = (await spy()).calls;
    for (let round = 0; round < 5; round++) { await inspectorTab(page, 'Memory'); await inspectorTab(page, 'Session'); }
    await inspectorTab(page, 'Memory');
    await expect(toggle(page, 'Check needed')).toHaveText('Check needed 1');
    await expect.poll(async () => (await spy()).inFlight, { timeout: 20_000 }).toBe(0);
    await page.waitForTimeout(600);
    const after = await spy();
    expect(after.max).toBe(1);
    // Six mounts: at most one chunk for each cancelled scan, plus the last full scan (3 chunks).
    expect(after.calls - before).toBeGreaterThanOrEqual(3);
    expect(after.calls - before).toBeLessThanOrEqual(5 + 3);
    await app.evaluate(() => { delete (globalThis as any).__journalRequestHook; });

    // Filters: Check needed on in project A.
    await page.getByRole('button', { name: 'Current', exact: true }).click();
    await toggle(page, 'Check needed').click();
    await expect(toggle(page, 'Check needed')).toHaveAttribute('aria-pressed', 'true');
    // Project B has no notes: its count never takes A's page, and its filters start from the defaults.
    const other = resolve(root, 'checks b'); mkdirSync(other);
    execFileSync('git', ['-C', other, 'init', '-b', 'main'], { stdio: 'pipe' });
    execFileSync('git', ['-C', other, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' });
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, other);
    await openAnotherProject(app, page);
    await expect(page.locator('.project-switcher .project-name')).toHaveText(/^checks b/);
    await expect(toggle(page, 'Check needed')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'Current', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle(page, 'Check needed')).toHaveText('Check needed 0');
    expect(await sampleCount(page, 800)).toEqual(['Check needed 0']);
    // Back to A with the Memory tab closed during the switch: A's filters do not come back.
    await inspectorTab(page, 'Session');
    await switchProject(app, page, 'checks a');
    await inspectorTab(page, 'Memory');
    await expect(toggle(page, 'Check needed')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'Current', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle(page, 'Check needed')).toHaveText('Check needed 1');
  } finally { await close(); }
});
