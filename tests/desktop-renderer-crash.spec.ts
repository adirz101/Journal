import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { fixtureEnv } from './support/env';
import { expectAccessible, expectVisibleFocus } from './support/a11y';
import { setTheme, startSession, taskBox } from './support/ui';

// Phase 9 part 2: a lost renderer process (render-process-gone) no longer leaves the window
// blank. Main shows a plain page, "Something went wrong" with one sentence and Reload (focused);
// Reload loads the app again, which reopens the project and reattaches its running sessions.
// Nothing is resent: the fixture agent records every launch, and the ledger is unchanged.
// Real Electron, runtime and node-pty with a fixture CLI; hidden windows, no notifications.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`));
  const project = resolve(root, 'crash project'); const bin = resolve(root, 'bin'); const home = resolve(root, 'home');
  for (const dir of [project, bin, home]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# Crash fixture\n'); git('add', '.'); git('commit', '-qm', 'init');
  const ledger = resolve(root, 'launches.jsonl');
  // Prints its task and echoes each typed line, so a test sees keys reach the same process.
  const fixture = `#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})+'\\n');
console.log('TASK '+(process.argv.at(-1)||'').split('\\n').at(-1));process.stdin.setRawMode(true);let line='';
process.stdin.on('data',d=>{for(const c of d.toString()){if(c==='\\r'){process.stdout.write('\\r\\nECHO '+line+' FROM '+process.pid+'\\r\\n');line=''}else line+=c}});`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env = fixtureEnv({ root, bin, home, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  delete env.ELECTRON_RUN_AS_NODE;
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { pid: number; argv: string[] }) : [];
  const cleanup = () => {
    for (const pid of launches().map(entry => entry.pid)) { try { if (execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(root)) process.kill(pid, 'SIGKILL'); } catch {} }
    try { const info = JSON.parse(readFileSync(resolve(root, 'data/runtime.json'), 'utf8')); if (execFileSync('ps', ['-p', String(info.pid), '-o', 'command='], { encoding: 'utf8' }).includes('runtime.mjs')) process.kill(info.pid, 'SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { root, project, env, launches, cleanup };
}

async function open(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    (globalThis as any).__journalFocused = () => true; // counts as focused: no OS notification
  }, project);
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
const crashRenderer = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); });
// '' while the frame is being replaced (between the lost renderer and the next page).
const frameUrl = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => { try { return BrowserWindow.getAllWindows()[0].webContents.mainFrame.url; } catch { return ''; } });
const rendererPid = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
// Playwright's page stays "crashed" after its renderer is lost, so the window's new renderer is
// read and driven from the main process: script through executeJavaScript, keys through
// sendInputEvent, as the operating system delivers them.
const inWindow = <T>(app: ElectronApplication, code: string): Promise<T> => app.evaluate(({ BrowserWindow }, js) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js), code);
const keys = (app: ElectronApplication, events: { type: 'keyDown' | 'char' | 'keyUp'; keyCode: string }[]) => app.evaluate(({ BrowserWindow }, list) => { const w = BrowserWindow.getAllWindows()[0].webContents; for (const event of list) w.sendInputEvent(event); }, events);
const pressEnter = (app: ElectronApplication) => keys(app, [{ type: 'keyDown', keyCode: 'Enter' }, { type: 'char', keyCode: '\r' }, { type: 'keyUp', keyCode: 'Enter' }]);
const typeText = (app: ElectronApplication, text: string) => keys(app, [...text].map(char => ({ type: 'char' as const, keyCode: char })));
// The accessibility helpers take a Page; this one evaluates in the window's current renderer.
const windowPage = (app: ElectronApplication) => ({ evaluate: (fn: (arg?: unknown) => unknown, arg?: unknown) => inWindow(app, `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`) }) as unknown as Page;
const crashText = (app: ElectronApplication) => inWindow<string>(app, 'document.body ? document.body.innerText : ""').catch(() => '');
const focusedText = (app: ElectronApplication) => inWindow<string>(app, 'document.activeElement ? document.activeElement.textContent : ""');

const showsCrashPage = async (app: ElectronApplication) => {
  await expect.poll(() => frameUrl(app), { timeout: 15000 }).toMatch(/^data:text\/html/);
  await expect.poll(() => crashText(app)).toContain('Something went wrong');
};
const showsApp = async (app: ElectronApplication) => {
  await expect.poll(() => frameUrl(app), { timeout: 15000 }).toMatch(/dist\/index\.html$/);
  await expect.poll(() => inWindow<string>(app, 'document.querySelector(".project-switcher .project-name")?.textContent ?? ""').catch(() => ''), { timeout: 15000 }).toBe('crash project');
};

for (const theme of ['dark', 'light'] as const) {
  test(`a crashed renderer shows Something went wrong with Reload (${theme}); Reload reopens the project and reattaches its sessions; nothing is resent`, async () => {
    const f = setup(`renderer-crash-${theme}`); const { app, page } = await open(f.env, f.project);
    try {
      await setTheme(page, theme);
      await startSession(page, 'claude', { task: 'SURVIVES_ONE' });
      await expect(page.locator('.terminal-surface')).toContainText('TASK SURVIVES_ONE');
      await startSession(page, 'codex', { task: 'SURVIVES_TWO' });
      await expect(page.locator('.terminal-surface')).toContainText('TASK SURVIVES_TWO');
      const ledger = f.launches(); expect(ledger).toHaveLength(2);
      const before = await rendererPid(app);

      await crashRenderer(app);
      await showsCrashPage(app);
      expect(await rendererPid(app)).not.toBe(before);
      const text = await crashText(app);
      expect(text).toContain('Journal’s window stopped unexpectedly; running sessions were not affected.');
      expect(await inWindow(app, '[...document.querySelectorAll("h1")].map(h => h.textContent)')).toEqual(['Something went wrong']);
      // One next step, focused, with a visible ring; names and contrast pass; the page uses the
      // chosen appearance (--bg) and nothing on it animates.
      expect(await inWindow(app, '[...document.querySelectorAll("button,a,input")].map(b => b.textContent)')).toEqual(['Reload']);
      expect(await focusedText(app)).toBe('Reload');
      await expectVisibleFocus(windowPage(app));
      await expectAccessible(windowPage(app), 'Renderer crash page');
      expect(await inWindow(app, 'getComputedStyle(document.body).backgroundColor')).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(15, 17, 21)');
      expect(await inWindow(app, 'document.getAnimations().length')).toBe(0);
      // App shortcuts reach no app here and change nothing.
      await pressKey(app, process.platform === 'darwin' ? 'K' : 'P', process.platform === 'darwin' ? ['meta'] : ['control', 'shift']);
      expect(await crashText(app)).toContain('Something went wrong');
      expect(f.launches()).toEqual(ledger);

      // Reload with the keyboard: Enter on the focused button.
      await pressEnter(app);
      await showsApp(app);
      // Both sessions are still live in the sidebar, and the shown one reattached with its output.
      await expect.poll(() => inWindow<string>(app, 'document.querySelector(".sidebar")?.innerText ?? ""'), { timeout: 15000 }).toMatch(/SURVIVES_ONE[\s\S]*SURVIVES_TWO|SURVIVES_TWO[\s\S]*SURVIVES_ONE/);
      await expect.poll(() => inWindow<string>(app, 'document.querySelector(".terminal-surface")?.textContent ?? ""'), { timeout: 15000 }).toMatch(/TASK SURVIVES_(ONE|TWO)/);
      expect(await inWindow(app, 'document.documentElement.dataset.theme')).toBe(theme);
      // Typing reaches the same agent process (no new launch).
      const shown = await inWindow<string>(app, 'document.querySelector(".terminal-surface").textContent');
      const shownPid = shown.includes('TASK SURVIVES_TWO') ? ledger[1].pid : ledger[0].pid;
      await expect(async () => {
        await inWindow(app, 'document.querySelector(".terminal-surface .xterm-helper-textarea").focus()');
        await typeText(app, 'hello'); await pressEnter(app);
        await expect.poll(() => inWindow<string>(app, 'document.querySelector(".terminal-surface").textContent'), { timeout: 2000 }).toContain(`ECHO hello FROM ${shownPid}`);
      }).toPass({ timeout: 20000 });
      expect(f.launches()).toEqual(ledger); // nothing was resent
    } finally { await closeApp(app); f.cleanup(); }
  });
}

test('every crash shows the page again, and the crash page navigates nowhere else', async () => {
  const f = setup('renderer-crash-twice'); const { app } = await open(f.env, f.project);
  try {
    for (let round = 0; round < 2; round++) {
      await crashRenderer(app);
      await showsCrashPage(app);
      expect(await focusedText(app)).toBe('Reload');
      await pressEnter(app);
      await showsApp(app);
    }
    // Any other navigation from the crash page is refused, as everywhere else.
    await crashRenderer(app);
    await showsCrashPage(app);
    await inWindow(app, 'const form = document.querySelector("form"); form.action = "https://example.invalid/"; form.submit(); true');
    await new Promise(done => setTimeout(done, 500));
    expect(await frameUrl(app)).toMatch(/^data:text\/html/);
    expect(await crashText(app)).toContain('Something went wrong');
    expect(f.launches()).toHaveLength(0);
  } finally { await closeApp(app); f.cleanup(); }
});
