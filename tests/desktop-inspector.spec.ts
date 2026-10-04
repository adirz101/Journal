import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { filesView, inspectorTab, newSession, sessionStatus, startSession, statusBar } from './support/ui';
import { fixtureEnv } from './support/env';

// The Phase 3 session view: header, attention banner, status bar and the
// three-tab inspector. Real Electron, runtime and node-pty with fixture CLIs.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`)); const bin = resolve(root, 'bin'); mkdirSync(bin);
  const project = resolve(root, 'inspector project'); mkdirSync(project);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), 'Inspector fixture\n'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'init');
  // `perm <command>` and `post` play Journal's own PermissionRequest and PostToolUse hooks; `write <file>` edits a file;
  // `edit <file>` edits one and plays PostToolUse for a Write, as Claude does.
  const fixture = `#!${process.execPath}
const fs=require('node:fs');const {spawn}=require('node:child_process');
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
const task=(process.argv.at(-1)||'').split('\\n').at(-1);console.log('TASK '+task);
const a=process.argv;const hooks=()=>JSON.parse(fs.readFileSync(a[a.indexOf('--settings')+1],'utf8')).hooks;
const play=(event,fields,done)=>{const c=spawn('/bin/sh',['-c',hooks()[event][0].hooks[0].command],{stdio:['pipe','ignore','ignore']});c.on('exit',()=>console.log(done));
c.stdin.end(JSON.stringify({hook_event_name:event,session_id:a[a.indexOf('--session-id')+1],cwd:process.cwd(),tool_name:'Bash',tool_use_id:'perm1',...fields}))};
let last='';
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let input='';
process.stdin.on('data',data=>{for(const char of data){
if(char!=='\\r'&&char!=='\\n'){input+=char;continue}
const command=input;input='';
if(command.startsWith('perm ')){last=command.slice(5);play('PermissionRequest',{tool_input:{command:last}},'ASKED')}
else if(command==='post'){play('PostToolUse',{tool_input:{command:last},tool_response:{}},'POSTED')}
else if(command.startsWith('write ')){fs.writeFileSync(command.slice(6),'created by agent\\n');console.log('WROTE')}
else if(command.startsWith('edit ')){const file=require('node:path').resolve(command.slice(5));fs.writeFileSync(file,'edited by agent\\n');play('PostToolUse',{tool_name:'Write',tool_use_id:'edit1',tool_input:{file_path:file},tool_response:{}},'EDITED')}
else console.log('ECHO '+command);
}});`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  return { root, project, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function open(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  // The window counts as focused, so a waiting Claude never posts a real notification.
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); (globalThis as any).__journalFocused = () => true; }, project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; }
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(resolveWait => setTimeout(resolveWait, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
async function start(page: Page, task: string, provider: 'Claude' | 'Codex' = 'Claude') {
  await startSession(page, provider === 'Claude' ? 'claude' : 'codex', { task });
  await expect(page.locator('.terminal-surface')).toContainText(`TASK ${task}`);
}
const typeLine = async (page: Page, text: string) => { await page.locator('.xterm-helper-textarea').pressSequentially(text); await page.locator('.xterm-helper-textarea').press('Enter'); };
const mac = process.platform === 'darwin';

test('the banner names the pending command and clears after approval', async () => {
  const f = setup('inspector-banner'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'BANNER');
    await typeLine(page, 'perm npm run test:desktop');
    await expect(page.locator('.terminal-surface')).toContainText('ASKED');
    const banner = page.locator('.attention-banner');
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner).toContainText('Claude is waiting for your approval');
    await expect(banner).toContainText('Bash:');
    await expect(banner.locator('code')).toHaveText('npm run test:desktop');
    await expect(banner).toContainText('Answer in the terminal.');
    await typeLine(page, 'post');
    await expect(page.locator('.terminal-surface')).toContainText('POSTED');
    await expect(banner).toHaveCount(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('the status bar counts match the receipt, and See what was sent shows it', async () => {
  const f = setup('inspector-status'); const { app, page } = await open(f.env, f.project);
  try {
    await page.evaluate(async () => {
      const journal = (window as any).journal; const projectId = (await journal.request('projects'))[0].id;
      for (const statement of ['Release tags are signed with the team key.', 'Release notes list every migration.']) {
        const memory = await journal.request('proposeMemory', { projectId, input: { statement, category: 'convention', scope: 'checkout', area: '', source: { kind: 'user', note: 'Fixture' } } });
        await journal.request('setMemoryStatus', { id: memory.id, status: 'active' });
      }
    });
    await start(page, 'Prepare the release notes and tags');
    const packet = await page.evaluate(async () => {
      const journal = (window as any).journal; const live = (await journal.request('sessions')).live[0];
      const receipt = await journal.request('getReceipt', { id: live.receiptId }); return { bytes: new TextEncoder().encode(receipt.packet).length, notes: receipt.items.length };
    });
    expect(packet.notes).toBe(2);
    await expect(statusBar(page)).toContainText(`Agent got 2 notes · ${(packet.bytes / 1024).toFixed(1)} KB`);
    await expect(statusBar(page)).toContainText('Output not saved');
    await inspectorTab(page, 'Memory');
    await statusBar(page).getByRole('button', { name: 'See what was sent' }).click();
    await expect(page.getByRole('tab', { name: /^Session/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('context-packet')).toBeInViewport();
    await expect(page.getByRole('heading', { name: 'What this agent knows' })).toBeFocused();
    // Focus moves only once: switching tabs away and back with the shortcuts leaves the terminal focused.
    const terminal = page.locator('.xterm-helper-textarea');
    await terminal.focus();
    const tabKeys = (n: string) => pressKey(app, n, process.platform === 'darwin' ? ['meta', 'alt'] : ['alt', 'shift']);
    await expect(async () => { await tabKeys('3'); await expect(page.getByRole('tab', { name: /^Memory/ })).toHaveAttribute('aria-selected', 'true', { timeout: 1000 }); }).toPass();
    await expect(terminal).toBeFocused();
    await expect(async () => { await tabKeys('1'); await expect(page.getByRole('tab', { name: /^Session/ })).toHaveAttribute('aria-selected', 'true', { timeout: 1000 }); }).toPass();
    await expect(page.getByRole('heading', { name: 'What this agent knows' })).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(terminal).toBeFocused();
  } finally { await closeApp(app); f.cleanup(); }
});

test('Codex shows Limited status and no activity list', async () => {
  const f = setup('inspector-codex'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'CODEX_VIEW', 'Codex');
    await expect(page.locator('.session-header .chip')).toHaveText('Limited status');
    await inspectorTab(page, 'Session');
    await expect(page.getByRole('heading', { name: "Activity isn't visible for Codex" })).toBeVisible();
    await expect(page.locator('.session-tab')).toContainText('Last output:');
    await expect(page.locator('.did-list')).toHaveCount(0);
    await expect(page.locator('.attention-banner')).toHaveCount(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('the diff updates from file events (Claude) and polling (Codex)', async () => {
  const f = setup('inspector-diff'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'CLAUDE_WRITES');
    await expect(statusBar(page)).toContainText('No changes yet');
    // Claude's PostToolUse hook for the Write records a file event, which refreshes the diff without Refresh or polling.
    await inspectorTab(page, 'Files'); await filesView(page, 'changed');
    await typeLine(page, 'edit agent-output.txt');
    await expect(page.locator('.terminal-surface')).toContainText('EDITED');
    await expect(statusBar(page)).toContainText('+1');
    await expect(statusBar(page)).toContainText('in 1 file');
    await expect(page.getByRole('tab', { name: /^Files/ })).toContainText('1');
    await expect(page.getByRole('radio', { name: 'Changed (1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(sessionStatus(page)).toContainText('Stopped');
    // Codex reports no file events: the open session is polled every 10 s.
    // Files already changed when it started ("before") are not its own.
    await start(page, 'CODEX_WRITES', 'Codex');
    await expect(statusBar(page)).toContainText('No changes yet');
    await typeLine(page, 'write codex-output.txt');
    await expect(page.locator('.terminal-surface')).toContainText('WROTE');
    await expect(statusBar(page)).toContainText('in 1 file', { timeout: 15000 });
  } finally { await closeApp(app); f.cleanup(); }
});

test('inspector tabs: arrows move focus; the tab shortcuts select while the terminal has focus', async () => {
  const f = setup('inspector-tabs'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'TAB_KEYS');
    const tab = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) });
    await tab('Session').click();
    await page.keyboard.press('ArrowRight');
    await expect(tab('Files')).toBeFocused(); await expect(tab('Files')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(tab('Memory')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab('Session')).toBeFocused();
    await page.locator('.xterm-helper-textarea').focus();
    const modifiers = mac ? ['meta', 'alt'] as const : ['alt', 'shift'] as const;
    for (const [key, name] of [['3', 'Memory'], ['2', 'Files'], ['1', 'Session']] as const) {
      await expect(async () => {
        await pressKey(app, key, [...modifiers]);
        await expect(tab(name)).toHaveAttribute('aria-selected', 'true', { timeout: 1000 });
      }).toPass();
    }
  } finally { await closeApp(app); f.cleanup(); }
});

test('the header shows the CLI version recorded at launch', async () => {
  const f = setup('inspector-version'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'VERSION');
    await expect(page.locator('.session-header .meta-provider')).toHaveText('Claude Code fixture 1.0');
    const recorded = await page.evaluate(async () => (await (window as any).journal.request('sessions')).live[0].cliVersion);
    expect(recorded).toBe('fixture 1.0');
  } finally { await closeApp(app); f.cleanup(); }
});
