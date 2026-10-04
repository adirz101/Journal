import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { startSession } from './support/ui';
import { fixtureEnv } from './support/env';

// Phase 8 Group A: the main-process side of open-file search, the palette keys
// and menu items, Reconnect now and crash recovery, driven through the preload
// bridge. Real Electron, runtime and node-pty with fixture CLIs; hidden windows.
// The palette UI itself is Group B's (desktop-palette.spec.ts).
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`));
  const project = resolve(root, 'search project'); const bin = resolve(root, 'bin'); mkdirSync(project); mkdirSync(bin);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(resolve(project, 'src', 'core'), { recursive: true });
  writeFileSync(resolve(project, 'README.md'), '# Search fixture\n'); writeFileSync(resolve(project, 'src', 'core', 'terminal.mjs'), 'export {};\n');
  writeFileSync(resolve(project, '.gitignore'), 'ignored-output.log\n');
  git('add', '.'); git('commit', '-qm', 'init');
  writeFileSync(resolve(project, '.env'), 'API_TOKEN=do-not-read\n'); writeFileSync(resolve(project, 'id_rsa'), 'secret\n');
  writeFileSync(resolve(project, 'ignored-output.log'), 'ignored\n'); writeFileSync(resolve(project, 'untracked-notes.md'), 'notes\n');
  const ledger = resolve(root, 'launches.jsonl');
  const fixture = `#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})+'\\n');
console.log('TASK '+(process.argv.at(-1)||'').split('\\n').at(-1));process.stdin.setRawMode(true);process.stdin.resume();`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const runtimeInfo = () => JSON.parse(readFileSync(resolve(root, 'data/runtime.json'), 'utf8'));
  const cleanup = () => {
    for (const pid of launches().map(entry => entry.pid)) { try { if (execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(root)) process.kill(pid, 'SIGKILL'); } catch {} }
    try { const info = runtimeInfo(); if (execFileSync('ps', ['-p', String(info.pid), '-o', 'command='], { encoding: 'utf8' }).includes('runtime.mjs')) process.kill(info.pid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { root, project, env, launches, runtimeInfo, cleanup };
}

async function open(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; }
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(resolveWait => setTimeout(resolveWait, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
// One preload request, settled: { ok, value } or { ok: false, error }.
const settle = (page: Page, action: string, input: object = {}) => page.evaluate(([a, i]) => (window as any).journal.settle(a, i), [action, input] as const);
const request = async (page: Page, action: string, input: object = {}) => { const result = await settle(page, action, input); if (!result.ok) throw new Error(result.error); return result.value; };
const projectId = async (page: Page) => { await expect.poll(async () => (await request(page, 'bootstrap')).projects.length).toBe(1); return (await request(page, 'bootstrap')).projects[0].id as string; };
const paths = (result: any) => result.hits.map((hit: any) => hit.path);

test('open-file search runs in main from git ls-files, never lists sensitive or ignored files, and validates its input', async () => {
  const f = setup('search'); const { app, page } = await open(f.env, f.project);
  try {
    const id = await projectId(page);
    const search = (query: string, extra: object = {}) => request(page, 'searchFiles', { projectId: id, rootKey: 'checkout', query, ...extra });
    const readme = await search('readme');
    expect(readme).toMatchObject({ available: true, truncated: false });
    expect(paths(readme)[0]).toBe('README.md'); expect(readme.hits[0].spans).toEqual([[0, 6]]);
    expect(paths(await search('term'))).toEqual(['src/core/terminal.mjs']);
    expect(paths(await search('untracked'))).toEqual(['untracked-notes.md']);
    for (const query of ['env', 'rsa', 'ignored']) expect(paths(await search(query)), query).toEqual([]);
    expect(await search('')).toEqual({ available: true, hits: [], total: 0, truncated: false });
    expect((await search('m', { limit: 1 })).hits).toHaveLength(1);
    // Invalid input is refused in main; a root is only ever a key Journal resolves itself.
    for (const input of [{ projectId: id, rootKey: 'checkout', query: 7 }, { projectId: id, rootKey: 'checkout', query: 'x'.repeat(201) },
      { projectId: id, rootKey: 'checkout', query: 'a', limit: 'all' }, { projectId: id, rootKey: '../..', query: 'a' }, { projectId: 'nope', rootKey: 'checkout', query: 'a' },
      { projectId: id, rootKey: '/etc', query: 'a' }]) {
      expect((await settle(page, 'searchFiles', input)).ok, JSON.stringify(input).slice(0, 80)).toBe(false);
    }
    // The listing is cached; a watched root marks it stale when a file appears, and a refresh finds the file (no recursive watching on Linux).
    if (process.platform !== 'linux') {
      await request(page, 'watchRoot', { projectId: id, rootKey: 'checkout' });
      writeFileSync(resolve(f.project, 'fresh-file.md'), 'new\n');
      await expect.poll(async () => paths(await search('fresh')), { timeout: 10000 }).toEqual(['fresh-file.md']);
    }
  } finally { await closeApp(app); f.cleanup(); }
});

test('the palette keys and View menu items send their commands', async () => {
  const f = setup('palette-keys'); const { app, page } = await open(f.env, f.project);
  try {
    await projectId(page);
    const mac = process.platform === 'darwin';
    const dialog = (name: string) => page.getByRole('dialog', { name });
    await pressKey(app, mac ? 'K' : 'P', mac ? ['meta'] : ['control', 'shift']);
    await expect(dialog('Command palette')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog('Command palette')).toHaveCount(0);
    await pressKey(app, mac ? 'P' : 'O', mac ? ['meta'] : ['control', 'shift']);
    await expect(dialog('Open a file')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog('Open a file')).toHaveCount(0);
    if (mac) { await pressKey(app, 'P', ['meta', 'shift']); await expect(dialog('Command palette')).toBeVisible(); await page.keyboard.press('Escape'); }
    for (const [id, name] of [['command-palette', 'Command palette'], ['open-file', 'Open a file']]) {
      await app.evaluate(({ Menu }, item) => { Menu.getApplicationMenu()!.getMenuItemById(item)!.click(); }, id);
      await expect(dialog(name)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog(name)).toHaveCount(0);
    }
  } finally { await closeApp(app); f.cleanup(); }
});

test('after a forced runtime kill, bootstrap and the runtime event carry the recovery until it is acknowledged', async () => {
  // keep: quitting leaves the (idle) runtime running, so a restarted app reconnects to the same one.
  const f = setup('recovery'); const env = { ...f.env, JOURNAL_QUIT_POLICY: 'keep' }; let { app, page } = await open(env, f.project);
  try {
    await projectId(page);
    expect((await request(page, 'bootstrap')).recovery).toBeNull();
    expect(await request(page, 'reconnectRuntime')).toEqual({ retrying: false });
    await startSession(page, 'codex', { task: 'RECOVER_ME' });
    await expect(page.locator('.terminal-surface')).toContainText('TASK RECOVER_ME');
    const { live } = await request(page, 'sessions'); const sessionId = live[0].id;
    await page.evaluate(() => { const w = window as any; w.__runtimeEvents = []; w.journal.onEvent((event: any) => { if (event.type === 'runtime') w.__runtimeEvents.push(event); }); });
    const before = f.runtimeInfo(); process.kill(before.pid, 'SIGKILL');
    await expect.poll(() => page.evaluate(() => (window as any).__runtimeEvents.find((event: any) => event.state === 'connected')?.recovery?.sessions ?? null), { timeout: 20000 })
      .toEqual([{ id: sessionId, status: 'interrupted', identityVerified: null }]);
    const { recovery } = await request(page, 'bootstrap');
    expect(recovery.sessions).toEqual([{ id: sessionId, status: 'interrupted', identityVerified: null }]);
    expect(recovery.runtimeId).toBe(f.runtimeInfo().runtimeId); expect(recovery.runtimeId).not.toBe(before.runtimeId);
    expect(f.launches()).toHaveLength(1); // nothing was resent
    // A stale acknowledgement changes nothing; a reload still offers the recovery.
    expect(await request(page, 'acknowledgeRecovery', { at: '2000-01-01T00:00:00.000Z' })).toEqual({ cleared: false });
    expect((await settle(page, 'acknowledgeRecovery', { at: 5 })).ok).toBe(false);
    await page.reload(); await projectId(page);
    expect((await request(page, 'bootstrap')).recovery).toEqual(recovery);
    expect(await request(page, 'acknowledgeRecovery', { at: recovery.at })).toEqual({ cleared: true });
    expect((await request(page, 'bootstrap')).recovery).toBeNull();
    // A restarted app connecting to the same runtime gets no recovery either.
    const runtimeId = f.runtimeInfo().runtimeId;
    await closeApp(app);
    ({ app, page } = await open(env, f.project));
    await projectId(page);
    expect(f.runtimeInfo().runtimeId).toBe(runtimeId);
    expect((await request(page, 'bootstrap')).recovery).toBeNull();
    expect(f.launches()).toHaveLength(1);
  } finally { await closeApp(app); f.cleanup(); }
});
