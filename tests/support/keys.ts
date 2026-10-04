import type { ElectronApplication } from '@playwright/test';

// Presses a key the way the operating system delivers it, so it passes through
// Electron's before-input-event and the shortcut router (src/desktop/shortcuts.mjs).
// Playwright's page.keyboard bypasses that hook and reaches the page directly.
export function pressKey(app: ElectronApplication, keyCode: string, modifiers: ('meta' | 'control' | 'alt' | 'shift')[] = []) {
  return app.evaluate(({ BrowserWindow }, key) => {
    BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: key.keyCode, modifiers: key.modifiers });
  }, { keyCode, modifiers });
}
