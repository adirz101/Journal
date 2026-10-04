import { test, expect } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentProject, taskBox } from './support/ui';

test.skip(process.platform === 'win32', 'POSIX fixture CLIs');

function setup() {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'reload-')); const project = resolve(root, 'reload project'); const bin = resolve(root, 'bin'); const home = resolve(root, 'home');
  for (const dir of [project, bin, home]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), '# Reload fixture\n'); git('add', '.'); git('commit', '-qm', 'init');
  const fixture = `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}\nprocess.stdin.resume();`;
  for (const p of ['claude', 'codex']) { writeFileSync(resolve(bin, p), fixture); chmodSync(resolve(bin, p), 0o755); }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin${delimiter}${resolve(process.execPath, '..')}`, HOME: home, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' };
  delete env.ELECTRON_RUN_AS_NODE;
  return { root, project, env };
}

// A renderer reload (⌘R / Ctrl+R in development builds; released builds have no
// Reload item, decision D13) reopens the project that was showing, even when it
// comes straight after Open a project…, before the workspace list has answered.
test('a renderer reload straight after opening a project keeps it open', async () => {
  const f = setup();
  const app = await electron.launch({ args: ['.'], env: f.env });
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, f.project);
  const page = await app.firstWindow();
  try {
    // Hold the workspace list so the reload lands before it answers (the window in which the project used to be forgotten).
    await app.evaluate(() => {
      (globalThis as any).__journalRequestHook = async (method: string, run: () => unknown) => { if (method === 'workspaces') await new Promise(done => setTimeout(done, 1500)); return run(); };
    });
    await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
    await expect(taskBox(page)).toBeVisible();
    await expect(currentProject(page)).toHaveText(/^reload project/);
    await page.reload();
    await expect(taskBox(page)).toBeVisible();
    await expect(currentProject(page)).toHaveText(/^reload project/);
    await expect(page.getByRole('button', { name: 'Open a project…', exact: true })).toHaveCount(0);
  } finally { await app.close().catch(() => {}); rmSync(f.root, { recursive: true, force: true }); }
});
