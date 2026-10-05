import { test, expect, _electron as electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve, delimiter, extname, join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { fixtureEnv } from './support/env';
import { contextPreview, newSession, startSession, taskBox } from './support/ui';

// Phase 9 performance checks, measured on the React profiling build (npm run build:profile,
// served to the window from 127.0.0.1 like the development server). Fixture agents only.
// The numbers are printed and attached to the test result. Structural checks always run (no
// live-region change during a flood, the activity throttle's event count, commits reported).
// Timing bounds run only with JOURNAL_PERF_STRICT=1, on a quiet local machine:
//   npm run build:profile && JOURNAL_PERF_STRICT=1 npx playwright test tests/desktop-performance.spec.ts
// CI and release runs share loaded machines, and test windows are hidden, so the numbers there
// leave out real paint and compositing; they are reported, not asserted.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs');
test.describe.configure({ mode: 'serial' });
const strict = process.env.JOURNAL_PERF_STRICT === '1';

const PROFILE = resolve('.cache/dist-profile');
let server: Server; let url = '';
test.beforeAll(async () => {
  // Rebuild when the profiling build is missing or older than the renderer sources.
  // Files deleted in the working tree but still tracked count as 0.
  const mtime = (file: string) => { try { return statSync(file).mtimeMs; } catch { return 0; } };
  const newest = (dir: string): number => Math.max(0, ...execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', dir], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(mtime));
  if (!existsSync(join(PROFILE, 'index.html')) || statSync(join(PROFILE, 'index.html')).mtimeMs < Math.max(newest('src/ui'), statSync('index.html').mtimeMs)) {
    execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--mode', 'profile', '--logLevel', 'error'], { stdio: 'inherit' });
  }
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
  server = createServer((req, res) => {
    const path = normalize(join(PROFILE, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)));
    const file = path.startsWith(PROFILE) && existsSync(path) && statSync(path).isFile() ? path : join(PROFILE, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address(); url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});
test.afterAll(async () => { await new Promise(done => server?.close(done)); });

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`)); const bin = resolve(root, 'bin'); const project = resolve(root, 'perf project');
  for (const dir of [bin, project]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# Performance fixture\n'); git('add', '.'); git('commit', '-qm', 'init');
  const done = resolve(root, 'flood-done'); const started = resolve(root, 'flood-started');
  // flood <seconds>: about 2 MB/s of short lines in 4 KB chunks, then FLOOD_DONE (and a file, for when the terminal is not shown).
  const fixture = `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
const task=(process.argv.at(-1)||'').split('\\n').at(-1);console.log('TASK '+task);for(let i=0;i<40;i++)console.log('line '+i+' of '+task);
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let input='';
process.stdin.on('data',data=>{for(const char of data){
if(char!=='\\r'&&char!=='\\n'){input+=char;continue}
const command=input;input='';
if(command.startsWith('flood ')){const end=Date.now()+Number(command.slice(6))*1000;const chunk=('flood-line \\x1b[32mgreen\\x1b[0m '+'x'.repeat(40)+'\\r\\n').repeat(64);console.log('FLOOD_START');fs.writeFileSync(${JSON.stringify(started)},'1');
const tick=()=>{if(Date.now()>=end){console.log('FLOOD_DONE');fs.writeFileSync(${JSON.stringify(done)},'1');return}process.stdout.write(chunk,()=>setTimeout(tick,2))};tick()}
else console.log('ECHO '+command);
}});`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env = fixtureEnv(root, bin, { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop', JOURNAL_DEV_URL: url });
  return { root, project, env, floodDone: () => existsSync(done), floodStarted: () => existsSync(started), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function launch(f: ReturnType<typeof setup>) {
  const app = await electron.launch({ args: ['.'], env: f.env });
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); (globalThis as any).__journalFocused = () => true; }, f.project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
  await expect(taskBox(page)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => { await app.close().catch(() => {}); };
const typeLine = async (page: Page, text: string) => { await page.locator('.xterm-helper-textarea').pressSequentially(text); await page.locator('.xterm-helper-textarea').press('Enter'); };
const pct = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN; };
const ms = (value: number) => `${value.toFixed(1)} ms`;
function report(info: TestInfo, title: string, lines: string[]) {
  const text = `${title}\n${lines.map(line => `  ${line}`).join('\n')}`;
  console.log(text); void info.attach(title, { body: text, contentType: 'text/plain' });
}

test('a flooding session keeps the composer and its preview responsive; activity stays throttled', async ({}, info) => {
  test.setTimeout(90_000);
  const f = setup('perf-flood'); const { app, page } = await launch(f);
  try {
    const projectId = (await page.evaluate(() => (window as any).journal.request('bootstrap')) as any).projects[0].id;
    await page.evaluate(async id => {
      const journal = (window as any).journal;
      const note = await journal.request('proposeMemory', { projectId: id, input: { statement: 'Worktree removal refuses locked worktrees and keeps the branch', category: 'constraint', scope: 'checkout', area: '', source: { kind: 'user', note: 'Fixture' } } });
      await journal.request('setMemoryStatus', { id: note.id, status: 'active' });
      // Count every event the window receives, by type and session.
      const counts: Record<string, number> = {}; (window as any).__eventCounts = counts; (window as any).__activityTimes = [];
      journal.onEvent((event: any) => { counts[event.type] = (counts[event.type] ?? 0) + 1; if (event.type === 'activity') (window as any).__activityTimes.push(performance.now()); });
    }, projectId);
    // Codex reports output activity (Claude does not), so it exercises the throttle.
    await startSession(page, 'codex', { task: 'FLOOD_SOURCE' });
    await expect(page.locator('.terminal-surface')).toContainText('line 39 of FLOOD_SOURCE');

    // 1. The visible terminal floods: frame budget, and no live region changes per chunk.
    await page.evaluate(() => {
      const w = window as any; w.__frames = []; w.__liveMutations = 0;
      new PerformanceObserver(list => { for (const entry of list.getEntries()) w.__frames.push(entry.duration); }).observe({ type: 'long-animation-frame', buffered: false });
      const live = new MutationObserver(records => { w.__liveMutations += records.length; });
      for (const region of document.querySelectorAll('[aria-live]:not([aria-live=off]),[role=status],[role=alert],[role=log]')) live.observe(region, { childList: true, subtree: true, characterData: true });
    });
    const floodStart = Date.now();
    // The fixture marks the start in a file: on a slow machine the flood scrolls FLOOD_START out of
    // the visible rows before the page can be read, and typing again would start a second flood.
    await expect(async () => { if (!f.floodStarted()) await typeLine(page, 'flood 8'); await expect.poll(f.floodStarted, { timeout: 4000 }).toBe(true); }).toPass({ timeout: 15000 });
    await page.waitForTimeout(2500);
    const visible = await page.evaluate(() => { const w = window as any; return { frames: w.__frames as number[], live: w.__liveMutations as number }; });

    // 2. The composer while the session keeps flooding in the background.
    await newSession(page);
    await expect(taskBox(page)).toBeFocused();
    await page.evaluate(() => {
      const w = window as any; w.__keyLatency = []; w.__frames = [];
      document.addEventListener('keydown', event => { const start = event.timeStamp; requestAnimationFrame(() => { w.__keyLatency.push(performance.now() - start); }); }, { capture: true });
    });
    const typed = 'worktree removal for the release branch';
    await page.keyboard.type(typed, { delay: 35 });
    const typedAt = Date.now();
    await expect(taskBox(page)).toHaveValue(typed);
    await expect(contextPreview(page).getByRole('region', { name: 'Relevant to your task' })).toContainText('Worktree removal refuses locked worktrees', { timeout: 3000 });
    const previewMs = Date.now() - typedAt;
    const composer = await page.evaluate(() => { const w = window as any; return { latency: w.__keyLatency as number[], frames: w.__frames as number[] }; });
    await expect.poll(() => f.floodDone(), { timeout: 30000 }).toBe(true);
    const floodSeconds = (Date.now() - floodStart) / 1000;
    const events = await page.evaluate(() => ({ counts: (window as any).__eventCounts as Record<string, number>, activity: (window as any).__activityTimes as number[] }));
    const gaps = events.activity.slice(1).map((t, i) => t - events.activity[i]);

    report(info, 'Terminal flood (Codex fixture, about 2 MB/s for 8 s, 1440x900)', [
      `visible terminal: ${visible.frames.length} long animation frames (>50 ms) in 2.5 s, longest ${visible.frames.length ? ms(Math.max(...visible.frames)) : 'none'}; live-region mutations: ${visible.live}`,
      `composer during the flood: key-to-frame latency p50 ${ms(pct(composer.latency, 0.5))}, p95 ${ms(pct(composer.latency, 0.95))}, max ${ms(Math.max(...composer.latency))} over ${composer.latency.length} keys; long frames ${composer.frames.length}`,
      `preview showed the matching note ${previewMs} ms after the last key`,
      `events in ${floodSeconds.toFixed(1)} s: ${JSON.stringify(events.counts)}; activity gaps ${gaps.map(gap => `${(gap / 1000).toFixed(1)} s`).join(', ') || 'n/a'}`,
    ]);
    // No live region changes while output streams in (aria-live is never per terminal chunk).
    expect(visible.live, 'live-region mutations during the flood').toBe(0);
    // Typing stays responsive: target p95 under 50 ms from key to the next frame.
    // activity is throttled to one event per 5 s window per session (ACTIVITY_THROTTLE_MS).
    expect(events.counts.activity ?? 0).toBeLessThanOrEqual(Math.ceil(floodSeconds / 5) + 1);
    if (strict) {
      expect(pct(composer.latency, 0.95), 'key-to-frame p95 (target < 50 ms)').toBeLessThan(50);
      expect(previewMs, 'preview after the last key').toBeLessThan(1500);
      // Measured where the window receives them, so IPC jitter can shorten a gap below 5 s.
      for (const gap of gaps) expect(gap, 'gap between activity events').toBeGreaterThan(4000);
    }
  } finally { await closeApp(app); f.cleanup(); }
});

test('switching sessions commits in under 16 ms (React Profiler)', async ({}, info) => {
  test.setTimeout(90_000);
  const f = setup('perf-switch'); const { app, page } = await launch(f);
  const mac = process.platform === 'darwin'; const slot = [mac ? 'meta' : 'alt'] as const;
  try {
    for (const task of ['ONE', 'TWO', 'THREE', 'FOUR']) {
      await startSession(page, 'claude', { task: `SWITCH_${task}` });
      await expect(page.locator('.terminal-surface')).toContainText(`line 39 of SWITCH_${task}`);
    }
    const row = (n: number) => page.getByRole('button', { name: new RegExp(`: SWITCH_${['ONE', 'TWO', 'THREE', 'FOUR'][n - 1]}\\.`) });
    const commits = () => page.evaluate(() => (window as any).__journalCommits.splice(0) as { phase: string; actualDuration: number }[]);
    await page.evaluate(() => { (window as any).__journalCommits = []; });
    // A warm-up round so each terminal and its font are created once.
    for (const n of [1, 2, 3, 4]) {
      await expect(page.locator('main.workspace')).not.toHaveAttribute('aria-busy', 'true');
      await pressKey(app, String(n), [...slot]); await expect(row(n)).toHaveAttribute('aria-current', 'true');
      await expect(page.locator('.terminal-surface')).toContainText(`line 39 of SWITCH_`);
    }
    await page.waitForTimeout(300); await commits();
    // Whole frames too (script, style, layout and paint, including the terminal's own work in effects).
    await page.evaluate(() => { const w = window as any; w.__frames = []; new PerformanceObserver(list => { for (const entry of list.getEntries()) w.__frames.push(entry.duration); }).observe({ type: 'long-animation-frame' }); });
    expect(await page.evaluate(() => Array.isArray((window as any).__journalCommits))).toBe(true);
    const largest: number[] = []; const totals: number[] = []; const counts: number[] = [];
    for (const n of [1, 3, 2, 4, 1, 4, 2, 3, 1, 2, 3, 4, 2, 1, 4, 3]) {
      await expect(page.locator('main.workspace')).not.toHaveAttribute('aria-busy', 'true');
      await expect(async () => { await pressKey(app, String(n), [...slot]); await expect(row(n)).toHaveAttribute('aria-current', 'true', { timeout: 1000 }); }).toPass();
      await expect(page.locator('main.workspace')).not.toHaveAttribute('aria-busy', 'true');
      await page.waitForTimeout(250); // the switch's follow-up commits (events, receipt, changes)
      const switched = await commits();
      expect(switched.length, 'the profiling build reports commits').toBeGreaterThan(0);
      largest.push(Math.max(...switched.map(c => c.actualDuration))); totals.push(switched.reduce((sum, c) => sum + c.actualDuration, 0)); counts.push(switched.length);
    }
    const frames = await page.evaluate(() => (window as any).__frames as number[]);
    report(info, 'Session switch, 4 Claude fixture sessions, 16 switches by slot key, 1440x900 (React Profiler actualDuration)', [
      `largest commit per switch: p50 ${ms(pct(largest, 0.5))}, p95 ${ms(pct(largest, 0.95))}, max ${ms(Math.max(...largest))}`,
      `render time per switch (all its commits): p50 ${ms(pct(totals, 0.5))}, max ${ms(Math.max(...totals))}; commits per switch p50 ${pct(counts, 0.5)}, max ${Math.max(...counts)}`,
      `long animation frames (>50 ms) during the 16 switches: ${frames.length}${frames.length ? `, longest ${ms(Math.max(...frames))}` : ''}`,
    ]);
    if (strict) {
      expect(pct(largest, 0.5), 'median largest commit per switch (target < 16 ms)').toBeLessThan(16);
      expect(pct(largest, 0.95), 'p95 largest commit per switch').toBeLessThan(50);
    }
  } finally { await closeApp(app); f.cleanup(); }
});
