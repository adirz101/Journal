// Smoke test of a packaged Journal (not the development build):
//   node scripts/smoke-packaged.mjs <path to the Journal executable>
// macOS: .../Journal.app/Contents/MacOS/Journal; Windows: ...\Journal.exe.
// It runs with fixture CLIs and a temporary data folder, never with real
// provider logins, and checks: launch, provider detection, opening a project,
// a terminal session through the packaged runtime and node-pty, the file
// explorer, the local database, and that a restart keeps the project.
import { _electron as electron } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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
// Never reach a real provider CLI or login: PATH holds only the fixtures, node and the system
// folders (not the user's PATH, where real claude, codex or Cursor agent installs live), and HOME
// is an empty folder (Cursor is also looked up under ~/.local/bin).
const home = join(root, 'home'); mkdirSync(home);
let systemPath;
if (windows) {
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  systemPath = [dirname(process.execPath), join(system, 'System32'), system, join(system, 'System32', 'WindowsPowerShell', 'v1.0')];
} else {
  const tools = join(root, 'tools'); mkdirSync(tools); symlinkSync(process.execPath, join(tools, 'node'));
  systemPath = [tools, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
}
for (const dir of systemPath.slice(windows ? 0 : 1)) for (const name of ['claude', 'codex', 'agent', 'cursor-agent']) for (const ext of windows ? ['.exe', '.cmd', '.bat'] : ['']) {
  if (existsSync(join(dir, name + ext))) throw new Error(`A real ${name} is reachable in ${dir}; the smoke test only runs with fixtures`);
}
const env = { ...process.env, PATH: [bin, ...systemPath].join(delimiter), HOME: home, USERPROFILE: home, JOURNAL_DATA_DIR: data, JOURNAL_HEADLESS: '1', JOURNAL_QUIT_POLICY: 'stop' };
for (const name of ['ELECTRON_RUN_AS_NODE', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) delete env[name];
if (windows) env.LOCALAPPDATA = join(home, 'AppData', 'Local');

const step = async (label, action) => { process.stdout.write(`- ${label}… `); await action(); console.log('ok'); };
// The same selectors as tests/support/ui.ts (currentProject, sessionStatus): the Phase 3 shell.
const currentProject = page => page.locator('.project-switcher .project-name');
const sessionStatus = page => page.locator('.session-header .session-meta');
// inspectorTab: a medium or narrow window folds the inspector into a rail, whose button opens the tab.
async function inspectorTab(page, name) {
  const tab = page.getByRole('tab', { name: new RegExp(`^${name}`) }); const rail = page.locator('.inspector-rail').getByRole('button', { name: new RegExp(`^${name}`) });
  await tab.or(rail).first().waitFor({ timeout: 15000 });
  if (!await tab.count()) await rail.click();
  await tab.click();
}
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
      await step('open a project', async () => { await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click(); await expectText(currentProject(page), 'smoke project'); });
      await step('provider detection (Claude, Codex, Cursor rows)', async () => { const cards = page.getByRole('radiogroup', { name: 'Agent' }); await expectText(cards.getByRole('radio', { name: 'Claude Code', exact: true }), /Installed · (fixture )?1\.0/); await expectText(cards.getByRole('radio', { name: 'Codex', exact: true }), /Installed · (fixture )?1\.0/); await expectText(cards.getByRole('radio', { name: 'Cursor', exact: true }), /Installed|Not installed|Sign in needed|Not the Cursor CLI|Unsupported version|Can’t launch/); });
      await step('terminal session through the runtime and node-pty', async () => {
        await page.getByRole('radio', { name: 'Claude Code', exact: true }).click();
        await page.getByLabel('Task', { exact: true }).fill('SMOKE_TASK');
        await page.getByRole('button', { name: /^Start Claude Code/ }).click();
        await expectText(page.locator('.terminal-surface'), 'PTY_READY true');
        await expectText(page.locator('.terminal-surface'), 'SMOKE_TASK');
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await expectText(sessionStatus(page), 'Stopped');
      });
      await step('file explorer', async () => { await inspectorTab(page, 'Files'); await page.getByRole('treeitem', { name: /^README\.md/ }).waitFor({ timeout: 15000 }); });
    } else {
      await step('restart keeps the project, the session and its receipt', async () => {
        // The remembered project reopens on its own; its ended session is listed in the sidebar.
        await expectText(currentProject(page), 'smoke project');
        await page.locator('.sidebar').getByRole('button', { name: /^Claude Code: SMOKE_TASK/ }).waitFor({ timeout: 15000 });
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
