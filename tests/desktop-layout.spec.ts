import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
import { ensureWide, inspectorToggle, setTheme } from './support/ui';

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
    await ensureWide(app, page);
    await page.getByRole('button', { name: 'Open a project…', exact: true }).first().click();
    const left = page.getByRole('separator', { name: 'Resize project sidebar', exact: true });
    const right = page.getByRole('separator', { name: 'Resize side panel', exact: true });
    await expect(left).toBeVisible(); await expect(right).toBeVisible();
    // Type floor (design board B8): nothing outside the terminal renders below 11 px.
    expect(await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter(element => !element.closest('.xterm') && element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < 11)
      .map(element => `${element.tagName.toLowerCase()}.${element.className}`))).toEqual([]);
    const width = (selector: string) => page.locator(selector).evaluate(element => element.getBoundingClientRect().width);
    // The Active heading ("Active", "n of 4" and the meter) keeps its parts apart and fits the sidebar.
    const captionGaps = () => page.locator('.side-heading').first().evaluate(heading => {
      const [label, count] = [...heading.children].map(child => child.getBoundingClientRect()); const box = heading.getBoundingClientRect();
      return count.left - label.right >= 6 && count.right <= box.right + 0.5;
    });
    expect(await captionGaps()).toBe(true);
    expect(await page.locator('.slots-used').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
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
    expect(await ringClear(inspectorToggle(page, 'hide'))).toBe('clear');
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
    // Medium (1280) folds the inspector into a rail; narrow (1024) folds both. Automatic rails never
    // overwrite the stored widths or collapse preferences.
    const resize = async (width: number, height: number) => { await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height }); await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width); };
    await resize(1280, 800);
    await expect(right).toHaveCount(0); await expect(left).toBeVisible();
    await expect(page.locator('.inspector-rail [aria-label^="Session"], .inspector-rail [aria-label^="Files"], .inspector-rail [aria-label^="Memory"]')).toHaveCount(3);
    await resize(1024, 720);
    await expect(page.getByRole('separator')).toHaveCount(0);
    await expect(page.locator('.sidebar-rail')).toBeVisible(); await expect(page.locator('.inspector-rail')).toBeVisible();
    expect(await page.locator('.app-shell').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await resize(900, 640);
    await expect.poll(() => width('.workspace')).toBeGreaterThanOrEqual(340);
    expect(await page.locator('.app-shell').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await resize(1600, 900);
    await expect.poll(() => width('.sidebar')).toBe(initialLeft + 62);
    await expect.poll(() => width('.knowledge-panel')).toBe(initialRight + 82);
    expect(await captionGaps()).toBe(true);
    expect(await page.evaluate(() => [localStorage.getItem('journal-sidebar-collapsed'), localStorage.getItem('journal-panel-collapsed')])).toEqual([null, null]);
    // In a wide window the shortcuts collapse both panes to rails, and that choice survives a reload.
    const mac = process.platform === 'darwin';
    await page.locator('.workspace').click({ position: { x: 5, y: 5 } });
    await expect(async () => { await pressKey(app, '\\', mac ? ['meta'] : ['control', 'shift']); await expect(page.locator('.sidebar-rail')).toBeVisible({ timeout: 1000 }); }).toPass();
    await expect(async () => { await pressKey(app, mac ? 'I' : 'B', mac ? ['meta'] : ['control', 'shift']); await expect(page.locator('.inspector-rail')).toBeVisible({ timeout: 1000 }); }).toPass();
    await page.reload();
    await expect(page.locator('.sidebar-rail')).toBeVisible(); await expect(page.locator('.inspector-rail')).toBeVisible();
    await expect(page.getByRole('separator')).toHaveCount(0);
    expect(await ringClear(inspectorToggle(page, 'show'))).toBe('clear');
    await page.getByRole('button', { name: 'Expand sidebar' }).click(); await inspectorToggle(page, 'show').click();
    await expect(left).toBeVisible(); await expect(right).toBeVisible();
    await left.dblclick(); await right.dblclick();
    await expect.poll(() => width('.sidebar')).toBe(initialLeft);
    await expect.poll(() => width('.knowledge-panel')).toBe(initialRight);
    await setTheme(page, 'light');
    await page.getByRole('tab', { name: /^Memory/ }).hover();
    mkdirSync(resolve('.cache/screenshots'), { recursive: true });
    await page.screenshot({ path: resolve('.cache/screenshots/journal-resizable-light.png') });
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
