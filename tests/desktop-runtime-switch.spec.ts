import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, appendFileSync, symlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sessionStatus, skipFirstRun, startSession, newSession, taskBox, inspectorTab } from './support/ui';
import { fixtureEnv } from './support/env';

// Sessions kept running across an update stay in the other build's runtime; Journal switches to
// its own runtime once they end, or at once with Switch now. "Another build" is a copy of this
// app whose runtime code differs by a comment (the build is a hash of the runtime's own files).
test.skip(process.platform === 'win32', 'POSIX fixture CLI');

function setup(name: string, legacyEnvironments = false) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`)); const project = resolve(root, 'project'); const bin = resolve(root, 'bin'); const other = resolve(root, 'other-build');
  for (const dir of [project, bin]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'keep' } });
  execFileSync('git', ['init', '-q', '-b', 'main', project], { env }); writeFileSync(resolve(project, 'README.md'), '# p\n');
  execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', 'add', '.'], { env }); execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init'], { env });
  // An agent that stays until stopped and echoes what it is sent.
  writeFileSync(resolve(bin, 'claude'), `#!${process.execPath}
if(process.argv[2]==='--version'){console.log('2.1.286 (Claude Code)');process.exit(0)}
console.log('AGENT READY');process.stdin.resume();`);
  chmodSync(resolve(bin, 'claude'), 0o755);
  // The other build: this app's files, with one runtime file changed.
  mkdirSync(other);
  for (const part of ['package.json', 'src', 'dist', 'assets']) cpSync(resolve(part), resolve(other, part), { recursive: true });
  symlinkSync(resolve('node_modules'), resolve(other, 'node_modules'));
  appendFileSync(resolve(other, 'src/runtime/protocol.mjs'), '\n// another build\n');
  if (legacyEnvironments) {
    const file = resolve(other, 'src/runtime/runtime.mjs');
    writeFileSync(file, readFileSync(file, 'utf8')
      .replace('environmentSync: true', 'environmentSync: false')
      .replaceAll('environments.reconcile()', 'Promise.resolve()')
      .replace("if (event.type === 'status') void environments.follow(event.session);", '// Legacy fixture has no environment follower.'));
  }
  const runtimeInfo = () => JSON.parse(readFileSync(resolve(root, 'data/runtime.json'), 'utf8')) as { pid: number; runtimeId: string; build?: string };
  const pids = new Set<number>();
  const remember = () => { try { pids.add(runtimeInfo().pid); } catch {} };
  const cleanup = () => {
    remember();
    for (const pid of pids) { try { if (execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes('runtime.mjs')) process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(root, { recursive: true, force: true });
  };
  return { root, project, env, other, runtimeInfo, remember, cleanup };
}

async function launch(f: ReturnType<typeof setup>, appDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [appDir], env: f.env });
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, f.project);
  return { app, page: await app.firstWindow() };
}

// The other build starts a session and quits, keeping it running.
async function sessionInOtherBuild(f: ReturnType<typeof setup>) {
  const { app, page } = await launch(f, f.other);
  await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
  await skipFirstRun(page);
  await startSession(page, 'claude', { task: '' });
  await expect(page.locator('.xterm-rows')).toContainText('AGENT READY', { timeout: 20000 });
  f.remember(); const before = f.runtimeInfo();
  await app.close();
  return before;
}

test('a session kept running across an update stays; once it ends Journal switches to this build', async () => {
  const f = setup('runtime-switch');
  try {
    const before = await sessionInOtherBuild(f);
    const { app, page } = await launch(f, '.');
    try {
      const notice = page.locator('.runtime-notice');
      await expect(notice).toContainText('Running sessions use another version of Journal', { timeout: 20000 });
      await expect(notice.getByRole('button', { name: 'Switch now…' })).toBeVisible();
      // The session is the same one, still running in the other build's runtime.
      await expect(page.locator('.xterm-rows')).toContainText('AGENT READY');
      await page.waitForTimeout(2500);
      expect(f.runtimeInfo().runtimeId).toBe(before.runtimeId);
      // It ends: Journal replaces that runtime with its own, without a quit.
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(sessionStatus(page)).not.toContainText(/Running|Your turn|Working/, { timeout: 15000 });
      await expect.poll(() => { try { return f.runtimeInfo().runtimeId !== before.runtimeId; } catch { return false; } }, { timeout: 20000 }).toBe(true);
      f.remember();
      await expect(notice).toHaveCount(0, { timeout: 20000 });
      await expect(page.getByText('Runtime connected')).toBeVisible();
    } finally { await app.close().catch(() => {}); }
  } finally { f.cleanup(); }
});

test('Switch now stops the other build\'s sessions after confirming and switches at once', async () => {
  const f = setup('runtime-switch-now');
  try {
    const before = await sessionInOtherBuild(f);
    const { app, page } = await launch(f, '.');
    try {
      const notice = page.locator('.runtime-notice');
      await expect(notice).toBeVisible({ timeout: 20000 });
      // Cancel first: nothing changes.
      await app.evaluate(() => { (globalThis as any).__journalSwitchDialog = 1; });
      await notice.getByRole('button', { name: 'Switch now…' }).click();
      await page.waitForTimeout(1000);
      expect(f.runtimeInfo().runtimeId).toBe(before.runtimeId);
      await app.evaluate(() => { (globalThis as any).__journalSwitchDialog = 0; });
      await notice.getByRole('button', { name: 'Switch now…' }).click();
      await expect.poll(() => { try { return f.runtimeInfo().runtimeId !== before.runtimeId; } catch { return false; } }, { timeout: 20000 }).toBe(true);
      f.remember();
      await expect(notice).toHaveCount(0, { timeout: 20000 });
      // The stopped session can be continued in this build.
      await expect(page.getByRole('button', { name: /^Continue/ }).first()).toBeVisible({ timeout: 15000 });
      expect(existsSync(resolve(f.root, 'data/runtime.json'))).toBe(true);
    } finally { await app.close().catch(() => {}); }
  } finally { f.cleanup(); }
});

test('an older kept runtime still captures an isolated result while another session remains live', async () => {
  const f = setup('runtime-legacy-environments', true);
  try {
    let { app, page } = await launch(f, f.other);
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    await skipFirstRun(page);
    await newSession(page);
    await page.getByRole('checkbox', { name: 'Isolated' }).check();
    await taskBox(page).fill('legacy isolated worker');
    await page.getByRole('button', { name: /^Start Claude Code/ }).click();
    await expect(page.locator('.xterm-rows')).toContainText('AGENT READY');
    await startSession(page, 'claude', { task: 'keep runtime alive' });
    await expect(page.locator('.xterm-rows')).toContainText('AGENT READY');
    f.remember(); const before = f.runtimeInfo();
    await app.close();
    ({ app, page } = await launch(f, '.'));
    try {
      await expect(page.locator('.runtime-notice')).toBeVisible();
      await page.getByRole('button', { name: /legacy isolated worker/ }).first().click();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await inspectorTab(page, 'Session');
      await expect(page.locator('.environment-panel')).toContainText('Done.', { timeout: 15000 });
      expect(f.runtimeInfo().runtimeId).toBe(before.runtimeId);
    } finally { await app.close().catch(() => {}); }
  } finally { f.cleanup(); }
});
