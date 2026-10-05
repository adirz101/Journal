import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectorTab, skipFirstRun, startSession } from './support/ui';
import { fixtureEnv } from './support/env';

// The Session tab's Story, end to end: a fixture Claude plays a scripted session through
// Journal's real hook launcher (PreToolUse/PostToolUse payloads as Claude sends them); the
// runtime records the events; the Story shows a few rows and Details keeps the raw evidence.
test.skip(process.platform === 'win32', 'POSIX fixture CLI');

type Hook = [string, Record<string, unknown>];
let n = 0;
const bash = (command: string, { exit = 0, description }: { exit?: number; description?: string } = {}): Hook[] => {
  const id = `bash${++n}`; const input = { command, ...(description ? { description } : {}) };
  return [['PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: input }],
    exit ? ['PostToolUseFailure', { tool_name: 'Bash', tool_use_id: id, tool_input: input, error: `Exit code ${exit}` }] : ['PostToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: input, tool_response: {} }]];
};
const tool = (name: string, input: Record<string, unknown>): Hook[] => [['PostToolUse', { tool_name: name, tool_use_id: `${name}${++n}`, tool_input: input, tool_response: {} }]];

function setup(script: Hook[]) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'story-')); const project = resolve(root, 'project'); const bin = resolve(root, 'bin');
  for (const dir of [project, bin, resolve(project, 'src')]) mkdirSync(dir);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { stdio: 'pipe', env });
  git('init', '-q', '-b', 'main'); writeFileSync(resolve(project, 'src', 'upload.ts'), 'export {};\n'); git('add', '.'); git('commit', '-qm', 'init');
  // Plays each hook in order through the launcher in the session's settings, then prints PLAYED.
  writeFileSync(resolve(bin, 'claude'), `#!${process.execPath}
const fs=require('node:fs');const {spawn}=require('node:child_process');const path=require('node:path');
if(process.argv.includes('--version')){console.log('2.1.286 (Claude Code)');process.exit(0)}
const a=process.argv;const hooks=JSON.parse(fs.readFileSync(a[a.indexOf('--settings')+1],'utf8')).hooks;
const session=a[a.indexOf('--session-id')+1];const script=${JSON.stringify(script)};
const abs=v=>typeof v==='string'&&v.startsWith('@')?path.resolve(v.slice(1)):v;
const play=i=>{if(i>=script.length){console.log('PLAYED');return}const [event,fields]=script[i];
const input=fields.tool_input?Object.fromEntries(Object.entries(fields.tool_input).map(([k,v])=>[k,abs(v)])):undefined;
const c=spawn('/bin/sh',['-c',hooks[event][0].hooks[0].command],{stdio:['pipe','ignore','ignore']});c.on('exit',()=>setTimeout(()=>play(i+1),20));
c.stdin.end(JSON.stringify({hook_event_name:event,session_id:session,cwd:process.cwd(),...fields,...(input?{tool_input:input}:{})}))};
console.log('READY');play(0);process.stdin.resume();`);
  chmodSync(resolve(bin, 'claude'), 0o755);
  return { root, project, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function open(f: ReturnType<typeof setup>) {
  const app = await electron.launch({ args: ['.'], env: f.env });
  await app.evaluate(({ dialog }, p) => { (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, f.project);
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
  await skipFirstRun(page);
  await startSession(page, 'claude', { task: '' });
  await expect(page.locator('.xterm-rows')).toContainText('PLAYED', { timeout: 20000 });
  await inspectorTab(page, 'Session');
  return { app, page };
}
const rows = (page: import('@playwright/test').Page) => page.locator('.story-list > .story-row');

test('without a plan: a few deterministic rows; descriptions in the steps; raw commands in Details', async () => {
  const script: Hook[] = [['UserPromptSubmit', {}], ...bash('cd src'), ...bash('cd ..'), ...bash('sed -n 1,40p src/upload.ts'), ...bash('grep -rn retry src'),
    ...tool('Read', { file_path: '@src/upload.ts' }), ...tool('Edit', { file_path: '@src/upload.ts' }), ...tool('Write', { file_path: '@src/retry.ts' }),
    ...bash('npm test', { exit: 1, description: 'Run the test suite' }), ...tool('Edit', { file_path: '@src/retry.ts' }), ...bash('npm test', { description: 'Run the test suite' }),
    ...bash('git add -A && git commit -m "Add retry to the uploader"'), ['Stop', {}]];
  const f = setup(script); const { app, page } = await open(f);
  try {
    await expect(rows(page)).toHaveCount(4);
    await expect(rows(page).locator('.story-title')).toHaveText([/^Investigated/, /^Implemented changes/, /^Ran tests/, /^Committed changes/]);
    await expect(rows(page).nth(0).locator('.story-meta')).toHaveText(/^1 file read · 1 search/);
    // A Write may create or overwrite: the hook does not say which, so it counts as changed.
    await expect(rows(page).nth(1).locator('.story-meta')).toHaveText(/^2 files changed/);
    await expect(rows(page).nth(2).locator('.story-meta')).toHaveText(/^2 runs · 1 passed · 1 failed/);
    await expect(rows(page).nth(2)).toHaveClass(/status-passed/);
    await expect(rows(page).nth(3).locator('.story-meta')).toHaveText('Add retry to the uploader');
    await expect(page.locator('.story')).not.toContainText('cd src');
    // A row's steps use the agent's description instead of the command.
    await rows(page).nth(2).getByRole('button').click();
    await expect(rows(page).nth(2).getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    await expect(rows(page).nth(2).locator('.story-items')).toContainText('Run the test suite');
    await expect(rows(page).nth(2).locator('.story-items .story-failed')).toHaveCount(1);
    // Details: the exact commands, exits and the timeline.
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(page.locator('.raw-activity .did-list')).toContainText('cd src');
    await expect(page.locator('.raw-activity .did-list')).toContainText('exit 1');
    await expect(page.locator('.raw-activity')).toContainText('Timeline');
  } finally { await app.close().catch(() => {}); f.cleanup(); }
});

test('with a plan: the agent\'s plan items are the rows, with the evidence under each', async () => {
  const todos = (statuses: string[]) => tool('TodoWrite', { todos: [['Investigate the uploader', statuses[0]], ['Add retries', statuses[1]], ['Run tests', statuses[2]]].map(([content, status]) => ({ content, status, activeForm: content })) });
  const script: Hook[] = [['UserPromptSubmit', {}], ...todos(['in_progress', 'pending', 'pending']), ...bash('cat src/upload.ts'),
    ...todos(['completed', 'in_progress', 'pending']), ...tool('Edit', { file_path: '@src/upload.ts' }),
    ...todos(['completed', 'completed', 'in_progress']), ...bash('npm test'), ['Stop', {}]];
  const f = setup(script); const { app, page } = await open(f);
  try {
    const plan = page.getByRole('region', { name: 'Plan' });
    await expect(plan.locator('.story-title')).toHaveText([/^Investigate the uploader/, /^Add retries/, /^Run tests/]);
    await expect(plan.locator('.story-meta')).toHaveText(['1 read', '1 file changed', 'tests passed']);
    await expect(plan.locator('.story-row').nth(2)).toHaveClass(/status-active/);
  } finally { await app.close().catch(() => {}); f.cleanup(); }
});
