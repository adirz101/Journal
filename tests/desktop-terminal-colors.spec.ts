import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openSettings, setTheme, skipFirstRun, startSession } from './support/ui';
import { fixtureEnv } from './support/env';

// Terminal colour queries (OSC 10/11, DA1) and the COLORFGBG hint, with a fixture
// "claude" that asks for the background the way Claude Code, Codex and Cursor do.
// Isolated by fixtureEnv (tests/support/env.ts): PATH holds only the fixture and a few
// system tools, HOME is empty, and no provider variable is passed on.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs');

const LIGHT_BG = 'rgb:fafa/fafa/fbfb'; const DARK_BG = 'rgb:0b0b/0d0d/1010';
type Line = { kind: string; data: string; ms: number; session: string };

function setup() {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'colors-')); const project = resolve(root, 'project'); const bin = resolve(root, 'bin'); const home = resolve(root, 'home');
  for (const dir of [project, bin, home]) mkdirSync(dir);
  // The fixture CLI is CommonJS; the repository's package.json says module.
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const env = fixtureEnv({ root, bin, home, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe', env });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# Colours fixture\n'); git('add', '.'); git('commit', '-qm', 'init');
  const log = resolve(root, 'stdin.jsonl');
  // Records COLORFGBG and every byte it reads; asks for the background (OSC 11, then the
  // DA1 sentinel Claude Code uses) at start, and again on each mode 2031 theme report.
  writeFileSync(resolve(bin, 'claude'), `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('2.1.286 (Claude Code)');process.exit(0)}
const t0=Date.now();const rec=(kind,data)=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({kind,data,ms:Date.now()-t0,session:process.env.JOURNAL_SESSION_ID})+'\\n');
const {env:fixtureEnvironment}=process;rec('env',fixtureEnvironment.COLORFGBG??''); // the fixture's own environment, as Journal set it
const ask=()=>process.stdout.write('\\x1b]11;?\\x07\\x1b[c');
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',d=>{const s=d.toString('latin1');rec('stdin',s);if(s.includes('\\x1b[?997;'))ask();});
process.stdout.write('COLORS_READY\\r\\n\\x1b[?2031h');ask();`);
  chmodSync(resolve(bin, 'claude'), 0o755);
  const lines = (): Line[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  // Everything one session (or, without an ID, every session) read on stdin.
  const input = (session?: string) => lines().filter(line => line.kind === 'stdin' && (!session || line.session === session)).map(line => line.data).join('');
  return { root, project, env, lines, input, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function open(f: ReturnType<typeof setup>, theme: 'dark' | 'light') {
  const app = await electron.launch({ args: ['.'], env: f.env });
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, f.project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
  await skipFirstRun(page);
  await setTheme(page, theme);
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => { await app.close().catch(() => {}); };
const ready = (page: Page) => expect(page.locator('.xterm-rows')).toContainText('COLORS_READY', { timeout: 15000 });
const replies = (input: string, code: number) => [...input.matchAll(new RegExp(`\\x1b\\]${code};([^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\)`, 'g'))].map(match => match[1]);
const da1 = (input: string) => input.match(/\x1b\[\?[\d;]*c/g)?.length ?? 0;

for (const theme of ['light', 'dark'] as const) {
  test(`the startup background query gets the ${theme} colour at once, and COLORFGBG says ${theme}`, async () => {
    const f = setup(); const { app, page } = await open(f, theme);
    try {
      await startSession(page, 'claude');
      await ready(page);
      await expect.poll(() => replies(f.input(), 11)).toEqual([theme === 'light' ? LIGHT_BG : DARK_BG]);
      await expect.poll(() => da1(f.input())).toBe(1);
      expect(f.lines().find(line => line.kind === 'env')?.data).toBe(theme === 'light' ? '0;15' : '15;0');
      // Answered quickly, however late the window attaches (Cursor waits 60 ms; the bound leaves room for a loaded machine).
      expect(f.lines().find(line => line.kind === 'stdin' && line.data.includes('\x1b]11;'))!.ms).toBeLessThan(200);
    } finally { await closeApp(app); f.cleanup(); }
  });
}

test('a reattach replays old queries without typing replies into the agent', async () => {
  const f = setup(); const { app, page } = await open(f, 'light');
  try {
    await startSession(page, 'claude');
    await ready(page);
    await expect.poll(() => da1(f.input())).toBe(1);
    const before = f.input();
    // A reload detaches every terminal; the session view attaches again and replays the buffer.
    await page.reload();
    await ready(page);
    await page.waitForTimeout(1500);
    expect(f.input()).toBe(before);
  } finally { await closeApp(app); f.cleanup(); }
});

test('switching the appearance reports it to an agent that asked, which then sees the new background', async () => {
  const f = setup(); const { app, page } = await open(f, 'light');
  try {
    await startSession(page, 'claude');
    await ready(page);
    await expect.poll(() => replies(f.input(), 11)).toEqual([LIGHT_BG]);
    // Switched in Settings: the agent asks again while the dialog is still open, and the window's
    // DA1 answer must still reach it (keys are dropped while a dialog is open; reports are not).
    await openSettings(page, 'appearance');
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('radio', { name: 'Dark', exact: true }).check();
    await expect.poll(() => f.input()).toContain('\x1b[?997;1n');
    await expect.poll(() => replies(f.input(), 11)).toEqual([LIGHT_BG, DARK_BG]);
    await expect.poll(() => da1(f.input())).toBe(2);
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Done', exact: true }).click();
    await setTheme(page, 'light');
    await expect.poll(() => f.input()).toContain('\x1b[?997;2n');
    await expect.poll(() => replies(f.input(), 11)).toEqual([LIGHT_BG, DARK_BG, LIGHT_BG]);
    // Every query got exactly one reply: one DA1 per question, no duplicates from the window.
    await expect.poll(() => da1(f.input())).toBe(3);
    await page.waitForTimeout(500);
    expect(replies(f.input(), 11)).toHaveLength(3);
  } finally { await closeApp(app); f.cleanup(); }
});

// The session's ID from the receipt the start returned (the fixture records JOURNAL_SESSION_ID).
const startHidden = (page: Page) => page.evaluate(async () => {
  const journal = (window as any).journal; const projectId = (await journal.request('projects'))[0].id;
  return (await journal.request('start', { projectId, provider: 'claude', task: '' })).session.id as string;
});

test('a session that no window shows still gets its background and DA1 answers, in light and in dark', async () => {
  const f = setup(); const { app, page } = await open(f, 'light');
  try {
    // Started over IPC, the session is not selected, so no terminal attaches to it.
    const id = await startHidden(page);
    await expect.poll(() => da1(f.input(id)), { timeout: 15000 }).toBe(1);
    expect(replies(f.input(id), 11)).toEqual([LIGHT_BG]);
    expect(f.lines().find(line => line.kind === 'env' && line.session === id)?.data).toBe('0;15');
    await setTheme(page, 'dark');
    const second = await startHidden(page);
    await expect.poll(() => da1(f.input(second)), { timeout: 15000 }).toBe(1);
    expect(replies(f.input(second), 11)).toEqual([DARK_BG]);
    expect(f.lines().find(line => line.kind === 'env' && line.session === second)?.data).toBe('15;0');
    // The first session was told about the switch and its new question was answered, unseen.
    await expect.poll(() => replies(f.input(id), 11)).toEqual([LIGHT_BG, DARK_BG]);
    expect(da1(f.input(id))).toBe(2);
  } finally { await closeApp(app); f.cleanup(); }
});

test('with a runtime that does not answer colour queries, the window still does', async () => {
  const f = setup(); const { app, page } = await open(f, 'light');
  try {
    // An earlier build's runtime: its attach has no colors flag. (This runtime still answers too, with
    // the fixture's BEL terminator; the window's terminal always answers with ST.)
    await app.evaluate(() => { (globalThis as any).__journalRequestHook = async (action: string, run: () => Promise<any>) => {
      const value = await run(); if (action === 'attach' && value) delete value.colors; return value;
    }; });
    await startSession(page, 'claude');
    await ready(page);
    // A slow machine may read the startup query before the window attaches, and the window never answers a
    // replayed query. The theme report makes the agent ask again while the window is attached.
    await setTheme(page, 'dark');
    await expect.poll(() => f.input()).toContain(`\x1b]11;${DARK_BG}\x1b\\`);
    expect(f.input()).toContain(`\x1b]11;${DARK_BG}\x07`);
  } finally { await closeApp(app); f.cleanup(); }
});
