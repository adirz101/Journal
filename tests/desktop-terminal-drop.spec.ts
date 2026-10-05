import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { skipFirstRun, startSession } from './support/ui';
import { fixtureEnv } from './support/env';

// Dropping files onto the terminal types a reference at the cursor and never submits it
// (fixture CLI that records its stdin; a synthetic drop, as Chromium sends it).
test.skip(process.platform === 'win32', 'POSIX fixture CLI');
test('a file dropped from the Files tab is typed as a reference, never submitted; other drops are refused', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'drop-')); const project = resolve(root, 'project'); const bin = resolve(root, 'bin');
  for (const dir of [project, bin, resolve(project, 'src')]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe', env });
  git('init', '-q', '-b', 'main');
  writeFileSync(resolve(project, 'README.md'), '# p\n'); writeFileSync(resolve(project, 'src', 'a.ts'), 'a\n'); writeFileSync(resolve(project, 'src', 'my file.ts'), 'b\n');
  git('add', '.'); git('commit', '-qm', 'init');
  const log = resolve(root, 'stdin.txt');
  writeFileSync(resolve(bin, 'claude'), `#!${process.execPath}
const fs=require('node:fs');if(process.argv[2]==='--version'){console.log('2.1.286 (Claude Code)');process.exit(0)}
process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(d.toString('latin1'))+'\\n'));
process.stdout.write('PROBE_READY\\r\\n');`);
  chmodSync(resolve(bin, 'claude'), 0o755);
  const app = await electron.launch({ args: ['.'], env });
  try {
    await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, project);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    await skipFirstRun(page);
    await startSession(page, 'claude', { task: '' });
    await expect(page.locator('.xterm-rows')).toContainText('PROBE_READY', { timeout: 15000 });
    const read = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).join('') : '';
    const drop = (data: { rootKey: string; path: string } | null) => page.locator('.terminal-surface').evaluate((surface, data) => {
      const transfer = new DataTransfer();
      if (data) transfer.setData('application/x-journal-file', JSON.stringify(data));
      else transfer.items.add(new File(['x'], 'synthetic.txt'));
      for (const type of ['dragenter', 'dragover', 'drop']) surface.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, data);
    await drop({ rootKey: 'checkout', path: 'src/a.ts' });
    await expect.poll(read).toContain('@src/a.ts ');
    await drop({ rootKey: 'checkout', path: 'src/my file.ts' });
    await expect.poll(read).toContain('"src/my file.ts" ');
    expect(read()).not.toMatch(/[\r\n]/);
    // A file that is not from the OS or the Files tab (no path) is refused with a message.
    const before = read().length;
    await drop(null);
    await expect(page.getByText('Drop files from the Files tab, Finder or File Explorer.')).toBeVisible();
    // A sensitive or missing file is refused; nothing is typed.
    await drop({ rootKey: 'checkout', path: 'missing.ts' });
    await page.waitForTimeout(300);
    expect(read().length).toBe(before);
  } finally { await app.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});
