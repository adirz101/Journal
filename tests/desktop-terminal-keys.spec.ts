import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { skipFirstRun, startSession } from './support/ui';
import { fixtureEnv } from './support/env';

// The terminal's macOS editing keys and paste reach the agent (fixture CLI that records its stdin).
test.skip(process.platform !== 'darwin', 'macOS editing keys; POSIX fixture CLI');
test('⌘ and ⌥ editing keys send line-editing codes, pasted text reaches the agent, typing is unchanged', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'probe-')); const project = resolve(root, 'project'); const bin = resolve(root, 'bin');
  for (const dir of [project, bin]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe', env });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# p\n'); git('add', '.'); git('commit', '-qm', 'init');
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
    await page.locator('.xterm-helper-textarea').focus();
    const read = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).join('') : '';
    // Paste: the Edit menu's Paste (⌘V) pastes into the focused terminal.
    await app.evaluate(({ clipboard }) => clipboard.writeText('PASTE_A'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
    await expect.poll(read).toContain('PASTE_A');
    for (const [keys, bytes] of [['Meta+Backspace', '\x15'], ['Meta+ArrowLeft', '\x01'], ['Meta+ArrowRight', '\x05'], ['Alt+Backspace', '\x17'], ['Alt+ArrowLeft', '\x1bb'], ['Alt+ArrowRight', '\x1bf']] as const) {
      const before = read().length;
      await page.keyboard.press(keys);
      await expect.poll(() => read().slice(before), { message: keys }).toBe(bytes);
    }
    // Plain typing and plain arrows are unchanged.
    let before = read().length; await page.keyboard.type('ab'); await expect.poll(() => read().slice(before)).toBe('ab');
    before = read().length; await page.keyboard.press('ArrowLeft'); await expect.poll(() => read().slice(before)).toBe('\x1b[D');
  } finally { await app.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});
