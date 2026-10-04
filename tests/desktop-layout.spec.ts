import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('both sidebars resize by pointer and keyboard, persist, and leave room for the workspace', async () => {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const directory = mkdtempSync(resolve('.cache/tmp', 'layout-')); const project = resolve(directory, 'layout project');
  mkdirSync(project);
  execFileSync('git', ['-C', project, 'init', '-b', 'main'], { stdio: 'pipe' });
  writeFileSync(resolve(project, 'README.md'), 'Local layout fixture.\n');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), JOURNAL_DATA_DIR: resolve(directory, 'data'), JOURNAL_QUIT_POLICY: 'stop' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env });
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    const left = page.getByRole('separator', { name: 'Resize project sidebar', exact: true });
    const right = page.getByRole('separator', { name: 'Resize knowledge sidebar', exact: true });
    await expect(left).toBeVisible(); await expect(right).toBeVisible();
    // Type floor (design board B8): nothing outside the terminal renders below 11 px.
    expect(await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter(element => !element.closest('.xterm') && element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < 11)
      .map(element => `${element.tagName.toLowerCase()}.${element.className}`))).toEqual([]);
    const width = (selector: string) => page.locator(selector).evaluate(element => element.getBoundingClientRect().width);
    // The sessions caption ("SESSIONS", "n/4 active", New) keeps its parts apart instead of running them together.
    const captionGaps = () => page.locator('.sessions-caption').evaluate(caption => {
      const range = document.createRange(); range.selectNodeContents([...caption.childNodes].find(node => node.nodeType === Node.TEXT_NODE)!);
      const [label, count, button, box] = [range.getBoundingClientRect(), caption.querySelector('span')!.getBoundingClientRect(), caption.querySelector('button')!.getBoundingClientRect(), caption.getBoundingClientRect()];
      return Math.min(count.left - label.right, button.left - count.right, box.right - button.right) >= 0 && count.left - label.right >= 6;
    });
    expect(await captionGaps()).toBe(true);
    // At the default sidebar width the count fits whole; it only truncates in narrower sidebars.
    expect(await page.locator('.sessions-caption>span').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    // Focus rings stay inside every clipping ancestor (scroll containers clip a ring drawn outside the control).
    const ringClear = (locator: ReturnType<typeof page.locator>) => locator.evaluate(element => {
      (element as HTMLElement).focus({ focusVisible: true } as FocusOptions);
      const painter = [element, ...element.querySelectorAll('*')].find(node => getComputedStyle(node).outlineStyle !== 'none');
      if (!painter) return 'no focus ring';
      const style = getComputedStyle(painter); const grow = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset); const ring = painter.getBoundingClientRect();
      for (let clip = painter.parentElement; clip; clip = clip.parentElement) {
        const clipStyle = getComputedStyle(clip); if (clipStyle.overflowX === 'visible' && clipStyle.overflowY === 'visible') continue;
        const box = clip.getBoundingClientRect(); const left = box.left + parseFloat(clipStyle.borderLeftWidth); const top = box.top + parseFloat(clipStyle.borderTopWidth);
        if (ring.left - grow < left - 0.5 || ring.top - grow < top - 0.5 || ring.right + grow > left + clip.clientWidth + 0.5 || ring.bottom + grow > top + clip.clientHeight + 0.5) return `clipped by .${clip.className}`;
      }
      return 'clear';
    });
    for (const tab of await page.getByRole('tab').all()) if (await tab.isEnabled()) expect(await ringClear(tab)).toBe('clear');
    expect(await ringClear(page.getByRole('button', { name: 'Hide side panel' }))).toBe('clear');
    const drag = async (handle: typeof left, distance: number) => {
      const box = await handle.boundingBox(); expect(box).not.toBeNull();
      const x = box!.x + box!.width / 2; const y = box!.y + 180;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + distance, y, { steps: 6 }); await page.mouse.up();
      const workspace = await page.locator('.workspace').boundingBox();
      await page.mouse.move(workspace!.x + 100, y);
      await expect(handle).not.toBeFocused();
      await expect.poll(() => handle.evaluate(element => getComputedStyle(element, '::after').backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    };
    const initialLeft = await width('.sidebar'); const initialRight = await width('.knowledge-panel');
    await drag(left, 70);
    await expect.poll(() => width('.sidebar')).toBe(initialLeft + 70);
    await drag(right, -90);
    await expect.poll(() => width('.knowledge-panel')).toBe(initialRight + 90);
    await left.focus(); await page.keyboard.press('ArrowLeft');
    await expect.poll(() => width('.sidebar')).toBe(initialLeft + 62);
    await right.focus(); await page.keyboard.press('ArrowRight');
    await expect.poll(() => width('.knowledge-panel')).toBe(initialRight + 82);
    await page.reload();
    await expect.poll(() => width('.sidebar')).toBe(initialLeft + 62);
    await expect.poll(() => width('.knowledge-panel')).toBe(initialRight + 82);
    // Viewport constraints must not overwrite the user's wider-window preference.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 640));
    await expect.poll(() => width('.workspace')).toBeGreaterThanOrEqual(340);
    expect(await page.locator('.app-shell').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await captionGaps()).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await expect.poll(() => width('.sidebar')).toBe(initialLeft + 62);
    await expect.poll(() => width('.knowledge-panel')).toBe(initialRight + 82);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 640));
    await right.focus(); await page.keyboard.press('End');
    await expect.poll(() => width('.workspace')).toBeGreaterThanOrEqual(340);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await left.dblclick(); await right.dblclick();
    await expect.poll(() => width('.sidebar')).toBe(initialLeft);
    await expect.poll(() => width('.knowledge-panel')).toBe(initialRight);
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
    await page.getByRole('tab', { name: /^Knowledge/ }).hover();
    mkdirSync(resolve('.cache/screenshots'), { recursive: true });
    await page.screenshot({ path: resolve('.cache/screenshots/journal-resizable-light.png') });
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
