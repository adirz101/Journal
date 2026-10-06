import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectorTab, skipFirstRun, startSession, taskBox } from './support/ui';
import { fixtureEnv } from './support/env';

// Isolated sessions end to end (macOS milestone): a fixture agent works in its own copy of the
// branch, the window previews and applies its result, a conflict writes nothing, and the state
// survives an app restart. No provider CLI or login.
test.skip(process.platform === 'win32', 'macOS milestone (POSIX fixture CLI)');

const LINES = Array.from({ length: 10 }, (_, i) => `api ${i + 1}`).join('\n') + '\n';
function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`)); const project = resolve(root, 'project'); const bin = resolve(root, 'bin'); const data = resolve(root, 'data');
  for (const dir of [project, bin, resolve(project, 'src')]) mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: data, JOURNAL_QUIT_POLICY: 'stop' } });
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { encoding: 'utf8', stdio: 'pipe', env }).trim();
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'src', 'api.js'), LINES); writeFileSync(resolve(project, 'README.md'), '# p\n');
  git('add', '-A'); git('commit', '-qm', 'init'); git('checkout', '-q', '-b', 'feature/auth');
  // The fixture agent: reports where it runs, applies "LINE n TEXT" from its task to src/api.js,
  // and exits when it reads "q".
  writeFileSync(resolve(bin, 'claude'), `#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('--version')){console.log('2.1.286 (Claude Code)');process.exit(0)}
const task=(process.argv.at(-1)||'').split('\\n').at(-1);const m=/LINE (\\d+) (.+)/.exec(task);
if(m){const p='src/api.js';const all=fs.readFileSync(p,'utf8').split('\\n');all[Number(m[1])-1]=m[2];fs.writeFileSync(p,all.join('\\n'))}
console.log('WORKING IN '+process.cwd());console.log('ENV '+process.env.JOURNAL_ENV_ID+' PORT '+process.env.JOURNAL_PORT+' BRANCH '+process.env.JOURNAL_LOGICAL_BRANCH);
process.stdin.setRawMode(true);process.stdin.on('data',d=>{if(String(d).includes('q'))process.exit(0)});`);
  chmodSync(resolve(bin, 'claude'), 0o755);
  return { root, project, data, env, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function launch(f: ReturnType<typeof setup>): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env: f.env });
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, f.project);
  return { app, page: await app.firstWindow() };
}
async function isolatedSession(page: Page, task: string) {
  await startSessionPrepared(page, task);
  await expect(page.locator('.xterm-rows')).toContainText('WORKING IN', { timeout: 20000 });
}
async function startSessionPrepared(page: Page, task: string) {
  const { newSession } = await import('./support/ui');
  await newSession(page);
  await page.getByRole('checkbox', { name: 'Isolated' }).check();
  await taskBox(page).fill(task);
  await page.getByRole('button', { name: /^Start Claude Code/ }).click();
}
async function finish(page: Page) { await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('q'); }
const panel = (page: Page) => page.locator('.environment-panel');

test('an isolated session works in its own copy; its result is previewed and applied to the branch', async () => {
  const f = setup('isolated'); const { app, page } = await launch(f);
  try {
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    await skipFirstRun(page);
    await isolatedSession(page, 'LINE 2 changed by the isolated agent');
    const rows = await page.locator('.xterm-rows').innerText();
    expect(rows).toContain(`WORKING IN ${f.data}`); expect(rows).toMatch(/PORT 4\d{4} BRANCH feature\/auth/);
    expect(readFileSync(join(f.project, 'src', 'api.js'), 'utf8')).toBe(LINES); expect(f.git('status', '--porcelain')).toBe('');
    await expect(page.locator('.session-header')).toContainText('Isolated · ⑂ feature/auth');
    await inspectorTab(page, 'Session');
    await expect(panel(page)).toContainText('Working in its own copy of feature/auth.');
    await finish(page);
    await expect(panel(page)).toContainText('Done. Its changes are ready to apply to feature/auth.', { timeout: 15000 });
    await expect(panel(page)).toContainText('Result: 1 file changed.');
    await panel(page).getByRole('button', { name: 'Apply to feature/auth…' }).click();
    const preview = page.getByLabel('What applying to feature/auth would do');
    await expect(preview).toContainText('feature/auth has not moved since its copy was made or last updated.');
    await expect(preview).toContainText('src/api.js');
    await preview.getByRole('button', { name: 'Apply to feature/auth', exact: true }).click();
    await expect(panel(page)).toContainText('Applied to feature/auth as commit', { timeout: 15000 });
    expect(readFileSync(join(f.project, 'src', 'api.js'), 'utf8')).toContain('changed by the isolated agent');
    expect(f.git('status', '--porcelain')).toBe(''); expect(f.git('log', '-1', '--format=%s')).toMatch(/^Apply LINE 2/);
    // The Story records it; internals stay under Details.
    await expect(page.locator('.story')).toContainText('Isolated from feature/auth');
    await expect(page.locator('.story')).toContainText('Applied to feature/auth');
    await expect(panel(page).getByText(/refs\/journal\/env\//)).toBeHidden();
    await panel(page).getByText('Details', { exact: true }).click();
    await expect(panel(page).getByText(/refs\/journal\/env\//)).toBeVisible();
  } finally { await app.close().catch(() => {}); f.cleanup(); }
});

test('two isolated sessions on the same line: the second conflicts, nothing is written; state survives a restart', async () => {
  const f = setup('isolated-conflict'); let { app, page } = await launch(f);
  try {
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    await skipFirstRun(page);
    await isolatedSession(page, 'LINE 3 from worker A'); await finish(page);
    await inspectorTab(page, 'Session'); await expect(panel(page)).toContainText('Done.', { timeout: 15000 });
    await isolatedSession(page, 'LINE 3 from worker B'); await finish(page);
    await inspectorTab(page, 'Session'); await expect(panel(page)).toContainText('Done.', { timeout: 15000 });
    // Apply A (the first session in the sidebar), then try B.
    await page.getByRole('button', { name: /LINE 3 from worker A/ }).first().click();
    await inspectorTab(page, 'Session');
    await panel(page).getByRole('button', { name: 'Apply to feature/auth…' }).click();
    await page.getByLabel('What applying to feature/auth would do').getByRole('button', { name: 'Apply to feature/auth', exact: true }).click();
    await expect(panel(page)).toContainText('Applied to feature/auth', { timeout: 15000 });
    const before = { head: f.git('rev-parse', 'feature/auth'), api: readFileSync(join(f.project, 'src', 'api.js'), 'utf8') };
    await page.getByRole('button', { name: /LINE 3 from worker B/ }).first().click();
    await inspectorTab(page, 'Session');
    await panel(page).getByRole('button', { name: 'Apply to feature/auth…' }).click();
    const preview = page.getByLabel('What applying to feature/auth would do');
    await expect(preview).toContainText('feature/auth moved 1 commit since its copy was made or last updated');
    await expect(preview).toContainText('1 file conflict; nothing can be applied');
    await expect(preview.getByRole('button', { name: 'Apply to feature/auth', exact: true })).toBeDisabled();
    expect({ head: f.git('rev-parse', 'feature/auth'), api: readFileSync(join(f.project, 'src', 'api.js'), 'utf8') }).toEqual(before);
    // Restart: the isolated sessions and their states are still there.
    await app.close(); ({ app, page } = await launch(f));
    await page.getByRole('button', { name: /LINE 3 from worker B/ }).first().click();
    await inspectorTab(page, 'Session');
    await expect(panel(page)).toContainText('Done. Its changes are ready to apply to feature/auth.');
    await page.getByRole('button', { name: /LINE 3 from worker A/ }).first().click();
    await inspectorTab(page, 'Session');
    await expect(panel(page)).toContainText('Applied to feature/auth');
  } finally { await app.close().catch(() => {}); f.cleanup(); }
});
