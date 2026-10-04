import type { ElectronApplication, Locator, Page } from '@playwright/test';

// Selectors that the Phase 3 shell changes, behind one helper each. Specs call
// these instead of the selectors, so each group rewrites only the bodies of the
// helpers it owns (docs/superpowers/plans/2026-10-04-ux-redesign-phase-3.md 1.5)
// and the spec diffs stay small. The bodies below are today's implementation.

const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

// ----- Group A: sidebar and settings -----

// The current project's name.
export const currentProject = (page: Page): Locator => page.locator('.workspace-heading h1');

// Every project's name, in the order Journal lists them.
export const projectNames = (_app: ElectronApplication, page: Page): Promise<string[]> =>
  page.getByRole('navigation', { name: 'Projects' }).locator('.project-name').allTextContents();

// Makes the project whose name starts with `name` current.
export async function switchProject(_app: ElectronApplication, page: Page, name: string) {
  await page.locator('.project-link').filter({ has: page.locator('.project-name', { hasText: startsWith(name) }) }).first().click();
}

// Opens another project (the caller stubs dialog.showOpenDialog first).
export async function openAnotherProject(_app: ElectronApplication, page: Page) {
  await page.locator('.open-project').click();
}

// The element whose right-click opens the current project's context menu.
export const projectContextMenu = (page: Page): Locator => page.locator('.project-link').first();

// Opens Manage project for the project named `name`.
export async function manageProject(_app: ElectronApplication, page: Page, name: string) {
  await page.getByRole('button', { name: `Manage ${name}`, exact: true }).click();
}

// Switches the appearance to `theme` (no-op if it is already set).
export async function setTheme(page: Page, theme: 'dark' | 'light') {
  const toggle = page.getByRole('button', { name: `Switch to ${theme} mode`, exact: true });
  if (await toggle.count()) await toggle.click();
}

// Opens the settings that hold data, backups and updates. `section` names the part a spec needs next.
export async function openSettings(page: Page, _section?: 'appearance' | 'notifications' | 'updates' | 'data') {
  await page.getByRole('button', { name: 'Data and backups' }).click();
}

// The Active group's count of used slots, showing `n` of the four.
export const slotsUsed = (page: Page, n: number): Locator => page.getByText(`${n}/4 active`);

// ----- Group B: session header, status bar and inspector -----

// Shows the New session view before a start. Today the launch bar is always
// visible, so starts need nothing; B makes this click New session.
export async function newSession(_page: Page) {}

// The selected session's state line (state word, branch, workspace and mode).
export const sessionStatus = (page: Page): Locator => page.locator('.terminal-label');

// The selected session's action buttons (Interrupt, Stop, Continue, Archive, More).
export const sessionActions = (page: Page): Locator => page.locator('.terminal-actions');

// Selects an inspector tab by today's name and returns it.
export async function inspectorTab(page: Page, name: 'Context' | 'Changes' | 'Activity' | 'Files' | 'Memory'): Promise<Locator> {
  const tab = page.getByRole('tab', { name: startsWith(name) });
  await tab.click();
  return tab;
}

// Chooses the Files tab's view. Today there is one view per tab.
export async function filesView(_page: Page, _view: 'changed' | 'all') {}

// The bar under the terminal.
export const statusBar = (page: Page): Locator => page.locator('.terminal-footer');

// ----- Group C: layout, rails and overlay -----

// The button that hides or shows the inspector.
export const inspectorToggle = (page: Page, action: 'hide' | 'show'): Locator =>
  page.getByRole('button', { name: action === 'hide' ? 'Hide side panel' : 'Show side panel', exact: true });

// Makes the window wide enough for the docked inspector and both separators. Today every size docks them.
export async function ensureWide(_app: ElectronApplication) {}
