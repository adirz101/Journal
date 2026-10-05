import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtureEnv } from './support/env';
import { chooseAgent, startButton, taskBox } from './support/ui';

// Phase 9 part 2 review I2/I4: the composer's default agent. Until the user (or a hand-off, or a
// remembered choice) picks one, the default follows detection in agent order, and an agent still
// being checked holds its place: a slow Claude Code check must not hand the default to Codex, and a
// later providers event must never switch the agent under the user. The Claude fixture answers
// --version only once the test removes the file `slow` (at most 3.5 s, under the 4 s check timeout). Hidden windows, fixture CLIs only.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

function setup(name: string, { slow = true } = {}) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`));
  const project = resolve(root, 'agent project'); const bin = resolve(root, 'bin'); const home = resolve(root, 'home');
  for (const dir of [project, bin, home]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# Agent fixture\n'); git('add', '.'); git('commit', '-qm', 'init');
  const ledger = resolve(root, 'launches.jsonl'); const slowFlag = resolve(root, 'slow');
  if (slow) writeFileSync(slowFlag, '');
  // Prints its task; the typed line `exit` ends it with code 0.
  const fixture = (provider: string) => `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){const done=()=>{console.log('fixture 1.0');process.exit(0)};${provider === 'claude' ? `const t0=Date.now();const wait=()=>fs.existsSync(${JSON.stringify(slowFlag)})&&Date.now()-t0<3500?setTimeout(wait,50):done();wait();` : 'done();'}}
else{fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({provider:${JSON.stringify(provider)},argv:process.argv.slice(2)})+'\\n');
console.log('TASK '+(process.argv.at(-1)||'').split('\\n').at(-1));process.stdin.setRawMode(true);let line='';
process.stdin.on('data',d=>{for(const c of d.toString()){if(c==='\\r'){if(line==='exit')process.exit(0);line=''}else line+=c}})}`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture(provider)); chmodSync(resolve(bin, provider), 0o755); }
  const env = fixtureEnv({ root, bin, home, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  delete env.ELECTRON_RUN_AS_NODE;
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { provider: string; argv: string[] }) : [];
  const cleanup = () => {
    try { const info = JSON.parse(readFileSync(resolve(root, 'data/runtime.json'), 'utf8')); if (execFileSync('ps', ['-p', String(info.pid), '-o', 'command='], { encoding: 'utf8' }).includes('runtime.mjs')) process.kill(info.pid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { root, project, bin, env, launches, slowFlag, cleanup };
}

async function open(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); (globalThis as any).__journalFocused = () => true; }, project);
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
const card = (page: Page, name: 'Claude Code' | 'Codex') => page.getByRole('radiogroup', { name: 'Agent' }).getByRole('radio', { name, exact: true });
const checked = (page: Page) => page.getByRole('radiogroup', { name: 'Agent' }).getByRole('radio', { checked: true });
// Fresh detection of Claude Code (slow while the flag exists): a providers event the renderer receives.
const recheckClaude = (page: Page) => page.evaluate(() => (window as any).journal.request('providerStatus', { provider: 'claude', fresh: true }));
// Records every Start label from now on.
const watchStart = (page: Page) => page.evaluate(() => {
  const w = window as any; w.__labels = [];
  const read = () => { const b = document.querySelector('.start-button'); const text = b?.textContent?.replace(/\s+/g, ' ').trim() ?? ''; if (w.__labels.at(-1) !== text) w.__labels.push(text); };
  read(); new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
});
const startLabels = (page: Page) => page.evaluate(() => ((window as any).__labels as string[]).map(label => label.replace(/ (⌘↵|Ctrl\+Enter)$/, '')));

test('a slow Claude Code check keeps the default on Claude Code; the label never flips once typing begins', async () => {
  const f = setup('agent-slow'); const { app, page } = await open(f.env, f.project);
  try {
    // Every Start label from the moment the composer shows, while Claude Code is still being checked
    // and Codex is ready: Claude Code holds its place, so no label ever names Codex.
    await watchStart(page);
    await expect(card(page, 'Claude Code')).toContainText('Checking');
    expect(await page.evaluate(() => document.querySelector('[role=radio][aria-checked=true]')?.getAttribute('aria-label'))).toBe('Claude Code');
    await taskBox(page).pressSequentially('A task for Claude');
    rmSync(f.slowFlag, { force: true }); // release the held check
    await expect(card(page, 'Claude Code')).not.toContainText('Checking', { timeout: 15000 });
    await expect(startButton(page)).toBeEnabled();
    expect(new Set(await startLabels(page))).toEqual(new Set(['Start Claude Code']));
    await expect(checked(page)).toHaveAccessibleName('Claude Code');
  } finally { await closeApp(app); f.cleanup(); }
});

test('a card the user chose, a hand-off and a remembered agent are never changed by a later providers event', async () => {
  const f = setup('agent-chosen'); const { app, page } = await open(f.env, f.project);
  try {
    // The user picks Codex while Claude Code is still being checked; Claude's answer changes nothing.
    await expect(card(page, 'Claude Code')).toContainText('Checking');
    await chooseAgent(page, 'codex');
    rmSync(f.slowFlag, { force: true }); // release the held check
    await expect(card(page, 'Claude Code')).not.toContainText('Checking', { timeout: 15000 });
    await recheckClaude(page);
    await expect(checked(page)).toHaveAccessibleName('Codex');
    await expect(startButton(page)).toHaveText(/^Start Codex/);

    // Remembered on this computer: after a reload, a providers event leaves Codex chosen.
    expect(await page.evaluate(() => localStorage.getItem('journal-agent'))).toBe('codex');
    await page.reload(); await expect(taskBox(page)).toBeVisible();
    await recheckClaude(page);
    await expect(checked(page)).toHaveAccessibleName('Codex');

    // A hand-off preselects its agent: start and end a Claude Code session, hand off to Codex, then a
    // providers event leaves Codex chosen.
    await chooseAgent(page, 'claude');
    await taskBox(page).fill('HAND_ME_OFF');
    await startButton(page).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK HAND_ME_OFF', { timeout: 15000 });
    await page.locator('.terminal-surface .xterm-helper-textarea').pressSequentially('exit'); await page.locator('.terminal-surface .xterm-helper-textarea').press('Enter');
    const handoff = page.locator('.wrap-up').getByRole('button', { name: 'Codex', exact: true });
    await expect(handoff).toBeVisible({ timeout: 15000 });
    // The hand-off's agent is not remembered as the default, so clear the remembered one first:
    // only the hand-off itself can keep Codex.
    await page.evaluate(() => localStorage.removeItem('journal-agent'));
    await handoff.click();
    await expect(taskBox(page)).toHaveValue(/HAND_ME_OFF/);
    await expect(checked(page)).toHaveAccessibleName('Codex');
    await recheckClaude(page);
    await page.waitForTimeout(500);
    await expect(checked(page)).toHaveAccessibleName('Codex');
    expect(f.launches().map(l => l.provider)).toEqual(['claude']);
  } finally { await closeApp(app); f.cleanup(); }
});

test('a refused Claude Code start keeps Claude Code chosen and explains it; nothing starts Codex', async () => {
  const f = setup('agent-refused', { slow: false }); const { app, page } = await open(f.env, f.project);
  try {
    await expect(checked(page)).toHaveAccessibleName('Claude Code');
    await expect(startButton(page)).toBeEnabled();
    const claude = resolve(f.bin, 'claude'); rmSync(claude); // gone after detection
    await taskBox(page).fill('MEANT_FOR_CLAUDE');
    await startButton(page).click();
    const error = page.locator('.start-error');
    await expect(error).toContainText('Claude Code isn’t installed');
    // The fresh check after PROVIDER_MISSING sends a providers event; the choice stays.
    await page.waitForTimeout(1000);
    await expect(checked(page)).toHaveAccessibleName('Claude Code');
    await expect(startButton(page)).toHaveText(/^Start Claude Code/);
    await expect(error).toContainText('Claude Code isn’t installed');
    await expect(taskBox(page)).toHaveValue('MEANT_FOR_CLAUDE');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await page.waitForTimeout(500);
    expect(f.launches()).toEqual([]);
  } finally { await closeApp(app); f.cleanup(); }
});
