import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';

// Selectors that the Phase 3 shell changes, behind one helper each. Specs call
// these instead of the selectors, so each group rewrites only the bodies of the
// helpers it owns (docs/superpowers/plans/2026-10-04-ux-redesign-phase-3.md 1.5)
// and the spec diffs stay small. The bodies below are today's implementation.

const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

// ----- Group A: sidebar and settings -----

// Native menus cannot be clicked by automation. In headless runs main hands
// each menu to globalThis.__journalMenuHook, which records the items in
// __lastMenu and returns the chosen id; `pick` chooses from the items.
async function withMenu(app: ElectronApplication, pick: { id?: string | null; labelStartsWith?: string }, open: () => Promise<void>) {
  await app.evaluate((_electron, choice) => {
    (globalThis as any).__journalMenuHook = (items: any[]) => {
      (globalThis as any).__lastMenu = items;
      if (choice.labelStartsWith !== undefined) return items.find(item => String(item.id ?? '').startsWith('project:') && String(item.label).startsWith(choice.labelStartsWith!))?.id ?? null;
      return choice.id ?? null;
    };
  }, pick);
  await open();
}
const switcher = (page: Page) => page.locator('.project-switcher');

// The current project's name.
export const currentProject = (page: Page): Locator => switcher(page).locator('.project-name');

// Every project's name, in the order Journal lists them (the switcher menu).
export async function projectNames(app: ElectronApplication, page: Page): Promise<string[]> {
  await withMenu(app, { id: null }, () => switcher(page).click());
  await expect.poll(() => app.evaluate(() => Array.isArray((globalThis as any).__lastMenu))).toBe(true);
  return app.evaluate(() => ((globalThis as any).__lastMenu as any[]).filter(item => String(item.id ?? '').startsWith('project:')).map(item => String(item.label).replace(/ · (Pinned|Current)/g, '')));
}

// Makes the project whose name starts with `name` current.
export async function switchProject(app: ElectronApplication, page: Page, name: string) {
  await withMenu(app, { labelStartsWith: name }, () => switcher(page).click());
  await expect(currentProject(page)).toHaveText(startsWith(name));
}

// Opens another project (the caller stubs dialog.showOpenDialog first). With no
// project open, the switcher opens one directly.
export async function openAnotherProject(app: ElectronApplication, page: Page) {
  await withMenu(app, { id: 'open-project' }, () => switcher(page).click());
}

// The element whose right-click opens the current project's context menu.
export const projectContextMenu = (page: Page): Locator => switcher(page);

// Opens Manage project for the project named `name` (switching to it first).
export async function manageProject(app: ElectronApplication, page: Page, name: string) {
  if ((await currentProject(page).textContent()) !== name) await switchProject(app, page, name);
  await withMenu(app, { id: 'manage' }, () => switcher(page).click());
}

// Switches the appearance to `theme` in Settings (no-op if it is already set).
export async function setTheme(page: Page, theme: 'dark' | 'light') {
  if (await page.evaluate(() => document.documentElement.dataset.theme) === theme) return;
  await openSettings(page, 'appearance');
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).check();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done', exact: true }).click();
}

// Opens Settings from the sidebar footer. `section` names the part a spec needs next.
export async function openSettings(page: Page, _section?: 'appearance' | 'notifications' | 'updates' | 'data') {
  await page.locator('.sidebar-footer').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
}

// The Active group's count of used slots, showing `n` of the four.
export const slotsUsed = (page: Page, n: number): Locator => page.locator('.slots-used', { hasText: new RegExp(`^${n} of 4$`) });

// ----- Group B: session header, status bar and inspector -----

// Shows the New session view before a start (no-op if it is already shown).
export async function newSession(page: Page) {
  if (await page.getByLabel('Initial task').count()) return;
  await page.locator('.sidebar .new-session').click();
  await expect(page.getByLabel('Initial task')).toBeVisible();
}

// The selected session's state line (provider, workspace, mode, start time and state).
export const sessionStatus = (page: Page): Locator => page.locator('.session-header .session-meta');

// The selected session's action buttons (Interrupt, Stop, Continue, Archive, More).
export const sessionActions = (page: Page): Locator => page.locator('.session-actions');

// Selects an inspector tab and returns it.
export async function inspectorTab(page: Page, name: 'Session' | 'Files' | 'Memory'): Promise<Locator> {
  const tab = page.getByRole('tab', { name: startsWith(name) });
  const railButton = page.locator('.inspector-rail').getByRole('button', { name: startsWith(name) });
  // Wait for the shell to render one of the two before choosing.
  await expect(tab.or(railButton).first()).toBeVisible();
  // A medium or narrow window folds the inspector into a rail: its button opens the overlay on that tab.
  if (!await tab.count()) await railButton.click();
  await tab.click();
  return tab;
}

// Chooses the Files tab's view (only shown while a session is selected).
export async function filesView(page: Page, view: 'changed' | 'all') {
  const group = page.getByRole('radiogroup', { name: 'Files view' });
  if (!await group.count()) return;
  await group.getByRole('radio', { name: view === 'changed' ? /^Changed/ : /^All files/ }).check();
}

// The bar under the terminal.
export const statusBar = (page: Page): Locator => page.locator('.status-bar');

// ----- Group C: layout, rails and overlay -----

// The button that hides or shows the inspector.
export const inspectorToggle = (page: Page, action: 'hide' | 'show'): Locator =>
  page.getByRole('button', { name: action === 'hide' ? 'Hide inspector' : 'Show inspector', exact: true });

// Makes the window wide enough for the docked inspector and both separators (1440 px of content or more).
export async function ensureWide(app: ElectronApplication, page?: Page) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
  if (page) await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1440);
}
