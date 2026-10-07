import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixtureEnv } from './support/env';
import { skipFirstRun, taskBox } from './support/ui';
import { pressKey } from './support/keys';

test.skip(process.platform === 'win32', 'POSIX fixture CLI; Windows orchestration isolation acceptance is separate');
test('Coordinate opens a durable team, an isolated worker, and keyboard-accessible messages and pause controls', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'team-')); const project = join(root, 'project'); const bin = join(root, 'bin'); const data = join(root, 'data');
  for (const dir of [project, bin, data]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(data, 'preferences.json'), JSON.stringify({ coordinatedRuns: true }));
  symlinkSync(join(dirname(process.execPath), 'npm'), join(bin, 'npm'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  for (const [name, output] of [['vm_stat', 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000000.\nPages inactive: 1000000.\nPages speculative: 10000.'], ['sysctl', '1']]) { writeFileSync(join(bin, name), `#!${process.execPath}\nconsole.log(${JSON.stringify(output)})\n`); chmodSync(join(bin, name), 0o755); }
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: data, JOURNAL_QUIT_POLICY: 'stop' } });
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(join(project, 'README.md'), 'fixture\n'); git('add', '.'); git('commit', '-qm', 'initial');
  const moduleUrl = pathToFileURL(resolve('src/agent-tools/client.mjs')).href;
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
if(process.argv.includes('--version')){console.log('2.1.286 (Claude Code)');process.exit(0)}
if(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'fixture'}));process.exit(0)}
console.log('Fixture team terminal');process.stdin.setRawMode(true);process.stdin.on('data',d=>{if(String(d).includes('q'))process.exit(0)});
if(process.argv.some(arg=>arg.includes('You coordinate Journal run'))){(async()=>{const {clientFromEnv}=await import(${JSON.stringify(moduleUrl)});const client=clientFromEnv();await client.call('publish_update',{requestId:'fixture-update',summary:'I am checking the fixture documentation. I will compare docs/journal-lab/csv-map.md with docs/journal-lab/extraction-map.md, then collect both worker results for review. Native permissions remain in force; you can continue the conversation while the tasks run.'});const task=await client.call('create_task',{requestId:'fixture-task',title:'Implement fixture task'});await client.call('create_worker',{requestId:'fixture-worker',taskId:task.id,provider:'claude'});await client.call('request_approval',{requestId:'fixture-decision',summary:'Include the setup instructions in this documentation change?'});client.close();console.log('Fixture worker requested')})().catch(e=>console.error(e.message))}
else if(process.env.JOURNAL_TASK_ID){(async()=>{
const fs=require('node:fs'),{execFileSync}=require('node:child_process');
const nativeId=process.argv[process.argv.indexOf('--session-id')+1];
const hook=event=>execFileSync(process.execPath,[${JSON.stringify(resolve('src/desktop/hook.mjs'))},'claude'],{
input:JSON.stringify({hook_event_name:event,session_id:nativeId,cwd:process.cwd()}),
env:{JOURNAL_SESSION_ID:process.env.JOURNAL_SESSION_ID,JOURNAL_HOOK_TARGET:process.env.JOURNAL_HOOK_TARGET,JOURNAL_HOOK_TOKEN:process.env.JOURNAL_HOOK_TOKEN}});
hook('SessionStart');hook('UserPromptSubmit');
const {clientFromEnv}=await import(${JSON.stringify(moduleUrl)});const client=clientFromEnv();
let context;for(let i=0;i<100;i++){context=await client.call('get_context');if(context.turnId)break;await new Promise(r=>setTimeout(r,50))}
if(!context.turnId)throw new Error('Observed Claude prompt did not receive a turn ID');
fs.writeFileSync('README.md','Fixture worker completed\\n');
await client.call('report_result',{requestId:'fixture-result',turnId:context.turnId,status:'done',summary:'Fixture worker completion report',testsClaimed:[{command:'project-specific check',outcome:'not-run'}]});
hook('Stop');client.close();fs.writeFileSync(${JSON.stringify(join(root,'reported'))},'reported');
})().catch(e=>{require('node:fs').writeFileSync(${JSON.stringify(join(root,'fixture-error'))},e.stack);console.error(e.message)})}
`); chmodSync(join(bin, 'claude'), 0o755);
  const app = await electron.launch({ args: ['.'], env });
  try {
    await app.evaluate(({ dialog }, path) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click(); await skipFirstRun(page);
    await page.getByRole('radio', { name: 'Coordinate', exact: true }).click(); await taskBox(page).fill('Build the fixture team');
    await page.getByRole('button', { name: /^Start Claude Code/ }).click();
    const team = page.getByRole('region', { name: 'Team', exact: true });
    await expect(team).toContainText('Implement fixture task', { timeout: 20000 });
    await expect(team.getByRole('tab', { name: 'Conversation', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(team).toContainText('I am checking the fixture documentation.');
    await expect(page.locator('.inspector-root')).toHaveCount(0);
    await expect(team).toContainText('Include the setup instructions in this documentation change?');
    await page.screenshot({ path: resolve('.cache/team-conversation-attention.png') });
    await team.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(team.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0);
    // Readability is measured at normal Electron zoom, not compensated by global scaling.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(1);
    for (const [selector, minimum] of [['.team-conversation-log p', 16], ['.team-task-rail', 14], ['.team-tabs button', 14], ['.team-heading h2', 17], ['.team-row time', 13], ['.team-conversation-composer textarea', 16]] as const) {
      const sizes = await team.locator(selector).evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)));
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(minimum);
    }
    await page.setViewportSize({ width: 2308, height: 1078 });
    await page.screenshot({ path: resolve('.cache/team-conversation-wide-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: resolve('.cache/team-conversation-wide-light.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.setViewportSize({ width: 1440, height: 920 });
    await expect(team.getByRole('tab', { name: 'Workers', exact: true })).toHaveCount(0);
    await expect(team.getByRole('complementary', { name: 'Task progress' })).toContainText('Live', { timeout: 15000 });
    await team.getByRole('tab', { name: 'Conversation', exact: true }).focus(); await page.keyboard.press('ArrowRight'); await expect(team.getByRole('tab', { name: 'Results', exact: true })).toBeFocused();
    await team.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await team.getByLabel('Message to coordinator', { exact: true }).fill('Check the fixture result'); await team.getByRole('button', { name: 'Send message', exact: true }).click();
    const sent = team.getByRole('listitem').filter({ hasText: 'Check the fixture result' });
    await expect(sent).toContainText('Queued'); await sent.getByRole('button', { name: 'Cancel message', exact: true }).click(); await expect(sent).toContainText('Cancelled');
    await app.evaluate(() => { (globalThis as any).__journalRequestHook = async (action: string, run: () => Promise<unknown>) => { if (action === 'sendMessage') await new Promise(resolve => setTimeout(resolve, 600)); return run(); }; });
    await team.getByLabel('Message to coordinator', { exact: true }).fill('First instruction');
    await team.getByRole('button', { name: 'Send message', exact: true }).click();
    await team.getByLabel('Message to coordinator', { exact: true }).fill('Keep this later draft');
    await expect(team.getByRole('listitem').filter({ hasText: 'First instruction' })).toContainText('Queued');
    await expect(team.getByLabel('Message to coordinator', { exact: true })).toHaveValue('Keep this later draft');
    await app.evaluate(() => { delete (globalThis as any).__journalRequestHook; });
    await team.getByRole('button', { name: 'Open full native conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await expect(team.getByLabel('Message to coordinator', { exact: true })).toHaveValue('Keep this later draft');
    // A completion from an unmounted panel must not clear a newer panel's draft.
    await app.evaluate(() => { (globalThis as any).__journalRequestHook = async (action: string, run: () => Promise<unknown>) => { if (action === 'sendMessage') await new Promise<void>(resolve => { (globalThis as any).__releaseTeamMessage = resolve; }); return run(); }; });
    await team.getByLabel('Message to coordinator', { exact: true }).fill('Instruction before navigation');
    await team.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__releaseTeamMessage)).toBe('function');
    await team.getByRole('button', { name: 'Open full native conversation', exact: true }).click();
    await expect(page.locator('.inspector-root')).toBeVisible();
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await expect(page.locator('.inspector-root')).toHaveCount(0);
    await team.getByLabel('Message to coordinator', { exact: true }).fill('Keep this remounted draft');
    await app.evaluate(() => { (globalThis as any).__releaseTeamMessage(); delete (globalThis as any).__journalRequestHook; delete (globalThis as any).__releaseTeamMessage; });
    await expect(team.getByRole('listitem').filter({ hasText: 'Instruction before navigation' })).toContainText('Queued', { timeout: 12000 });
    await team.getByRole('button', { name: 'Open full native conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await expect(team.getByLabel('Message to coordinator', { exact: true })).toHaveValue('Keep this remounted draft');
    await team.getByRole('button', { name: 'Write a message', exact: true }).click();
    await expect(team.getByLabel('Message to coordinator', { exact: true })).toBeFocused();
    await pressKey(app, 'E', ['meta']);
    await expect(page.locator('.terminal-panel:not([hidden]) .xterm-helper-textarea').first()).toBeFocused();
    await expect(page.locator('.inspector-root')).toBeVisible();
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await pressKey(app, 'I', ['meta']);
    await expect(page.locator('.inspector-root')).toBeVisible();
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await expect(team).toContainText('I am checking the fixture documentation.');
    await page.screenshot({ path: resolve('.cache/team-conversation-dark.png') });
    await expect.poll(() => existsSync(join(root, 'reported')), { timeout: 15000 }).toBe(true);
    expect(existsSync(join(root, 'fixture-error'))).toBe(false);
    await team.getByRole('button', { name: 'Stop worker and prepare review', exact: true }).click();
    await expect(team).toContainText('Paused', { timeout: 15000 }); await team.getByRole('tab', { name: 'Results', exact: true }).click();
    await expect(team).toContainText('Fixture worker completion report');
    await team.getByText('Changed files (1)', { exact: true }).click();
    await team.getByRole('button', { name: 'M README.md', exact: true }).click();
    await expect(team.locator('pre')).toContainText('+Fixture worker completed');
    await team.getByRole('button', { name: 'Preview Apply', exact: true }).click();
    await expect(team).toContainText('Review this result and choose Accept captured result before Apply.');
    await team.getByRole('button', { name: 'Accept captured result', exact: true }).click();
    await team.getByRole('button', { name: 'Preview Apply', exact: true }).click();
    await expect(team.getByRole('button', { name: 'Apply result', exact: true })).toBeEnabled();
    await expect(team.getByRole('button', { name: 'Run tests in isolation', exact: true })).toHaveCount(0);
    await expect(team).toContainText('Worker test report: project-specific check — not-run');
    await expect(team).not.toContainText('Tests Passed');
    await team.getByRole('button', { name: 'Pause run', exact: true }).click(); await expect(team.getByRole('button', { name: 'Continue run', exact: true })).toBeVisible();
    await page.screenshot({ path: resolve('.cache/team-fixture.png') });
    await team.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await team.getByText('Changed files (1)', { exact: true }).click();
    await team.getByRole('button', { name: 'M README.md', exact: true }).click();
    await expect(team.locator('pre')).toContainText('+Fixture worker completed');
    await page.screenshot({ path: resolve('.cache/team-conversation-result-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: resolve('.cache/team-conversation-result-light.png') });
    await page.setViewportSize({ width: 760, height: 900 });
    await page.screenshot({ path: resolve('.cache/team-conversation-narrow.png') });
    await expect(team).toBeVisible();
    expect(await team.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await team.locator('.team-workspace, .team-content, .team-conversation, .team-inline-results, .team-task-rail').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    expect(await team.locator('.team-task-rail').evaluate(node => node.getBoundingClientRect().top >= document.querySelector('.team-content')!.getBoundingClientRect().bottom - 1)).toBe(true);
    await team.getByRole('complementary', { name: 'Task progress' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve('.cache/team-tasks-narrow-light.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: resolve('.cache/team-tasks-narrow-dark.png') });
    await team.getByRole('button', { name: 'Continue run', exact: true }).click();
    await team.getByRole('button', { name: 'Preview Apply', exact: true }).click();
    await team.getByRole('button', { name: 'Apply result', exact: true }).click();
    await expect(team).toContainText('Applied');
    expect(git('show', 'main:README.md').toString()).toBe('Fixture worker completed\n');
  } finally { await app.close(); await expect.poll(() => existsSync(join(data, 'runtime.json')), { timeout: 20000 }).toBe(false); rmSync(root, { recursive: true, force: true }); }
});
