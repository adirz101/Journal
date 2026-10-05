// CI diagnostics only: how Journal's window and terminal look on a hosted runner.
import { _electron as electron } from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
// Fixture-only environment (no real PATH, HOME or provider variables): see tests/support/env.ts.
import { fixtureEnv } from '../tests/support/env.ts';

mkdirSync(resolve('.cache/tmp'), { recursive: true }); mkdirSync(resolve('test-results'), { recursive: true });
const root = mkdtempSync(resolve('.cache/tmp', 'diag-')); const project = join(root, 'proj'); const bin = join(root, 'bin');
mkdirSync(project); mkdirSync(bin);
execFileSync('git', ['init', '-q', project]); writeFileSync(join(project, 'a.txt'), 'a'); execFileSync('git', ['-C', project, 'add', '.']); execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i']);
writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}\nfor(let i=0;i<5;i++)console.log('LINE_'+i+' '+'x'.repeat(60));console.log('ARGS '+JSON.stringify(process.argv.slice(2,4)));process.stdin.setRawMode(true);process.stdin.resume();`);
chmodSync(join(bin, 'claude'), 0o755);
const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: join(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  const info = await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0]; return { bounds: w.getBounds(), content: w.getContentBounds(), visible: w.isVisible(), display: screen.getPrimaryDisplay().size, work: screen.getPrimaryDisplay().workAreaSize, scale: screen.getPrimaryDisplay().scaleFactor }; });
  console.log('window', JSON.stringify(info));
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, project);
  console.log('viewport', JSON.stringify(await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, fonts: document.fonts.size }))));
  await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
  await page.getByRole('radio', { name: 'Claude Code', exact: true }).click();
  await page.getByLabel('Task', { exact: true }).fill('DIAG');
  await page.getByRole('button', { name: /^Start Claude Code/ }).click();
  await page.waitForTimeout(4000);
  console.log('terminal', JSON.stringify(await page.evaluate(() => { const s = document.querySelector('.terminal-surface'); const r = s?.getBoundingClientRect(); const rows = document.querySelectorAll('.xterm-rows > div'); const m = document.querySelector('.xterm-char-measure-element')?.getBoundingClientRect(); return { box: r && { w: r.width, h: r.height }, rows: rows.length, firstRow: rows[0]?.textContent?.length, charMeasure: m && { w: m.width, h: m.height }, text: s?.innerText.slice(0, 600) }; })));
  await page.screenshot({ path: resolve('test-results/diagnose.png') });
} finally { await app.close(); }
