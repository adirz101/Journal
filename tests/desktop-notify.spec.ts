import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { manageProject, newSession, openSettings, startSession } from './support/ui';
import { fixtureEnv } from './support/env';

// Approval notifications and the badge, end to end: real Electron, runtime and
// node-pty, a fixture Claude CLI, and Journal's real observer hook. Electron's
// Notification, the badge and window focus are replaced through headless-only
// hooks (see createNotifier in src/desktop/main.mjs), so nothing reaches the OS.
// Fixture results only: packaged notifications are a native check (docs/NATIVE-VALIDATION.md).
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

const COMMAND = 'API_KEY=FIXTURE_SECRET_1234567890 npm publish';

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`));
  const project = resolve(root, 'notify project'); const bin = resolve(root, 'bin'); mkdirSync(project); mkdirSync(bin);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const ledger = resolve(root, 'launches.jsonl');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), 'Notification fixture\n'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'init');
  // A Claude stand-in that stays at its prompt; the test plays Claude's hooks.
  const fixture = `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2),session:process.env.JOURNAL_SESSION_ID,target:process.env.JOURNAL_HOOK_TARGET,token:process.env.JOURNAL_HOOK_TOKEN})+'\\n');
console.log('TASK '+(process.argv.at(-1)||'').split('\\n').at(-1));
process.stdin.setRawMode(true);process.stdin.resume();`;
  writeFileSync(resolve(bin, 'claude'), fixture); chmodSync(resolve(bin, 'claude'), 0o755);
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const cleanup = () => {
    for (const { pid } of launches()) { try { if (execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(root)) process.kill(pid, 'SIGKILL'); } catch {} }
    try { const info = JSON.parse(readFileSync(resolve(root, 'data/runtime.json'), 'utf8')); if (execFileSync('ps', ['-p', String(info.pid), '-o', 'command='], { encoding: 'utf8' }).includes('runtime.mjs')) process.kill(info.pid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { root, project, env, cleanup };
}

async function open(env: Record<string, string>, project: string, { hooks = true } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
  // Spies on the real OS calls: they record (and swallow) anything that would reach the OS.
  await app.evaluate(({ app: electronApp, Notification, BrowserWindow }) => {
    const g = globalThis as any; g.__osCalls = [];
    Notification.prototype.show = function () { g.__osCalls.push('notification.show'); };
    electronApp.setBadgeCount = (count: number) => { g.__osCalls.push(`setBadgeCount:${count}`); return true; };
    if (electronApp.dock) electronApp.dock.setBadge = (text: string) => { g.__osCalls.push(`dock.setBadge:${text}`); };
    BrowserWindow.prototype.flashFrame = function (flag: boolean) { g.__osCalls.push(`flashFrame:${flag}`); };
  });
  const page = await app.firstWindow();
  if (!hooks) return { app, page };
  // Capture notifications, the badge and focus-session events; report the window as unfocused.
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as any;
    g.__notifications = []; g.__badges = []; g.__focusEvents = [];
    g.__journalNotification = class {
      options: any; shown = false; closed = false; handlers: Record<string, () => void> = {};
      constructor(options: any) { this.options = options; g.__notifications.push(this); }
      show() { this.shown = true; } close() { this.closed = true; }
      on(name: string, fn: () => void) { this.handlers[name] = fn; return this; }
    };
    g.__journalBadge = (count: number) => g.__badges.push(count);
    g.__journalFocused = () => false;
    const contents = BrowserWindow.getAllWindows()[0].webContents; const send = contents.send.bind(contents);
    contents.send = (channel: string, ...args: any[]) => { if (args[0]?.type === 'focus-session') g.__focusEvents.push(args[0]); return send(channel, ...args); };
  });
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; }
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(resolveWait => setTimeout(resolveWait, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
const sessionButton = (page: Page, task: string) => page.getByRole('button', { name: new RegExp(`: ${task}\\.`) });
const notifications = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__notifications.map((n: any) => ({ ...n.options, shown: n.shown, closed: n.closed })));
const badges = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__badges as number[]);

async function startClaude(page: Page, task: string) {
  await startSession(page, 'claude', { task: task });
  await expect(page.locator('.terminal-surface')).toContainText(`TASK ${task}`);
  const live = await page.evaluate(async () => (await (window as any).journal.request('sessions')).live);
  // Exactly one live session carries this task as its title.
  const matches = live.filter((session: any) => session.title === task);
  expect(matches).toHaveLength(1);
  return matches[0];
}

// Plays one Claude hook event through Journal's own launcher, settings file and hook script,
// with the observer values the fixture CLI received in its environment (as Claude passes them on).
function hook(env: Record<string, string>, root: string, project: string, session: { id: string; nativeId: string }, event: string, fields: Record<string, unknown> = {}) {
  const settings = JSON.parse(readFileSync(resolve(root, 'data/observers', `${session.id}.settings.json`), 'utf8'));
  const command = settings.hooks[event][0].hooks[0].command as string;
  const launch = readFileSync(resolve(root, 'launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(row => row.session === session.id);
  const observer = { JOURNAL_SESSION_ID: session.id, JOURNAL_HOOK_TARGET: launch.target, JOURNAL_HOOK_TOKEN: launch.token };
  execFileSync('/bin/sh', ['-c', command], { input: JSON.stringify({ hook_event_name: event, session_id: session.nativeId, cwd: project, ...fields }), env: { ...env, ...observer }, stdio: ['pipe', 'ignore', 'ignore'] });
}
const bash = (toolUseId: string) => ({ tool_name: 'Bash', tool_use_id: toolUseId, tool_input: { command: COMMAND } });

test('an unfocused window gets one notification per episode, without the command, and the badge follows', async () => {
  const f = setup('notify'); const { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    const session = await startClaude(page, 'NOTIFY_A');
    expect(session?.nativeId).toBeTruthy();
    hook(f.env, f.root, f.project, session, 'PreToolUse', bash('t1'));
    hook(f.env, f.root, f.project, session, 'PermissionRequest', bash('t1'));
    await expect.poll(() => badges(app)).toEqual([1]);
    // A second stacked prompt in the same episode.
    hook(f.env, f.root, f.project, session, 'PreToolUse', bash('t2'));
    hook(f.env, f.root, f.project, session, 'PermissionRequest', bash('t2'));
    await expect.poll(async () => (await notifications(app)).length).toBe(1);
    const [first] = await notifications(app);
    expect(first).toMatchObject({ title: 'Claude needs approval', shown: true, closed: false, silent: false });
    expect(first.body).toMatch(/NOTIFY_A/);
    expect(first.body).not.toContain('npm publish');
    expect(first.body).not.toContain('API_KEY');

    hook(f.env, f.root, f.project, session, 'PostToolUse', bash('t1'));
    hook(f.env, f.root, f.project, session, 'PostToolUse', bash('t2'));
    await expect.poll(() => badges(app)).toEqual([1, 0]);
    expect((await notifications(app))[0].closed).toBe(true);

    // Opting in through Settings shows the (redacted) command in the next episode.
    await openSettings(page, 'notifications');
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('checkbox', { name: 'Show the command in notifications' }).check();
    await expect(settings.getByRole('checkbox', { name: 'Show the command in notifications' })).toBeChecked();
    await expect.poll(() => JSON.parse(readFileSync(resolve(f.root, 'data/preferences.json'), 'utf8'))).toEqual({ notifications: true, notificationCommand: true, coordinatedRuns: false });
    await settings.getByRole('button', { name: 'Done', exact: true }).click();
    hook(f.env, f.root, f.project, session, 'PreToolUse', bash('t3'));
    hook(f.env, f.root, f.project, session, 'PermissionRequest', bash('t3'));
    await expect.poll(async () => (await notifications(app)).length).toBe(2);
    const second = (await notifications(app))[1];
    expect(second.body).toContain('npm publish');
    expect(second.body).not.toContain('FIXTURE_SECRET');

    // Turning notifications off: the next episode is silent; the badge still counts it.
    hook(f.env, f.root, f.project, session, 'PostToolUse', bash('t3'));
    await openSettings(page, 'notifications');
    await settings.getByRole('checkbox', { name: 'Notify me when Claude needs approval' }).uncheck();
    await expect(settings.getByRole('checkbox', { name: 'Show the command in notifications' })).toBeDisabled();
    await expect.poll(() => JSON.parse(readFileSync(resolve(f.root, 'data/preferences.json'), 'utf8')).notifications).toBe(false);
    await settings.getByRole('button', { name: 'Done', exact: true }).click();
    hook(f.env, f.root, f.project, session, 'PreToolUse', bash('t4'));
    hook(f.env, f.root, f.project, session, 'PermissionRequest', bash('t4'));
    await expect.poll(() => badges(app)).toEqual([1, 0, 1, 0, 1]);
    expect(await notifications(app)).toHaveLength(2);
    expect(await app.evaluate(() => (globalThis as any).__osCalls)).toEqual([]);
  } finally { await closeApp(app); f.cleanup(); }
});

test('a headless run without test hooks never reaches the OS notification, badge or taskbar', async () => {
  const f = setup('notify-headless'); const { app, page } = await open(f.env, f.project, { hooks: false });
  try {
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    const session = await startClaude(page, 'HEADLESS_A');
    hook(f.env, f.root, f.project, session, 'PreToolUse', bash('h1'));
    hook(f.env, f.root, f.project, session, 'PermissionRequest', bash('h1'));
    // The main process updates the notifier before it forwards the status to the renderer.
    await expect.poll(async () => (await page.evaluate(async () => (await (window as any).journal.request('sessions')).live)).find((s: any) => s.id === session.id)?.status).toBe('waiting');
    // Give an (incorrect) notification time to read the session name and show.
    await page.waitForTimeout(1000);
    expect(await app.evaluate(() => (globalThis as any).__osCalls)).toEqual([]);
    hook(f.env, f.root, f.project, session, 'PostToolUse', bash('h1'));
    await expect.poll(async () => (await page.evaluate(async () => (await (window as any).journal.request('sessions')).live)).find((s: any) => s.id === session.id)?.status).not.toBe('waiting');
    expect(await app.evaluate(() => (globalThis as any).__osCalls)).toEqual([]);
  } finally { await closeApp(app); f.cleanup(); }
});

test('clicking the notification sends focus-session for its session', async () => {
  const f = setup('notify-click'); const { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    const first = await startClaude(page, 'CLICK_A');
    await startClaude(page, 'CLICK_B');
    await expect(sessionButton(page, 'CLICK_B')).toHaveAttribute('aria-current', 'true');
    hook(f.env, f.root, f.project, first, 'PreToolUse', bash('c1'));
    hook(f.env, f.root, f.project, first, 'PermissionRequest', bash('c1'));
    await expect.poll(async () => (await notifications(app)).length).toBe(1);
    await app.evaluate(() => (globalThis as any).__notifications[0].handlers.click());
    await expect.poll(() => app.evaluate(() => (globalThis as any).__focusEvents)).toEqual([{ type: 'focus-session', sessionId: first.id }]);
    // The hidden test window stays hidden: the click focuses only a visible window.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  } finally { await closeApp(app); f.cleanup(); }
});

test('clicking the notification selects its session in the renderer, but not while a dialog is open', async () => {
  const f = setup('notify-select'); const { app, page } = await open(f.env, f.project);
  try {
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    const first = await startClaude(page, 'SELECT_A');
    await startClaude(page, 'SELECT_B');
    await expect(sessionButton(page, 'SELECT_B')).toHaveAttribute('aria-current', 'true');
    hook(f.env, f.root, f.project, first, 'PreToolUse', bash('s1'));
    hook(f.env, f.root, f.project, first, 'PermissionRequest', bash('s1'));
    await expect.poll(async () => (await notifications(app)).length).toBe(1);
    // An open dialog owns the window: the click must not switch the session behind it.
    await manageProject(app, page, 'notify project');
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await app.evaluate(() => (globalThis as any).__notifications[0].handlers.click());
    await expect.poll(() => app.evaluate(() => (globalThis as any).__focusEvents.length)).toBe(1);
    await page.waitForTimeout(300);
    await expect(sessionButton(page, 'SELECT_B')).toHaveAttribute('aria-current', 'true');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await app.evaluate(() => (globalThis as any).__notifications[0].handlers.click());
    await expect(sessionButton(page, 'SELECT_A')).toHaveAttribute('aria-current', 'true');
  } finally { await closeApp(app); f.cleanup(); }
});
