import { defineConfig } from '@playwright/test';
// Desktop tests run headless by default: Journal creates hidden windows and no
// Dock icon. Set JOURNAL_HEADLESS=0 (any value other than 1) to watch them.
process.env.JOURNAL_HEADLESS ??= '1';
export default defineConfig({ testDir: './tests', testMatch: 'desktop*.spec.ts', workers: 1, timeout: 60000, reporter: 'list', use: { trace: 'retain-on-failure' } });
