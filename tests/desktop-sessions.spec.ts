import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';

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
if(char!=='\\r'&&char!=='\\n'){input+=char;continue}
const command=input;input='';
if(command==='daemon'){const c=spawn(process.execPath,['-e',${JSON.stringify(daemonCode)}],{detached:true,stdio:'ignore'});c.unref();console.log('DAEMON_STARTED')}
else if(command==='unicode'){process.stdout.write('\\x1b[31mRED\\x1b[0m \\u6f22\\u5b57\\u30c6\\u30b9\\u30c8 \\u{1F600} \\u05e2\\u05d1\\u05e8\\u05d9\\u05ea\\r\\nCRLF_OK\\r\\n')}
else if(command.startsWith('write ')){fs.writeFileSync(command.slice(6),'created by agent\\n');console.log('WROTE')}
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
      await page.getByLabel('Initial task').fill(`TASK_${i}`);
      await page.getByRole('button', { name: i % 2 ? 'Start Codex' : 'Start Claude', exact: true }).click();
      await expect(page.locator('.terminal-surface')).toContainText(`TASK TASK_${i}`);
    }
    await expect(page.getByRole('button', { name: 'Start Claude', exact: true })).toBeDisabled();
    await expect(page.getByText('4 sessions are running')).toBeVisible();
    await expect(page.getByText('4/4 active')).toBeVisible();
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
    // Keyboard switching: ⌘1–4 on macOS, Alt+1–4 elsewhere.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+4' : 'Alt+4');
    await expect(page.locator('.terminal-label')).toBeVisible();
    await page.reload();
    await expect(page.getByText('4/4 active')).toBeVisible();
    await sessionButton(page, 'TASK_1').click();
    await expect(page.locator('.terminal-surface')).toContainText('ECHO only-in-one');
    await typeLine(page, 'after-reload');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO after-reload');
    expect(f.launches()).toHaveLength(4);
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect(page.locator('.terminal-label')).toContainText('stopped');
    await expect(page.getByRole('button', { name: 'Start Claude', exact: true })).toBeEnabled();
  } finally { await closeApp(app); f.cleanup(); }
});

test('an app crash leaves sessions running in the runtime; the next launch reconnects without relaunching', async () => {
  const f = setup('crash'); let { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await page.getByLabel('Initial task').fill('SURVIVE_CRASH');
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
    await page.getByLabel('Initial task').fill('RUNTIME_CRASH');
    await page.getByRole('button', { name: 'Start Codex', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK RUNTIME_CRASH');
    const before = f.runtimeInfo();
    process.kill(before.pid, 'SIGKILL');
    await expect.poll(() => { try { return f.runtimeInfo().runtimeId !== before.runtimeId; } catch { return false; } }, { timeout: 20000 }).toBe(true);
    await expect(page.getByText('Runtime connected')).toBeVisible({ timeout: 20000 });
    // The fixture dies with its PTY, so it must be interrupted, not orphaned.
    await expect(page.locator('.terminal-label')).toContainText('interrupted');
    expect(f.launches()).toHaveLength(1);
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(page.getByText(/Recovered after the runtime stopped/)).toBeVisible();
  } finally { await closeApp(app); f.cleanup(); }
});

test('keep-running quit is rediscovered; stopping reports and cleans detached leftovers; changes are listed', async () => {
  const f = setup('keep'); let { app, page } = await open({ ...f.env, JOURNAL_QUIT_POLICY: 'keep' }, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await page.getByLabel('Initial task').fill('KEEP_RUNNING');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK KEEP_RUNNING');
    await closeApp(app);
    expect(alive(f.launches()[0].pid)).toBe(true);
    ({ app, page } = await open(f.env, f.project));
    await sessionButton(page, 'KEEP_RUNNING').click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK KEEP_RUNNING');
    await typeLine(page, 'write agent-output.txt');
    await expect(page.locator('.terminal-surface')).toContainText('WROTE');
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page.getByRole('button', { name: /agent-output\.txt/ })).toBeVisible();
    await page.getByRole('button', { name: /agent-output\.txt/ }).click();
    await expect(page.getByLabel('Diff for agent-output.txt')).toContainText('+created by agent');
    await typeLine(page, 'daemon');
    await expect(page.locator('.terminal-surface')).toContainText('DAEMON_STARTED');
    await expect.poll(() => existsSync(f.daemonRecord)).toBe(true);
    const daemon = JSON.parse(readFileSync(f.daemonRecord, 'utf8')).pid;
    // Descendants are sampled every 5 s and immediately before stop.
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect(page.locator('.terminal-label')).toContainText('stopped');
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
    await page.getByLabel('Workspace').selectOption({ label: 'Worktree · journal/isolated' });
    await page.getByLabel(/Research/).check();
    await page.getByLabel('Initial task').fill('WORKTREE_TASK');
    await page.getByRole('button', { name: 'Start Codex', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK WORKTREE_TASK');
    await expect(page.locator('.terminal-surface')).toContainText('ARGS ["--sandbox","read-only"]');
    await expect(page.locator('.terminal-surface')).toContainText(/CWD .*worktrees/);
    await expect(page.locator('.terminal-label')).toContainText('worktree · research');
    await page.getByRole('button', { name: 'Workspaces…' }).click();
    await page.getByRole('button', { name: 'Remove worktree' }).click();
    await expect(page.getByText(/still running in it/)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect(page.locator('.terminal-label')).toContainText('stopped');
    await page.getByRole('button', { name: 'Workspaces…' }).click();
    await page.getByRole('button', { name: 'Remove worktree' }).click();
    await expect(page.getByRole('list', { name: 'Workspaces' })).not.toContainText('journal/isolated');
    expect(existsSync(resolve(f.project, 'uncommitted.txt'))).toBe(true);
  } finally { await closeApp(app); f.cleanup(); }
});

test('a branch switched outside Journal is picked up and live sessions say where they started', async () => {
  const f = setup('switch'); const { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await page.getByLabel('Initial task').fill('SWITCH_TASK');
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('TASK SWITCH_TASK');
    await expect(page.getByLabel('Workspace')).toContainText('Current checkout · main');
    execFileSync('git', ['-C', f.project, 'switch', '-q', '-c', 'feat/elsewhere']);
    await expect(page.getByLabel('Workspace')).toContainText('Current checkout · feat/elsewhere', { timeout: 8000 });
    await expect(page.locator('.branch-badge')).toContainText('feat/elsewhere');
    await expect(page.locator('.terminal-label')).toContainText('started on ⑂ main');
    await expect(page.getByText(/The checkout is now on feat\/elsewhere; this session started on main/)).toBeVisible();
  } finally { await closeApp(app); f.cleanup(); }
});
