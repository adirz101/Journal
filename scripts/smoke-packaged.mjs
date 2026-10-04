// Smoke test of a packaged Journal (not the development build):
//   node scripts/smoke-packaged.mjs <path to the Journal executable>
// macOS: .../Journal.app/Contents/MacOS/Journal; Windows: ...\Journal.exe.
// It runs with fixture CLIs and a temporary data folder, never with real
// provider logins, and checks: launch, provider detection, opening a project,
// a terminal session through the packaged runtime and node-pty, the file
// explorer, the local database, and that a restart keeps the project.
import { _electron as electron } from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: smoke-packaged.mjs <Journal executable>');
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const windows = process.platform === 'win32';
// A path with spaces, like many real project and user folders.
const root = mkdtempSync(join(tmpdir(), 'journal smoke '));
const project = join(root, 'smoke project'); const bin = join(root, 'fake bin'); const data = join(root, 'journal data');
for (const dir of [project, bin, data]) mkdirSync(dir, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', project, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.test', ...args], { stdio: 'pipe' });
git('init', '-q'); writeFileSync(join(project, 'README.md'), '# Smoke fixture\n'); git('add', '.'); git('commit', '-qm', 'init');

// Fixture CLIs: print what they received and echo input, like the desktop tests.
const script = `if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
console.log('PTY_READY '+process.stdout.isTTY);console.log('TASK '+(process.argv.at(-1)||''));process.stdin.setRawMode&&process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('ECHO '+d));`;
for (const name of ['claude', 'codex']) {
  if (windows) {
    // An npm-style shim, which Journal launches through its Node script.
    writeFileSync(join(bin, `${name}.js`), script);
    writeFileSync(join(bin, `${name}.cmd`), `@ECHO off\r\nnode "%~dp0\\${name}.js" %*\r\n`);
  } else { writeFileSync(join(bin, name), `#!${process.execPath}\n${script}`); chmodSync(join(bin, name), 0o755); }
}
const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: data, JOURNAL_HEADLESS: '1', JOURNAL_QUIT_POLICY: 'stop' };
delete env.ELECTRON_RUN_AS_NODE;

const step = async (label, action) => { process.stdout.write(`- ${label}… `); await action(); console.log('ok'); };
const expectText = async (locator, text, timeout = 30000) => { await locator.filter({ hasText: text }).first().waitFor({ timeout }); };

async function run(first) {
  const app = await electron.launch({ executablePath: executable, env, timeout: 60000 });
  try {
    const info = await app.evaluate(({ app: electronApp }) => ({ packaged: electronApp.isPackaged, version: electronApp.getVersion(), userData: electronApp.getPath('userData'), name: electronApp.getName() }));
    if (!info.packaged) throw new Error('Not a packaged build');
    if (info.version !== version) throw new Error(`App reports version ${info.version}, package.json says ${version}`);
    if (info.userData !== data) throw new Error(`Data folder is ${info.userData}, expected ${data}`);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    if (first) {
      await step(`launch ${info.name} ${info.version} (packaged)`, async () => {});
      await step('open a project', async () => { await page.getByRole('button', { name: 'Open project', exact: true }).first().click(); await expectText(page.locator('.project-link'), 'smoke project'); });
      await step('provider detection (Claude, Codex, Cursor rows)', async () => { const cards = page.getByRole('radiogroup', { name: 'Agent' }); await expectText(cards.getByRole('radio', { name: 'Claude Code', exact: true }), 'Installed · fixture 1.0'); await expectText(cards.getByRole('radio', { name: 'Codex', exact: true }), 'Installed · fixture 1.0'); await expectText(cards.getByRole('radio', { name: 'Cursor', exact: true }), /Installed|Not installed|Sign in needed|Not the Cursor CLI|Unsupported version|Can’t launch/); });
      await step('terminal session through the runtime and node-pty', async () => {
        await page.getByRole('radio', { name: 'Claude Code', exact: true }).click();
        await page.getByLabel('Task', { exact: true }).fill('SMOKE_TASK');
        await page.getByRole('button', { name: /^Start Claude Code/ }).click();
        await expectText(page.locator('.terminal-surface'), 'PTY_READY true');
        await expectText(page.locator('.terminal-surface'), 'SMOKE_TASK');
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await expectText(page.locator('.terminal-label'), 'stopped');
      });
      await step('file explorer', async () => { await page.getByRole('tab', { name: 'Files' }).click(); await page.getByRole('treeitem', { name: /^README\.md/ }).waitFor({ timeout: 15000 }); });
    } else {
      await step('restart keeps the project, the session and its receipt', async () => {
        await expectText(page.locator('.project-link'), 'smoke project');
        await page.locator('.project-link').first().click();
        await page.getByRole('button', { name: /^Claude Code: SMOKE_TASK/ }).waitFor({ timeout: 15000 });
      });
    }
  } catch (error) {
    // Diagnostics for CI logs: visible errors and the runtime's own log.
    const page = app.windows()[0];
    if (page) console.error('Errors shown:', await page.locator('.error-banner, .form-error, .hint').allTextContents().catch(() => []));
    try { console.error('runtime-stderr.log:\n' + readFileSync(join(data, 'runtime-stderr.log'), 'utf8').slice(-4000)); } catch { console.error('(no runtime log)'); }
    throw error;
  } finally { await app.close(); }
}

try {
  await run(true);
  await run(false);
  console.log('Packaged smoke test passed.');
} finally {
  // The runtime and store worker may still hold files for a moment (Windows).
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (error) { console.warn(`Could not remove ${root}: ${error.message}`); }
}
