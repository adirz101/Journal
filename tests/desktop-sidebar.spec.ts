import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { currentProject, openAnotherProject, openSettings, projectNames, slotsUsed, switchProject } from './support/ui';

// The Phase 3 sidebar: slots, Recent by day, suggestion counts, attention rows,
// the project switcher and Settings. Real Electron, runtime and node-pty with fixture CLIs.
test.skip(process.platform === 'win32', 'POSIX fixture CLIs; native Windows is verified separately');

function setup(name: string) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', `${name}-`)); const bin = resolve(root, 'bin'); mkdirSync(bin);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const repo = (folder: string) => {
    const dir = resolve(root, folder); mkdirSync(dir);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main'); writeFileSync(resolve(dir, 'README.md'), `${folder}\n`); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'init');
    return dir;
  };
  const project = repo('sidebar project'); const other = repo('second project');
  // Echoes its task; `perm <command>` plays Journal's own PermissionRequest hook with that command.
  const fixture = `#!${process.execPath}
const fs=require('node:fs');const {spawn}=require('node:child_process');
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
const task=(process.argv.at(-1)||'').split('\\n').at(-1);console.log('TASK '+task);
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let input='';
process.stdin.on('data',data=>{for(const char of data){
if(char==='\\x1b'){console.log('ESC');continue}
if(char!=='\\r'&&char!=='\\n'){input+=char;continue}
const command=input;input='';
if(command.startsWith('perm ')){const a=process.argv;const hook=JSON.parse(fs.readFileSync(a[a.indexOf('--settings')+1],'utf8')).hooks.PermissionRequest[0].hooks[0].command;
const c=spawn('/bin/sh',['-c',hook],{stdio:['pipe','ignore','ignore']});c.on('exit',()=>console.log('ASKED'));
c.stdin.end(JSON.stringify({hook_event_name:'PermissionRequest',session_id:a[a.indexOf('--session-id')+1],cwd:process.cwd(),tool_name:'Bash',tool_use_id:'perm1',tool_input:{command:command.slice(5)}}))}
else console.log('ECHO '+command);
}});`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' };
  delete env.ELECTRON_RUN_AS_NODE;
  return { root, project, other, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function open(env: Record<string, string>, project: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], env });
  // The window counts as focused, so a waiting Claude never posts a real notification.
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); (globalThis as any).__journalFocused = () => true; }, project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
  return { app, page };
}
const closeApp = async (app: ElectronApplication) => {
  if (process.platform !== 'linux') { await app.close().catch(() => {}); return; }
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise(resolveWait => setTimeout(resolveWait, 15000))]);
  try { if (pid) { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } } catch { /* already gone */ }
};
const sessionButton = (page: Page, task: string) => page.getByRole('button', { name: new RegExp(`: ${task}\\.`) });
async function start(page: Page, task: string, provider: 'Claude' | 'Codex' = 'Claude') {
  if (await page.getByLabel('Initial task').count() === 0) await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Initial task').fill(task);
  await page.getByRole('button', { name: `Start ${provider}`, exact: true }).click();
  await expect(page.locator('.terminal-surface')).toContainText(`TASK ${task}`);
}
const mac = process.platform === 'darwin';

test('Active shows slots in order with the meter', async () => {
  const f = setup('sidebar-slots'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'SLOT_ONE'); await start(page, 'SLOT_TWO', 'Codex');
    await expect(slotsUsed(page, 2)).toBeVisible();
    await expect(page.locator('.slot-meter > span.on')).toHaveCount(2);
    const active = page.getByRole('group', { name: 'Active sessions' });
    await expect(active.getByRole('button')).toHaveText([/SLOT_ONE/, /SLOT_TWO/]);
    for (const [index, task] of ['SLOT_ONE', 'SLOT_TWO'].entries())
      await expect(sessionButton(page, task).locator('kbd')).toHaveText(mac ? `⌘${index + 1}` : `Alt+${index + 1}`);
    await expect(active.locator('.status-dot')).toHaveCount(0);
  } finally { await closeApp(app); f.cleanup(); }
});

test('an ended session lands in Recent under Today, with its suggestion count', async () => {
  const f = setup('sidebar-recent'); const { app, page } = await open(f.env, f.project);
  try {
    // ruleProposals reads "rule:" lines from the task; suggestions appear about 1.5 s after the session ends.
    await start(page, 'rule: Release tags must be signed');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    const today = page.getByRole('group', { name: 'Today' });
    // The session title drops the "rule:" prefix.
    const row = today.getByRole('button', { name: /: Release tags must be signed\./ });
    await expect(row).toBeVisible();
    await expect(row.locator('.session-line')).toHaveText(/^Stopped · 1 suggestion/, { timeout: 15000 });
    await expect(page.locator('.sidebar-footer .count-badge')).toHaveText('1');
    await expect(page.locator('.sidebar-footer').getByRole('button', { name: 'Project memory, 1 suggestion' })).toBeVisible();
  } finally { await closeApp(app); f.cleanup(); }
});

test('a waiting Claude row is tinted and names the command', async () => {
  const f = setup('sidebar-waiting'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'ASKING');
    await page.locator('.xterm-helper-textarea').pressSequentially('perm npm run test:desktop');
    await page.locator('.xterm-helper-textarea').press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('ASKED');
    const row = sessionButton(page, 'ASKING');
    await expect(row).toHaveClass(/attention/);
    await expect(row.locator('.session-line')).toHaveText(/^Needs approval · npm run test:desktop/);
    await expect(row.locator('.session-status')).toHaveClass(/tone-attention/);
  } finally { await closeApp(app); f.cleanup(); }
});

test('Settings opens with the shortcut while the terminal has focus', async () => {
  const f = setup('sidebar-settings'); const { app, page } = await open(f.env, f.project);
  try {
    await start(page, 'SETTINGS_KEYS');
    await page.locator('.xterm-helper-textarea').focus();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(async () => {
      await pressKey(app, ',', mac ? ['meta'] : ['control']);
      await expect(settings).toBeVisible({ timeout: 1000 });
    }).toPass();
    for (const text of ['Dark', 'Light', 'Notifications', 'Updates', 'Data and backups']) await expect(settings.getByText(text, { exact: true }).first()).toBeVisible();
    const approval = settings.getByRole('checkbox', { name: 'Notify me when Claude needs approval' });
    await approval.uncheck();
    await expect(settings.getByRole('checkbox', { name: 'Show the command in notifications' })).toBeDisabled();
    // Esc closes the dialog, focus returns to the terminal, and the next key reaches it.
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.terminal-surface')).toContainText('ESC');
    // The preference persists across a reload.
    await page.reload();
    await openSettings(page, 'notifications');
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('checkbox', { name: 'Notify me when Claude needs approval' })).not.toBeChecked();
  } finally { await closeApp(app); f.cleanup(); }
});

test('the switcher lists projects and switches', async () => {
  const f = setup('sidebar-switcher'); const { app, page } = await open(f.env, f.project);
  try {
    await expect(currentProject(page)).toHaveText('sidebar project');
    await expect(page.locator('.project-switcher .branch-badge')).toHaveText('⑂ main');
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, f.other);
    await openAnotherProject(app, page);
    await expect(currentProject(page)).toHaveText('second project');
    await expect.poll(() => projectNames(app, page)).toEqual(['second project', 'sidebar project']);
    await switchProject(app, page, 'sidebar project');
    await expect(currentProject(page)).toHaveText('sidebar project');
  } finally { await closeApp(app); f.cleanup(); }
});
