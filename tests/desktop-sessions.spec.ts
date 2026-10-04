import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { filesView, inspectorTab, newSession, sessionStatus, slotsUsed } from './support/ui';

// Real Electron, real runtime process and node-pty, controlled fixture CLIs.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`));
  const project = resolve(root, 'multi project'); const bin = resolve(root, 'bin'); mkdirSync(project); mkdirSync(bin);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const ledger = resolve(root, 'launches.jsonl'); const daemonRecord = resolve(root, 'daemon.json');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), 'Multi-session fixture\n'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'init');
  const daemonCode = `require('node:fs').writeFileSync(${JSON.stringify(daemonRecord)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),60000);`;
  const fixture = `#!${process.execPath}
const fs=require('node:fs');const {spawn}=require('node:child_process');
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})+'\\n');
const task=(process.argv.at(-1)||'').split('\\n').at(-1);
console.log('PTY_READY '+process.stdout.isTTY);console.log('TASK '+task);console.log('CWD '+process.cwd());console.log('ARGS '+JSON.stringify(process.argv.slice(2,4)));
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let input='';
process.stdin.on('data',data=>{for(const char of data){
if(char==='\\x03'){console.log('INTERRUPTED');continue}
if(char==='\\x0f'){console.log('CTRL_O');continue}
if(char!=='\\r'&&char!=='\\n'){input+=char;continue}
const command=input;input='';
if(command==='daemon'){const c=spawn(process.execPath,['-e',${JSON.stringify(daemonCode)}],{detached:true,stdio:'ignore'});c.unref();console.log('DAEMON_STARTED')}
else if(command==='unicode'){process.stdout.write('\\x1b[31mRED\\x1b[0m \\u6f22\\u5b57\\u30c6\\u30b9\\u30c8 \\u{1F600} \\u05e2\\u05d1\\u05e8\\u05d9\\u05ea\\r\\nCRLF_OK\\r\\n')}
else if(command.startsWith('write ')){fs.writeFileSync(command.slice(6),'created by agent\\n');console.log('WROTE')}
else if(command==='delay'){setTimeout(()=>console.log('DELAYED'),600)}
else if(command.startsWith('perm ')){const a=process.argv;const hook=JSON.parse(fs.readFileSync(a[a.indexOf('--settings')+1],'utf8')).hooks.PermissionRequest[0].hooks[0].command;
const c=spawn('/bin/sh',['-c',hook],{stdio:['pipe','ignore','ignore']});c.on('exit',()=>console.log('ASKED'));
c.stdin.end(JSON.stringify({hook_event_name:'PermissionRequest',session_id:a[a.indexOf('--session-id')+1],cwd:process.cwd(),tool_name:'Bash',tool_use_id:'perm1',tool_input:{command:command.slice(5)}}))}
else console.log('ECHO '+command);
}});`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' };
  delete env.ELECTRON_RUN_AS_NODE;
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const runtimeInfo = () => JSON.parse(readFileSync(resolve(root, 'data/runtime.json'), 'utf8'));
  const cleanup = () => {
    for (const pid of [...launches().map(x => x.pid), existsSync(daemonRecord) ? JSON.parse(readFileSync(daemonRecord, 'utf8')).pid : 0]) {
      try { if (pid && execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(root)) process.kill(pid, 'SIGKILL'); } catch {}
    }
    try { const info = runtimeInfo(); if (execFileSync('ps', ['-p', String(info.pid), '-o', 'command='], { encoding: 'utf8' }).includes('runtime.mjs')) process.kill(info.pid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { root, project, env, launches, runtimeInfo, daemonRecord, cleanup };
}

async function open(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
  const page = await app.firstWindow(); return { app, page };
}
// Bounded close: on Linux, Chromium helpers can keep Playwright's pipes open after a
// forced kill or a keep-running quit, so close() may never resolve there.
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; } // elsewhere a hang must fail the test
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(resolveWait => setTimeout(resolveWait, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
const typeLine = async (page: Page, text: string) => { await page.locator('.xterm-helper-textarea').pressSequentially(text); await page.locator('.xterm-helper-textarea').press('Enter'); };
const sessionButton = (page: Page, task: string) => page.getByRole('button', { name: new RegExp(`: ${task}\\.`) });

test('four concurrent sessions stay isolated, switch instantly and survive a renderer reload', async () => {
  const f = setup('sessions'); let { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    for (let i = 0; i < 4; i++) {
      await newSession(page); await page.getByLabel('Initial task').fill(`TASK_${i}`);
      await page.getByRole('button', { name: i % 2 ? 'Start Codex' : 'Start Claude', exact: true }).click();
      await expect(page.locator('.terminal-surface')).toContainText(`TASK TASK_${i}`);
    }
    // With every slot in use, the New session view still opens; Start waits and says why.
    await newSession(page);
    await expect(page.getByRole('button', { name: 'Start Claude', exact: true })).toBeDisabled();
    await expect(page.getByText('4 sessions are running')).toBeVisible();
    await expect(slotsUsed(page, 4)).toBeVisible();
    await sessionButton(page, 'TASK_1').click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK TASK_1');
    await typeLine(page, 'unicode');
    await expect(page.locator('.terminal-surface')).toContainText('RED \u6f22\u5b57\u30c6\u30b9\u30c8');
    await expect(page.locator('.terminal-surface')).toContainText('CRLF_OK');
    await expect(page.locator('.terminal-surface')).not.toContainText('[31m');
    expect(await page.evaluate(() => (document.querySelector('.xterm-rows')?.textContent ?? '').includes('\u{1F600}'))).toBe(true);
    await typeLine(page, 'only-in-one');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO only-in-one');
    await sessionButton(page, 'TASK_2').click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK TASK_2');
    await expect(page.locator('.terminal-surface')).not.toContainText('ECHO only-in-one');
    // Slot shortcuts work while the terminal has focus (BUG-7): ⌘1–4 on macOS, Alt+1–4 elsewhere.
    const mac = process.platform === 'darwin'; const slot = [mac ? 'meta' : 'alt'] as const;
    await expect(sessionButton(page, 'TASK_2')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await pressKey(app, '1', [...slot]); // Stable slots in start order: slot 1 is TASK_0.
    await expect(sessionButton(page, 'TASK_0')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.terminal-surface')).toContainText('TASK TASK_0');
    await expect(sessionButton(page, 'TASK_3')).toHaveAttribute('aria-keyshortcuts', mac ? 'Meta+4' : 'Alt+4');
    // Keys that are not app shortcuts still reach the CLI.
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await pressKey(app, 'C', ['control']);
    await expect(page.locator('.terminal-surface')).toContainText('INTERRUPTED');
    // While a dialog is open, shortcut keys are not claimed: they reach the dialog
    // like any other key, and no command runs.
    await page.evaluate(() => { const keys: string[] = (window as any).__keys = []; window.addEventListener('keydown', event => keys.push(event.key)); });
    await pressKey(app, 'K', mac ? ['meta', 'shift'] : ['control', 'shift']);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(async () => {
      await pressKey(app, '2', [...slot]);
      expect(await page.evaluate(() => (window as any).__keys)).toContain('2');
    }).toPass();
    await expect(sessionButton(page, 'TASK_0')).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Closing the dialog gives the shortcuts back.
    await expect(async () => {
      await pressKey(app, '2', [...slot]);
      await expect(sessionButton(page, 'TASK_1')).toHaveAttribute('aria-current', 'true', { timeout: 1000 });
    }).toPass();
    await page.reload();
    await expect(slotsUsed(page, 4)).toBeVisible();
    await sessionButton(page, 'TASK_1').click();
    await expect(page.locator('.terminal-surface')).toContainText('ECHO only-in-one');
    await typeLine(page, 'after-reload');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO after-reload');
    expect(f.launches()).toHaveLength(4);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    await newSession(page);
    await expect(page.getByRole('button', { name: 'Start Claude', exact: true })).toBeEnabled();
  } finally { await closeApp(app); f.cleanup(); }
});

// Windows and Linux leave Ctrl+O to the CLI inside the terminal; elsewhere in
// the window it opens a project (macOS routes ⌘O instead). Windows has no POSIX
// fixture CLIs, so Linux carries this check.
test('Ctrl+O opens a project outside the terminal and reaches the CLI inside it', async () => {
  test.skip(process.platform !== 'linux', 'Ctrl+O is a page shortcut only on Windows and Linux');
  const f = setup('ctrl-o'); const { app, page } = await open(f.env, f.project);
  try {
    await app.evaluate(({ dialog }, selected) => {
      (globalThis as any).__opens = 0;
      dialog.showOpenDialog = async () => { (globalThis as any).__opens += 1; return { canceled: false, filePaths: [selected] }; };
    }, f.project);
    const opens = () => app.evaluate(() => (globalThis as any).__opens as number);
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await expect.poll(opens).toBe(1);
    await newSession(page); await page.getByLabel('Initial task').fill('PLAIN_TASK');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK PLAIN_TASK');
    await page.locator('.xterm-helper-textarea').focus();
    await pressKey(app, 'O', ['control']);
    await expect(page.locator('.terminal-surface')).toContainText('CTRL_O');
    expect(await opens()).toBe(1);
    await page.getByRole('button', { name: 'New session' }).focus();
    await pressKey(app, 'O', ['control']);
    await expect.poll(opens).toBe(2);
  } finally { await closeApp(app); f.cleanup(); }
});

test('focus, new-session and panel shortcuts act on the UI while the terminal has focus', async () => {
  const f = setup('shortcuts'); const { app, page } = await open(f.env, f.project);
  const mac = process.platform === 'darwin';
  const cmd = mac ? ['meta'] as const : ['control', 'shift'] as const; const tab = mac ? ['meta', 'alt'] as const : ['alt', 'shift'] as const;
  const terminal = page.locator('.xterm-helper-textarea'); const selectedTab = page.locator('.panel-tabs [role=tab][aria-selected=true]');
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await newSession(page); await page.getByLabel('Initial task').fill('KEYS_TASK');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK KEYS_TASK');
    // focus-terminal, from another control.
    await page.getByRole('button', { name: 'New session' }).focus();
    await pressKey(app, 'E', [...cmd]);
    await expect(terminal).toBeFocused();
    // Inspector tabs: Memory, then Session; the terminal keeps focus.
    await pressKey(app, '3', [...tab]);
    await expect(selectedTab).toHaveText('Memory');
    await expect(terminal).toBeFocused();
    await pressKey(app, '1', [...tab]);
    await expect(selectedTab).toHaveText('Session');
    await expect(terminal).toBeFocused();
    // new-session: no session selected and the task box has focus.
    await pressKey(app, 'N', [...cmd]);
    await expect(page.getByLabel('Initial task')).toBeFocused();
    await expect(sessionButton(page, 'KEYS_TASK')).not.toHaveAttribute('aria-current', 'true');
    expect(f.launches()).toHaveLength(1);
  } finally { await closeApp(app); f.cleanup(); }
});

test('an app crash leaves sessions running in the runtime; the next launch reconnects without relaunching', async () => {
  const f = setup('crash'); let { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await newSession(page); await page.getByLabel('Initial task').fill('SURVIVE_CRASH');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK SURVIVE_CRASH');
    await typeLine(page, 'before-crash');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO before-crash');
    const agent = f.launches()[0].pid;
    app.process().kill('SIGKILL'); await closeApp(app);
    await expect.poll(() => alive(agent)).toBe(true);
    ({ app, page } = await open(f.env, f.project));
    await expect(sessionButton(page, 'SURVIVE_CRASH')).toBeVisible();
    await sessionButton(page, 'SURVIVE_CRASH').click();
    await expect(page.locator('.terminal-surface')).toContainText('ECHO before-crash');
    await typeLine(page, 'after-crash');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO after-crash');
    expect(f.launches()).toHaveLength(1);
  } finally { await closeApp(app); f.cleanup(); }
});

test('a runtime crash is reported, recovered as interrupted, and never resends the prompt', async () => {
  const f = setup('runtime'); const { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await newSession(page); await page.getByLabel('Initial task').fill('RUNTIME_CRASH');
    await page.getByRole('button', { name: 'Start Codex', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK RUNTIME_CRASH');
    const before = f.runtimeInfo();
    process.kill(before.pid, 'SIGKILL');
    await expect.poll(() => { try { return f.runtimeInfo().runtimeId !== before.runtimeId; } catch { return false; } }, { timeout: 20000 }).toBe(true);
    await expect(page.getByText('Runtime connected')).toBeVisible({ timeout: 20000 });
    // The fixture dies with its PTY, so it must be interrupted, not orphaned.
    await expect(sessionStatus(page)).toContainText('Interrupted');
    expect(f.launches()).toHaveLength(1);
    await inspectorTab(page, 'Session');
    await page.getByRole('button', { name: 'Show full timeline' }).click();
    await expect(page.getByText(/Recovered after the runtime stopped/)).toBeVisible();
  } finally { await closeApp(app); f.cleanup(); }
});

test('keep-running quit is rediscovered; stopping reports and cleans detached leftovers; changes are listed', async () => {
  const f = setup('keep'); let { app, page } = await open({ ...f.env, JOURNAL_QUIT_POLICY: 'keep' }, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await newSession(page); await page.getByLabel('Initial task').fill('KEEP_RUNNING');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK KEEP_RUNNING');
    await closeApp(app);
    expect(alive(f.launches()[0].pid)).toBe(true);
    ({ app, page } = await open(f.env, f.project));
    await sessionButton(page, 'KEEP_RUNNING').click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK KEEP_RUNNING');
    await typeLine(page, 'write agent-output.txt');
    await expect(page.locator('.terminal-surface')).toContainText('WROTE');
    await inspectorTab(page, 'Files'); await filesView(page, 'changed');
    await expect(page.getByRole('button', { name: /agent-output\.txt/ })).toBeVisible();
    await page.getByRole('button', { name: /agent-output\.txt/ }).click();
    await expect(page.getByLabel('Diff for agent-output.txt')).toContainText('+created by agent');
    await typeLine(page, 'daemon');
    await expect(page.locator('.terminal-surface')).toContainText('DAEMON_STARTED');
    await expect.poll(() => existsSync(f.daemonRecord)).toBe(true);
    const daemon = JSON.parse(readFileSync(f.daemonRecord, 'utf8')).pid;
    // Descendants are sampled every 5 s and immediately before stop.
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    expect(alive(daemon)).toBe(true);
    await page.getByRole('button', { name: /End 1 leftover process/ }).click();
    await expect.poll(() => alive(daemon)).toBe(false);
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(sessionButton(page, 'KEEP_RUNNING')).toHaveCount(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('a managed worktree is created from the dialog, hosts a research session and refuses removal while in use', async () => {
  const f = setup('worktree'); const { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    writeFileSync(resolve(f.project, 'uncommitted.txt'), 'local\n');
    await page.getByRole('button', { name: 'Workspaces…' }).click();
    await page.getByLabel('New branch').fill('journal/isolated');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText(/will not be in the new worktree/)).toBeVisible();
    await page.getByRole('button', { name: 'Create worktree' }).click();
    await expect(page.getByRole('list', { name: 'Workspaces' })).toContainText('managed · ready');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByLabel('Workspace').selectOption({ label: 'Separate copy (worktree) · journal/isolated' });
    await page.getByLabel('Read-only', { exact: true }).check();
    await newSession(page); await page.getByLabel('Initial task').fill('WORKTREE_TASK');
    await page.getByRole('button', { name: 'Start Codex', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK WORKTREE_TASK');
    await expect(page.locator('.terminal-surface')).toContainText('ARGS ["--sandbox","read-only"]');
    await expect(page.locator('.terminal-surface')).toContainText(/CWD .*worktrees/);
    await expect(sessionStatus(page)).toContainText('Separate copy (worktree) · ⑂ journal/isolated');
    await expect(sessionStatus(page)).toContainText('Read-only');
    // Workspaces… lives in the New session view.
    await newSession(page); await page.getByRole('button', { name: 'Workspaces…' }).click();
    await page.getByRole('button', { name: 'Remove worktree' }).click();
    await expect(page.getByText(/still running in it/)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await sessionButton(page, 'WORKTREE_TASK').click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    await newSession(page); await page.getByRole('button', { name: 'Workspaces…' }).click();
    await page.getByRole('button', { name: 'Remove worktree' }).click();
    await expect(page.getByRole('list', { name: 'Workspaces' })).not.toContainText('journal/isolated');
    expect(existsSync(resolve(f.project, 'uncommitted.txt'))).toBe(true);
  } finally { await closeApp(app); f.cleanup(); }
});

test('a branch switched outside Journal is picked up and live sessions say where they started', async () => {
  const f = setup('switch'); const { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await newSession(page); await page.getByLabel('Initial task').fill('SWITCH_TASK');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK SWITCH_TASK');
    await expect(page.locator('.project-switcher .branch-badge')).toContainText('main');
    execFileSync('git', ['-C', f.project, 'switch', '-q', '-c', 'feat/elsewhere']);
    // The switcher's sub-line follows the checkout.
    await expect(page.locator('.project-switcher .branch-badge')).toContainText('feat/elsewhere', { timeout: 8000 });
    await expect(sessionStatus(page)).toContainText('started on ⑂ main');
    await expect(page.getByText(/The checkout is now on feat\/elsewhere; this session started on main/)).toBeVisible();
  } finally { await closeApp(app); f.cleanup(); }
});

// Phase 2: stable slots, honest states and next needs-you.
const slotKeys = () => process.platform === 'darwin' ? ['meta'] as const : ['alt'] as const;
const slotAria = (n: number) => process.platform === 'darwin' ? `Meta+${n}` : `Alt+${n}`;
async function startSession(page: Page, task: string, provider: 'Claude' | 'Codex') {
  await newSession(page); await page.getByLabel('Initial task').fill(task);
  await page.getByRole('button', { name: `Start ${provider}`, exact: true }).click();
  await expect(page.locator('.terminal-surface')).toContainText(`TASK ${task}`);
}

test('slot shortcuts keep their session across a renderer reload and after another session stops', async () => {
  const f = setup('slots'); const { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await startSession(page, 'SLOT_A', 'Claude'); await startSession(page, 'SLOT_B', 'Codex');
    // Slot keys are ignored while a start or switch is still finishing (aria-busy);
    // once that settles, the first press selects.
    const select = async (key: string, task: string) => {
      await expect(page.locator('main.workspace')).not.toHaveAttribute('aria-busy', 'true');
      await pressKey(app, key, [...slotKeys()]);
      await expect(sessionButton(page, task)).toHaveAttribute('aria-current', 'true');
    };
    await select('1', 'SLOT_A'); await select('2', 'SLOT_B');
    await page.reload();
    await expect(slotsUsed(page, 2)).toBeVisible();
    await sessionButton(page, 'SLOT_A').click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK SLOT_A');
    await select('2', 'SLOT_B');
    // Stopping slot 1 leaves slot 2 where it was; the next start takes the free slot 1.
    await sessionButton(page, 'SLOT_A').click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    await expect(sessionButton(page, 'SLOT_A')).not.toHaveAttribute('aria-keyshortcuts');
    await select('2', 'SLOT_B');
    await expect(sessionButton(page, 'SLOT_B')).toHaveAttribute('aria-keyshortcuts', slotAria(2));
    await startSession(page, 'SLOT_C', 'Claude');
    await expect(sessionButton(page, 'SLOT_C')).toHaveAttribute('aria-keyshortcuts', slotAria(1));
    await select('2', 'SLOT_B'); await select('1', 'SLOT_C');
    // The Active group lists sessions in slot order.
    await expect(page.getByRole('group', { name: 'Active sessions' }).getByRole('button')).toHaveText([/SLOT_C/, /SLOT_B/]);
  } finally { await closeApp(app); f.cleanup(); }
});

test('next needs-you jumps to a Claude session waiting for approval and shows what it asks', async () => {
  const f = setup('needs-you'); const { app, page } = await open(f.env, f.project);
  const next = process.platform === 'darwin' ? ['meta'] as const : ['control', 'shift'] as const;
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await startSession(page, 'CALM_ONE', 'Claude'); await startSession(page, 'ASKING_TWO', 'Claude');
    // The fixture runs Journal's real hook with a PermissionRequest payload.
    await typeLine(page, 'perm TOKEN=abc123456 npm publish');
    await expect(page.locator('.terminal-surface')).toContainText('ASKED');
    await expect(sessionStatus(page)).toContainText('Needs approval');
    await sessionButton(page, 'CALM_ONE').click();
    await expect(sessionButton(page, 'CALM_ONE')).toHaveAttribute('aria-current', 'true');
    const asking = sessionButton(page, 'ASKING_TWO');
    await expect(asking).toContainText('Needs approval');
    await expect(asking).toContainText('TOKEN=[redacted] npm publish');
    await expect(asking).not.toContainText('abc123456');
    await expect(asking).toHaveAttribute('aria-label', /Needs approval, TOKEN=\[redacted\] npm publish.*needs attention/);
    // Once the switch to CALM_ONE settles, the first press selects.
    await expect(page.locator('main.workspace')).not.toHaveAttribute('aria-busy', 'true');
    await pressKey(app, 'J', [...next]);
    await expect(asking).toHaveAttribute('aria-current', 'true');
    // The only session that needs you is already selected: nothing moves.
    await pressKey(app, 'J', [...next]);
    await page.waitForTimeout(300);
    await expect(asking).toHaveAttribute('aria-current', 'true');
    // Esc dismisses the only prompt: Claude is back at its input box.
    await page.locator('.xterm-helper-textarea').press('Escape');
    await expect(sessionStatus(page)).toContainText('Your turn');
    await expect(asking).not.toContainText('Needs approval');
    // A notification click: main sends focus-session, which selects the session like a click.
    const calmId = await page.evaluate(async () => (await (window as any).journal.request('sessions')).live.find((s: any) => s.title === 'CALM_ONE').id);
    await app.evaluate(({ BrowserWindow }, sessionId) => { BrowserWindow.getAllWindows()[0].webContents.send('journal:event', { type: 'focus-session', sessionId }); }, calmId);
    await expect(sessionButton(page, 'CALM_ONE')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.terminal-surface')).toContainText('TASK CALM_ONE');
  } finally { await closeApp(app); f.cleanup(); }
});

test('Codex shows Running with output time and limited status', async () => {
  const f = setup('codex-state'); const { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await startSession(page, 'CODEX_STATE', 'Codex');
    const row = sessionButton(page, 'CODEX_STATE');
    await expect(row).toContainText('Running');
    // Output 600 ms after the key is not an echo, so it counts as agent output. Output
    // right after a real resize is a repaint (a same-size resize is ignored), so type
    // once the terminal has reported its size and that repaint window has passed.
    await expect(page.locator('main.workspace')).not.toHaveAttribute('aria-busy', 'true');
    await expect.poll(async () => (await page.evaluate(async () => (await (window as any).journal.request('sessions')).live)).find((s: any) => s.title === 'CODEX_STATE')?.terminal).toBeTruthy();
    await page.waitForTimeout(400);
    await typeLine(page, 'delay');
    await expect(row).toContainText(/output just now|quiet/, { timeout: 5000 });
    await expect(row).toHaveAttribute('aria-label', /Running, (output just now|quiet [^,]+), limited status/);
    await expect(row.locator('.session-status')).toHaveAttribute('title', /Journal sees output, not the agent's state/);
    // Codex rows are never amber: Journal cannot see their prompts.
    await expect(row).not.toHaveClass(/attention/);
    await expect(sessionStatus(page)).toContainText('Running');
  } finally { await closeApp(app); f.cleanup(); }
});

test('a fifth start is refused with the SLOTS_FULL code through the preload bridge', async () => {
  const f = setup('slots-full'); const { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    for (let i = 0; i < 4; i++) await startSession(page, `FULL_${i}`, i % 2 ? 'Codex' : 'Claude');
    const fifth = async () => page.evaluate(async () => {
      const journal = (window as any).journal; const boot = await journal.request('bootstrap');
      const input = { projectId: boot.projects[0].id, provider: 'claude', task: '' };
      let thrown: { code?: string; message: string } | null = null;
      try { await journal.request('start', input); } catch (error: any) { thrown = { code: error.code, message: error.message }; }
      return { settled: await journal.settle('start', input), thrown };
    });
    const { settled, thrown } = await fifth();
    // The code crosses the bridge as data; a thrown Error keeps only its message.
    expect(settled).toEqual({ ok: false, code: 'SLOTS_FULL', error: expect.stringContaining('Stop one before starting another') });
    expect(thrown?.message).toContain('Stop one before starting another');
    expect(f.launches()).toHaveLength(4);
  } finally { await closeApp(app); f.cleanup(); }
});
