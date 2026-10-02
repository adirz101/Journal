import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';

test('reviewed file knowledge reaches a real PTY and survives renderer and app restart', async () => {
  test.skip(process.platform === 'win32', 'Windows native desktop smoke requires a separate real-machine fixture');
  const base = resolve('.cache/tmp'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(resolve(base, 'desktop-')); const project = resolve(root, 'fixture project'); const bin = resolve(root, 'bin');
  mkdirSync(project); mkdirSync(bin);
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); writeFileSync(resolve(project, 'README.md'), 'Fixture tests require Docker.\n');
  git('add', 'README.md'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const fixture = `#!${process.execPath}
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
console.log('PTY_READY '+process.stdout.isTTY);console.log('ARGS '+JSON.stringify(process.argv.slice(2)));
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let input='';let responses=0;
process.stdin.on('data',data=>{
  data=data.replace(/\\x1b\\[\\d+;\\d+R/g,()=>{responses++;console.log('DEVICE_RESPONSE');return ''});
  for(const char of data){
    if(char==='\\x03'){console.log('INTERRUPTED');continue}
    if(char!=='\\r'&&char!=='\\n'){input+=char;continue}
    const command=input;input='';
    if(command==='device-query')process.stdout.write('\\x1b[6n');
    else if(command==='response-count')console.log('RESPONSE_COUNT '+responses);
    else if(command==='flood'){process.stdout.write('flood-line\\n'.repeat(200000));console.log('FLOOD_COMPLETE')}
    else console.log('ECHO '+command);
  }
});`;
  for (const provider of ['claude', 'codex']) { writeFileSync(resolve(bin, provider), fixture); chmodSync(resolve(bin, provider), 0o755); }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' }; delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: ['.'], env });
  app.process().stderr?.on('data', chunk => process.stderr.write(chunk));
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Your project, remembered.' })).toBeVisible();
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await expect(page.getByText('fixture project', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Add knowledge' }).first().click();
    await page.getByRole('textbox', { name: 'Statement', exact: true }).fill('Fixture tests require Docker');
    await page.getByLabel('Source type').selectOption('file');
    await page.getByLabel('Source path').fill('README.md');
    await page.getByRole('button', { name: 'Save for review' }).click();
    await expect(page.getByText('Fixture tests require Docker', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByLabel('Initial task').fill('Review Docker tests');
    await page.getByRole('button', { name: 'Preview context' }).click();
    await expect(page.getByTestId('context-packet')).toContainText('Fixture tests require Docker');
    await page.getByRole('button', { name: 'Start Claude' }).click();
    await expect(page.getByLabel('Initial task')).toHaveValue('');
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY true');
    await expect(page.locator('.terminal-surface')).toContainText('Fixture tests require Docker');
    // The terminal is a real native PTY; user input traverses the preload and owned session.
    await page.locator('.xterm-helper-textarea').pressSequentially('hello-terminal');
    await page.locator('.xterm-helper-textarea').press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO hello-terminal');
    await page.locator('.xterm-helper-textarea').pressSequentially('device-query');
    await page.locator('.xterm-helper-textarea').press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('DEVICE_RESPONSE');
    // Appearance and panel resizing must retain the live terminal, native session and receipt.
    const terminalElement = await page.locator('.xterm').elementHandle();
    const beforeTheme = await page.evaluate(async () => (await (window as any).journal.request('bootstrap')).live.map((x: any) => x.id));
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
    await expect(page.locator('.brand-icon')).toHaveAttribute('src', /\/journal-mark-(?!white-)[^.]+\.png$/);
    await expect(page.locator('.xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await page.getByRole('separator', { name: 'Resize project sidebar', exact: true }).press('ArrowRight');
    await page.getByRole('separator', { name: 'Resize knowledge sidebar', exact: true }).press('ArrowLeft');
    expect(await terminalElement!.evaluate(element => element.isConnected)).toBe(true);
    expect(await page.evaluate(async () => (await (window as any).journal.request('bootstrap')).live.map((x: any) => x.id))).toEqual(beforeTheme);
    await page.locator('.xterm-helper-textarea').pressSequentially('after-theme');
    await page.locator('.xterm-helper-textarea').press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO after-theme');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 640));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO hello-terminal');
    // A small viewport shows only recent rows. Verify earlier output by scrolling
    // through retained history, rather than requiring it to remain on screen.
    for (let i = 0; i < 8; i++) await page.locator('.xterm-helper-textarea').press('Shift+PageUp');
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY true');
    for (let i = 0; i < 8; i++) await page.locator('.xterm-helper-textarea').press('Shift+PageDown');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO hello-terminal');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.locator('.xterm-helper-textarea').pressSequentially('response-count');
    await page.locator('.xterm-helper-textarea').press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('RESPONSE_COUNT 1');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await page.locator('.xterm-helper-textarea').pressSequentially('flood');
    await page.locator('.xterm-helper-textarea').press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('FLOOD_COMPLETE', { timeout: 15000 });
    await page.getByRole('button', { name: /^Interrupt/ }).click();
    await expect(page.locator('.terminal-surface')).toContainText('INTERRUPTED');
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect(page.locator('.terminal-label')).toContainText('stopped');
    await page.getByRole('button', { name: 'Resume', exact: true }).first().click();
    await expect(page.locator('.terminal-surface')).toContainText('--resume');
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect(page.locator('.terminal-label')).toContainText('stopped');
    // Reviewed knowledge is provider-neutral; Codex needs an explicitly confirmed UUID.
    await page.getByLabel('Initial task').fill('Docker tests');
    await page.getByRole('button', { name: 'Start Codex', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('Fixture tests require Docker');
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect(page.getByLabel('Native session ID')).toBeVisible();
    await page.getByLabel('Native session ID').fill('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
    await page.getByRole('button', { name: 'Confirm resume ID' }).click();
    await page.locator('.terminal-actions').getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
    await expect(page.locator('.terminal-surface')).toContainText('Fixture tests require Docker');
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect(page.locator('.terminal-label')).toContainText('stopped');
    // Selecting a confirmed older session must not prefill a new conversation's ID.
    await page.getByRole('button', { name: /^Codex:/ }).first().click();
    await page.getByLabel('Initial task').fill('Docker tests NEW_CODEX_SESSION_MARKER');
    await page.getByRole('button', { name: 'Start Codex', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('NEW_CODEX_SESSION_MARKER');
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect(page.getByLabel('Native session ID')).toHaveValue('');
    // Security boundary rejects arbitrary IPC actions and filesystem operations.
    const error = await page.evaluate(async () => {
      try { await (window as any).journal.request('readFile', { path: '/etc/passwd' }); return 'allowed'; }
      catch (error) { return String(error); }
    });
    expect(error).toContain('Unknown desktop action');
    await app.close();
    app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await page.getByRole('button', { name: /fixture project/ }).click();
    await expect(page.getByText('Fixture tests require Docker', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await expect(page.getByTestId('context-packet')).toContainText('Fixture tests require Docker');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    mkdirSync(resolve('.cache/screenshots'), { recursive: true });
    await page.screenshot({ path: resolve('.cache/screenshots/journal-light.png') });
    await page.getByRole('tab', { name: /Knowledge/ }).click();
    await page.screenshot({ path: resolve('.cache/screenshots/journal-light-knowledge.png') });
    await page.getByRole('button', { name: 'Add knowledge' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: resolve('.cache/screenshots/journal-light-dialog.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.brand-icon')).toHaveAttribute('src', /journal-mark-white-/);
    await page.screenshot({ path: resolve('.cache/screenshots/journal-desktop.png') });
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
