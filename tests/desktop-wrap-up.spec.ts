import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectorTab, newSession, showTerminal } from './support/ui';

// Phase 6 Group B: the session wrap-up, one-click Remember, the out-of-date catch, the
// hand-off and the exit-error view. Real Electron, runtime and node-pty with fixture CLIs
// (fixture acceptance only; authenticated native exits are in docs/NATIVE-VALIDATION.md).
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`)); const bin = resolve(root, 'bin'); mkdirSync(bin);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const project = resolve(root, 'wrap project'); mkdirSync(project); mkdirSync(resolve(project, 'src'));
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), 'wrap project\n');
  writeFileSync(resolve(project, 'src/a.js'), 'const graceMs = 3000;\nexport function stop() {}\nexport const other = 1;\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'init');
  // Prints its task; QUICK tasks exit at once. Commands: append <file> <text>, setline <file> <n> <text>,
  // print <text>, exit-with <n>; anything else echoes.
  const fixture = `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
const task=(process.argv.at(-1)||'').split('\\n').at(-1);console.log('TASK '+task);
if(task.startsWith('QUICK')){console.log('DONE '+task);setTimeout(()=>process.exit(0),100)}
else{process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let input='';
process.stdin.on('data',data=>{for(const char of data){
if(char!=='\\r'&&char!=='\\n'){input+=char;continue}
const command=input;input='';const [verb,...rest]=command.split(' ');
if(verb==='append'){fs.appendFileSync(rest[0],rest.slice(1).join(' ')+'\\n');console.log('WROTE '+rest[0])}
else if(verb==='setline'){const lines=fs.readFileSync(rest[0],'utf8').split('\\n');lines[Number(rest[1])-1]=rest.slice(2).join(' ');fs.writeFileSync(rest[0],lines.join('\\n'));console.log('WROTE '+rest[0])}
else if(verb==='print')console.log(rest.join(' '));
else if(verb==='exit-with')process.exit(Number(rest[0]));
else console.log('ECHO '+command);
}})}`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' };
  delete env.ELECTRON_RUN_AS_NODE;
  return { root, project, git, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function open(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  // The window counts as focused, so no real notification is ever posted.
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); (globalThis as any).__journalFocused = () => true; }, project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; }
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(resolveWait => setTimeout(resolveWait, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
const mac = process.platform === 'darwin';
const wrapUp = (page: Page) => page.locator('.wrap-up');
const heading = (page: Page) => page.locator('#wrapup-title');
const keep = (page: Page) => page.locator('.wrap-keep');
const sessionButton = (page: Page, task: string) => page.getByRole('button', { name: new RegExp(`: ${task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`) });

async function start(page: Page, task: string, provider: 'Claude' | 'Codex' = 'Claude') {
  await newSession(page);
  await page.getByLabel('Initial task').fill(task);
  await page.getByRole('button', { name: `Start ${provider}`, exact: true }).click();
  await expect(page.locator('.terminal-surface')).toContainText(`TASK ${task.split('\n').at(-1)}`);
  // Keys typed before the replay finishes are dropped, never queued: wait for an echo.
  await expect(async () => {
    await page.locator('.xterm-helper-textarea').pressSequentially('ready'); await page.locator('.xterm-helper-textarea').press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO ready', { timeout: 2000 });
  }).toPass({ timeout: 20000 });
}
async function type(page: Page, command: string, expected?: string) {
  await page.locator('.xterm-helper-textarea').pressSequentially(command); await page.locator('.xterm-helper-textarea').press('Enter');
  if (expected) await expect(page.locator('.terminal-surface')).toContainText(expected);
}
const request = (page: Page, action: string, input: object = {}) => page.evaluate(([name, value]) => (window as any).journal.request(name, value), [action, input] as const);
const projectId = async (page: Page) => (await request(page, 'bootstrap') as any).projects[0].id as string;

test('ending a session shows the wrap-up with its counts; Show terminal and back', async () => {
  const f = setup('wrap-counts'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'rule: Release tags must be signed by CI');
    await type(page, 'append README.md one more line', 'WROTE README.md');
    await type(page, 'exit-with 0');
    await expect(heading(page)).toHaveText('Exited 0 after <1m');
    // The terminal that had focus is gone: focus moves to the heading.
    await expect(heading(page)).toBeFocused();
    const changes = wrapUp(page).locator('.wrap-card').filter({ hasText: 'Changes' });
    await expect(changes.locator('.wrap-card-value')).toHaveText('+1 −0');
    await expect(changes.locator('.wrap-card-sub')).toContainText('1 file');
    await expect(wrapUp(page).locator('.wrap-card').filter({ hasText: 'Tests run' })).toContainText('No test commands seen');
    await expect(wrapUp(page).locator('.wrap-card').filter({ hasText: 'Continue this conversation' })).toContainText(/ID set by Journal at start|ID confirmed by Claude/);
    // The suggestion arrives about 1.5 s after the end.
    await expect(keep(page).getByRole('article', { name: /Release tags must be signed by CI/ })).toBeVisible({ timeout: 15000 });
    await expect(keep(page)).toContainText('You stated this rule in the task · applies to all branches');
    await expect(page.locator('.wrap-up [role=status]').first()).toHaveText('Session ended. 1 suggestion.');
    // One Continue: the header leaves it to the wrap-up.
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Show terminal', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('WROTE README.md');
    await page.getByRole('button', { name: 'Back to summary', exact: true }).click();
    await expect(heading(page)).toHaveText('Exited 0 after <1m');
  } finally { await closeApp(app); f.cleanup(); }
});

test('Remember puts the note in Memory at once; Remember all remembers every suggestion', async () => {
  const f = setup('wrap-remember'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'rule: Release tags must be signed by CI');
    await type(page, 'exit-with 0');
    const card = keep(page).getByRole('article', { name: /Release tags must be signed by CI/ });
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.sidebar-footer .count-badge')).toHaveText('1');
    await card.getByRole('button', { name: 'Remember', exact: true }).click();
    await expect(keep(page)).toContainText('Remembered. It goes to new sessions where it applies.');
    await expect(page.locator('.sidebar-footer .count-badge')).toHaveCount(0);
    await inspectorTab(page, 'Memory');
    await page.locator('.filter-tabs').getByRole('button', { name: 'Remembered', exact: true }).click();
    await expect(page.locator('.memory-list').getByText('Release tags must be signed by CI')).toBeVisible();
    const id = await projectId(page);
    const audit = await request(page, 'memoryPage', { projectId: id, filter: 'active' }) as any;
    expect(audit.items.map((item: any) => item.statement)).toEqual(['Release tags must be signed by CI']);

    // Two rule lines: Remember all n, also from the keyboard.
    await start(page, 'rule: Always run npm test before pushing\nrule: Never commit generated files');
    await type(page, 'exit-with 0');
    const all = keep(page).getByRole('button', { name: /^Remember all 2/ });
    await expect(all).toBeVisible({ timeout: 15000 });
    await expect(all).toHaveAttribute('aria-keyshortcuts', mac ? 'Shift+Meta+Enter' : 'Control+Shift+Enter');
    await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(mac ? 'Shift+Meta+Enter' : 'Control+Shift+Enter');
    await expect(keep(page).locator('.wrap-row-done.ok')).toHaveCount(2);
    const active = await request(page, 'memoryPage', { projectId: id, filter: 'active' }) as any;
    expect(active.items.map((item: any) => item.statement).sort()).toEqual(['Always run npm test before pushing', 'Never commit generated files', 'Release tags must be signed by CI']);
  } finally { await closeApp(app); f.cleanup(); }
});

test('Edit adds the suggestion for review; Dismiss can be undone; the explainer shows once', async () => {
  const f = setup('wrap-edit'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'rule: Use pnpm for scripts\nrule: Keep release tags signed always');
    await type(page, 'exit-with 0');
    const edit = keep(page).getByRole('article', { name: /Use pnpm for scripts/ });
    await expect(edit).toBeVisible({ timeout: 15000 });
    await expect(keep(page).locator('.wrap-explainer')).toContainText('These are suggestions.');
    // Edit…: added for review, then the form; Cancel leaves it waiting for review.
    await edit.getByRole('button', { name: 'Edit…', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Revise note' });
    await expect(form).toBeVisible();
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(keep(page)).toContainText('Added to Memory under Needs review.');
    const id = await projectId(page);
    expect((await request(page, 'memoryPage', { projectId: id, filter: 'review' }) as any).items.map((item: any) => item.statement)).toEqual(['Use pnpm for scripts']);
    // Acting on a suggestion hides the explainer for good.
    await expect(keep(page).locator('.wrap-explainer')).toHaveCount(0);
    // Dismiss is staged with Undo; Undo restores the card and nothing is dismissed.
    const other = keep(page).getByRole('article', { name: /Keep release tags signed always/ });
    await other.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(keep(page)).toContainText('Dismissed. It won’t be suggested again.');
    await keep(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(other).toBeVisible();
    // Leaving the view commits staged choices; an undone one is never sent.
    await newSession(page);
    const open = await request(page, 'proposals', { projectId: id }) as any[];
    expect(open.map(p => p.statement)).toEqual(['Keep release tags signed always']);
    // Dismiss, then leave: committed at once.
    await sessionButton(page, 'Use pnpm for scripts').click();
    await keep(page).getByRole('article', { name: /Keep release tags signed always/ }).getByRole('button', { name: 'Dismiss', exact: true }).click();
    await newSession(page);
    await expect.poll(async () => (await request(page, 'proposals', { projectId: id }) as any[]).length).toBe(0);
    // The explainer stays hidden on the next wrap-up.
    await start(page, 'rule: Prefer small focused commits always');
    await type(page, 'exit-with 0');
    await expect(keep(page).getByRole('article', { name: /Prefer small focused commits always/ })).toBeVisible({ timeout: 15000 });
    await expect(keep(page).locator('.wrap-explainer')).toHaveCount(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('hand-off fills the composer without starting', async () => {
  const f = setup('wrap-handoff'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'Review the updater feed');
    await type(page, 'exit-with 0');
    await expect(heading(page)).toBeVisible();
    await wrapUp(page).locator('.wrap-handoff').getByRole('button', { name: 'Codex', exact: true }).click();
    await expect(page.getByLabel('Initial task')).toHaveValue('Review the updater feed');
    await expect(page.getByLabel('Initial task')).toBeFocused();
    const sessions = await request(page, 'sessions') as any;
    expect(sessions.live.filter((s: any) => ['starting', 'running', 'waiting', 'stopping'].includes(s.status))).toHaveLength(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('a session that changed a note’s file shows the catch; Still true remembers it again', async () => {
  const f = setup('wrap-catch'); const { app, page } = await open(f.env, f.project);
  try {
    const id = await projectId(page);
    const note = await request(page, 'proposeMemory', { projectId: id, input: { statement: 'Stop waits 3 s before it kills the process', category: 'decision', scope: 'checkout', area: '', source: { kind: 'file', path: 'src/a.js', startLine: 1, endLine: 2 } } }) as any;
    await request(page, 'setMemoryStatus', { id: note.id, status: 'active' });
    await start(page, 'Raise the grace period');
    await type(page, 'setline src/a.js 1 const graceMs = 5000;', 'WROTE src/a.js');
    await type(page, 'exit-with 0');
    const card = page.locator('.stale-catch');
    await expect(card.getByRole('heading', { name: 'This session changed a.js. 1 note is based on it.' })).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText('Until you check it, the note is left out of new sessions');
    await expect(card.locator('.stale-diff tr.del')).toContainText('removed const graceMs = 3000;');
    await expect(card.locator('.stale-diff tr.add')).toContainText('added const graceMs = 5000;');
    await expect(card.locator('.note-evidence')).toHaveText('Check needed · file changed');
    await card.getByRole('button', { name: 'Still true', exact: true }).click();
    // A moved citation asks for the new lines first.
    const range = card.getByRole('group', { name: 'The cited lines moved. Lines' });
    if (await range.count()) await range.getByRole('button', { name: 'Still true', exact: true }).click();
    await expect(page.locator('.wrap-resolved')).toContainText('Marked still true.');
    // Leaving commits the staged check.
    await newSession(page);
    await expect.poll(async () => (await request(page, 'getMemory', { id: note.id }) as any).revision).toBe(2);
    const memory = await request(page, 'getMemory', { id: note.id }) as any;
    expect(memory.status).toBe('active');
    await inspectorTab(page, 'Memory');
    await expect(page.locator('.memory-card').filter({ hasText: 'Stop waits 3 s' }).locator('.memory-state')).toHaveText('Remembered');
  } finally { await closeApp(app); f.cleanup(); }
});

test('Forget asks first, and cancel keeps the note', async () => {
  const f = setup('wrap-forget'); const { app, page } = await open(f.env, f.project);
  try {
    const id = await projectId(page);
    const note = await request(page, 'proposeMemory', { projectId: id, input: { statement: 'Stop waits 3 s', category: 'decision', scope: 'checkout', area: '', source: { kind: 'file', path: 'src/a.js', startLine: 1, endLine: 2 } } }) as any;
    await request(page, 'setMemoryStatus', { id: note.id, status: 'active' });
    await start(page, 'Change the grace');
    await type(page, 'setline src/a.js 1 const graceMs = 4000;', 'WROTE src/a.js');
    await type(page, 'exit-with 0');
    const card = page.locator('.stale-catch');
    await expect(card).toBeVisible({ timeout: 15000 });
    await app.evaluate(({ dialog }) => { (globalThis as any).__asked = 0; dialog.showMessageBox = async () => { (globalThis as any).__asked++; return { response: 1, checkboxChecked: false }; }; });
    await card.getByRole('button', { name: 'Forget…', exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__asked)).toBe(1);
    await expect(card.getByRole('button', { name: 'Still true', exact: true })).toBeVisible();
    expect((await request(page, 'getMemory', { id: note.id }) as any).status).toBe('active');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
    await card.getByRole('button', { name: 'Forget…', exact: true }).click();
    await expect(page.locator('.wrap-resolved')).toHaveText('Note forgotten. No new session will get it. It stays in History.');
    await expect(page.locator('.wrap-resolved').getByRole('button', { name: 'Undo' })).toHaveCount(0);
    expect((await request(page, 'getMemory', { id: note.id }) as any).status).toBe('archived');
  } finally { await closeApp(app); f.cleanup(); }
});

test('an error exit leads with the last output; Copy output copies it', async () => {
  const f = setup('wrap-error'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'Load the config');
    await type(page, 'print boom: unknown variant on-reqest', 'boom: unknown variant');
    await type(page, 'exit-with 3');
    await expect(heading(page)).toHaveText('Exited 3 after <1m');
    const panel = page.locator('.wrap-error');
    await expect(panel.getByRole('heading', { name: 'Session exited with an error' })).toBeVisible();
    await expect(panel).toContainText('Last thing in the terminal');
    await expect(panel.locator('.terminal-surface')).toContainText('boom: unknown variant on-reqest');
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));
    await panel.getByRole('button', { name: 'Copy output', exact: true }).click();
    await expect(panel).toContainText('Copied');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('boom: unknown variant on-reqest');
    await expect(keep(page)).toContainText('No suggestions from this session.', { timeout: 15000 });
    await panel.getByRole('button', { name: 'Show terminal', exact: true }).click();
    await expect(page.locator('.terminal-panel .terminal-surface')).toContainText('boom');
  } finally { await closeApp(app); f.cleanup(); }
});

test('a released buffer says it was not saved', async () => {
  const f = setup('wrap-released'); const { app, page } = await open(f.env, f.project);
  try {
    for (let n = 1; n <= 9; n++) {
      await newSession(page);
      await page.getByLabel('Initial task').fill(`QUICK ${n}`);
      await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
      await expect(heading(page)).toHaveText(/^Exited 0/, { timeout: 15000 });
    }
    // The ninth exit releases the oldest buffer (at most 8 stay in memory).
    await expect(async () => {
      await sessionButton(page, 'QUICK 9').click(); await expect(heading(page)).toBeVisible();
      await sessionButton(page, 'QUICK 1').click(); await expect(heading(page)).toBeVisible();
      await showTerminal(page);
      await expect(page.locator('.wrap-not-saved')).toHaveText('Terminal output is kept in memory only while Journal’s runtime runs. It was not saved and is no longer available.', { timeout: 2000 });
    }).toPass({ timeout: 30000 });
    // A retained one still replays.
    await sessionButton(page, 'QUICK 9').click();
    await showTerminal(page);
    await expect(page.locator('.terminal-surface')).toContainText('DONE QUICK 9');
  } finally { await closeApp(app); f.cleanup(); }
});

test('Continue is disabled until a Codex ID is confirmed; ⌘↵ continues', async () => {
  const f = setup('wrap-codex'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'CODEX_ID', 'Codex');
    await type(page, 'exit-with 0');
    const cont = wrapUp(page).getByRole('button', { name: 'Continue', exact: true });
    await expect(cont).toBeDisabled();
    await expect(wrapUp(page)).toContainText('Confirm the conversation ID first');
    const card = wrapUp(page).locator('.wrap-card').filter({ hasText: 'Continue this conversation' });
    await expect(card).toContainText('No conversation ID yet');
    await card.getByLabel('Conversation ID').fill('0f4b8e2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b');
    await card.getByRole('button', { name: 'Confirm conversation ID', exact: true }).click();
    await expect(card).toContainText('Confirmed by you');
    await expect(cont).toBeEnabled();
    await expect(cont).toHaveAttribute('aria-keyshortcuts', mac ? 'Meta+Enter' : 'Control+Enter');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(mac ? 'Meta+Enter' : 'Control+Enter');
    await expect(page.locator('.terminal-surface')).toContainText('TASK');
    await expect(wrapUp(page)).toHaveCount(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('notes for another branch hide Revise and Remember', async () => {
  const f = setup('wrap-branch'); const { app, page } = await open(f.env, f.project);
  try {
    const id = await projectId(page);
    const input = (statement: string, scope: string) => ({ projectId: id, input: { statement, category: 'decision', scope, area: '', source: { kind: 'user', note: 'Fixture' } } });
    const branchNote = await request(page, 'proposeMemory', input('Main only: ship from main', 'branch')) as any;
    await request(page, 'setMemoryStatus', { id: branchNote.id, status: 'active' });
    await request(page, 'proposeMemory', input('Main only: candidate rule', 'branch'));
    await request(page, 'proposeMemory', input('Everywhere: keep it simple', 'checkout'));
    f.git('checkout', '-b', 'feature/x');
    await inspectorTab(page, 'Memory');
    // The checkout poll (3 s) notices the switch.
    const card = (text: string) => page.locator('.memory-card').filter({ hasText: text });
    await expect(card('Main only: ship from main').getByRole('button', { name: 'Revise', exact: true })).toHaveCount(0, { timeout: 15000 });
    await expect(card('Main only: candidate rule').getByRole('button', { name: 'Remember', exact: true })).toHaveCount(0);
    await expect(card('Everywhere: keep it simple').getByRole('button', { name: 'Revise', exact: true })).toBeVisible();
    await expect(card('Everywhere: keep it simple').getByRole('button', { name: 'Remember', exact: true })).toBeVisible();
  } finally { await closeApp(app); f.cleanup(); }
});
