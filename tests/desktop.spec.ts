import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectContext, inspectorTab, newSession, sessionActions, sessionStatus, setTheme, startSession, switchProject } from './support/ui';
import { fixtureEnv } from './support/env';

test('reviewed file knowledge reaches a real PTY and survives renderer and app restart', async () => {
  // A long scenario: each start now begins with New session (Phase 3 split view), and hidden test windows click slowly.
  test.setTimeout(120_000);
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
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop' } });
  let app = await electron.launch({ args: ['.'], env });
  app.process().stderr?.on('data', chunk => process.stderr.write(chunk));
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Your agents remember your project' })).toBeVisible();
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    await expect(page.getByText('fixture project', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Add a note' }).first().click();
    await page.getByRole('textbox', { name: 'Statement', exact: true }).fill('Fixture tests require Docker');
    await page.getByLabel('Source type').selectOption('file');
    await page.getByLabel('Source path').fill('README.md');
    await page.getByRole('button', { name: 'Save for review' }).click();
    await expect(page.getByText('Fixture tests require Docker', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remember', exact: true }).click();
    await newSession(page); await page.getByLabel('Task', { exact: true }).fill('Review Docker tests');
    await inspectContext(page);
    await expect(page.getByTestId('context-packet')).toContainText('Fixture tests require Docker');
    await startSession(page, 'claude');
    // The session view replaces the form; the next New session starts with an empty task.
    await expect(page.getByLabel('Task', { exact: true })).toHaveCount(0);
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY true');
    await newSession(page); await expect(page.getByLabel('Task', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: /^Claude Code: Review Docker tests\./ }).click();
    await expect(page.locator('.terminal-surface')).toContainText('Fixture tests require Docker');
    // The provider mark sits next to the name; the session row's accessible name is unchanged.
    await expect(page.locator('.session-header .provider-mark.claude svg')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Claude Code: Review Docker tests\./ })).toBeVisible();
    // Each session row carries its own aria-hidden mark.
    await expect(page.getByRole('button', { name: /^Claude Code: Review Docker tests\./ }).locator('.provider-mark.claude[aria-hidden="true"] svg')).toBeVisible();
    // JetBrains Mono ships inside the app (CSP font-src 'self') and the terminal uses it.
    expect(await page.evaluate(() => [...document.fonts].some(face => face.family.replace(/"/g, '') === 'JetBrains Mono' && face.status === 'loaded'))).toBe(true);
    await expect(page.locator('.xterm-rows')).toHaveCSS('font-family', /^"JetBrains Mono"/);
    // Semibold (bold), italic and bold italic faces are bundled too; font-synthesis is off, so a missing face would render upright or thin.
    await page.evaluate(() => Promise.all([document.fonts.load('600 13px "JetBrains Mono"'), document.fonts.load('italic 400 13px "JetBrains Mono"'), document.fonts.load('italic 600 13px "JetBrains Mono"')]));
    expect(await page.evaluate(() => [document.fonts.check('600 13px "JetBrains Mono"'), document.fonts.check('italic 400 13px "JetBrains Mono"'), document.fonts.check('italic 600 13px "JetBrains Mono"')])).toEqual([true, true, true]);
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
    await setTheme(page, 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
    await expect(page.locator('.brand-icon')).toHaveAttribute('src', /\/journal-mark-(?!white-)[^.]+\.png$/);
    await expect(page.locator('.xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(250, 250, 251)');
    await page.getByRole('separator', { name: 'Resize project sidebar', exact: true }).press('ArrowRight');
    await page.getByRole('separator', { name: 'Resize side panel', exact: true }).press('ArrowLeft');
    expect(await terminalElement!.evaluate(element => element.isConnected)).toBe(true);
    expect(await page.evaluate(async () => (await (window as any).journal.request('bootstrap')).live.map((x: any) => x.id))).toEqual(beforeTheme);
    await page.locator('.xterm-helper-textarea').pressSequentially('after-theme');
    await page.locator('.xterm-helper-textarea').press('Enter');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO after-theme');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 640));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // A small viewport shows only part of the history. Verify retained history by
    // scrolling through it, a page at a time, rather than requiring earlier output to remain on screen.
    const surface = page.locator('.terminal-surface'); const rows = page.locator('.xterm-rows');
    const scrollTo = async (key: string, text: string) => {
      for (let i = 0; i < 60; i++) {
        const before = await rows.textContent();
        if (before?.includes(text)) break;
        await page.locator('.xterm-helper-textarea').press(key);
        // xterm paints on the next animation frame: wait for the rows to change before reading them again.
        await expect.poll(() => rows.textContent()).not.toBe(before);
      }
      await expect(surface).toContainText(text);
    };
    await expect(surface).toContainText('ECHO after-theme');
    // Floor: at 900x640 the session view (no launch form above the terminal) and the narrow rails keep at least 10 rows.
    await expect.poll(() => rows.locator(':scope > div').count()).toBeGreaterThanOrEqual(10);
    await scrollTo('Shift+PageUp', 'PTY_READY true');
    await scrollTo('Shift+PageDown', 'ECHO hello-terminal');
    await scrollTo('Shift+PageDown', 'ECHO after-theme');
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
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
    await expect(page.locator('.terminal-surface')).toContainText('--resume');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    // Reviewed knowledge is provider-neutral; Codex needs an explicitly confirmed UUID.
    await newSession(page); await expect(page.getByLabel('Task', { exact: true })).toHaveValue('');
    await startSession(page, 'codex', { task: 'Docker tests' });
    await expect(page.locator('.terminal-surface')).toContainText('Fixture tests require Docker');
    // Codex shows the OpenAI mark in its heading and in its session row, hidden from assistive technology.
    await expect(page.locator('.session-header .provider-mark.codex[aria-hidden="true"] svg')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Codex:/ }).first().locator('.provider-mark.codex[aria-hidden="true"] svg')).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    // Phase 6: an ended session opens on its wrap-up, whose Continue card holds the confirm row.
    await expect(page.getByLabel('Conversation ID')).toBeVisible();
    await page.getByLabel('Conversation ID').fill('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
    await page.getByRole('button', { name: 'Confirm conversation ID' }).click();
    await page.locator('.wrap-up').getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toContainText('bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
    await expect(page.locator('.terminal-surface')).toContainText('Fixture tests require Docker');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(sessionStatus(page)).toContainText('Stopped');
    // Selecting a confirmed older session must not prefill a new conversation's ID.
    await page.getByRole('button', { name: /^Codex:/ }).first().click();
    await startSession(page, 'codex', { task: 'Docker tests NEW_CODEX_SESSION_MARKER' });
    await expect(page.locator('.terminal-surface')).toContainText('NEW_CODEX_SESSION_MARKER');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByLabel('Conversation ID')).toHaveValue('');
    // Security boundary rejects arbitrary IPC actions and filesystem operations.
    const error = await page.evaluate(async () => {
      try { await (window as any).journal.request('readFile', { path: '/etc/passwd' }); return 'allowed'; }
      catch (error) { return String(error); }
    });
    expect(error).toContain('Unknown desktop action');
    await app.close();
    app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await switchProject(app, page, 'fixture project');
    await expect(page.getByText('Fixture tests require Docker', { exact: true })).toBeVisible();
    await inspectorTab(page, 'Session');
    await expect(page.getByTestId('context-packet')).toContainText('Fixture tests require Docker');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    mkdirSync(resolve('.cache/screenshots'), { recursive: true });
    await page.screenshot({ path: resolve('.cache/screenshots/journal-light.png') });
    await inspectorTab(page, 'Memory');
    await page.screenshot({ path: resolve('.cache/screenshots/journal-light-knowledge.png') });
    await page.getByRole('button', { name: 'Add a note' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: resolve('.cache/screenshots/journal-light-dialog.png') });
    await page.keyboard.press('Escape');
    await inspectorTab(page, 'Session');
    await setTheme(page, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.brand-icon')).toHaveAttribute('src', /journal-mark-white-/);
    await page.screenshot({ path: resolve('.cache/screenshots/journal-desktop.png') });
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
