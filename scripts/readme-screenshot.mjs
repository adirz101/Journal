// Takes the README screenshot (docs/assets/journal-preview.png) from fixture data, headless:
// a throwaway repository under /tmp, fixture agent CLIs (the shared fixtureEnv: fixture CLIs and
// a few linked system tools on PATH, an empty HOME), notes seeded through the store. No personal data, no
// provider login. Usage: npm run build, then node scripts/readme-screenshot.mjs . docs/assets/journal-preview.png [dark|light]
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
// Fixture-only environment (no real PATH, HOME or provider variables): see tests/support/env.ts.
import { fixtureEnv } from '../tests/support/env.ts';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const repo = process.argv[2]; const out = process.argv[3]; const theme = process.argv[4] ?? 'dark';
const root = mkdtempSync('/tmp/journal-demo-'); const project = resolve(root, 'ledger-service'); const bin = resolve(root, 'bin'); for (const d of [project, bin, resolve(project, 'src/refunds'), resolve(project, 'src/invoices')]) mkdirSync(d, { recursive: true });
const git = (...a) => execFileSync('git', ['-C', project, '-c', 'user.name=Demo', '-c', 'user.email=demo@example.test', ...a], { stdio: 'pipe' });
git('init', '-q', '-b', 'main');
writeFileSync(resolve(project, 'README.md'), '# Ledger service\n\nLedger records invoices and refunds for small shops.\n');
writeFileSync(resolve(project, 'src/invoices/create.ts'), 'export function createInvoice() {}\n');
writeFileSync(resolve(project, 'src/refunds/policy.ts'), 'export const REFUND_WINDOW_DAYS = 30;\n');
git('add', '.'); git('commit', '-qm', 'Initial ledger');
git('switch', '-qc', 'feat/partial-refunds');
writeFileSync(resolve(project, 'src/refunds/partial.ts'), 'export function partialRefund() {}\n'); git('add', '.'); git('commit', '-qm', 'Add partial refund model');
const fixture = `#!${process.execPath}
if(process.argv.includes('--version')){console.log('2.1.0');process.exit(0)}
const task=(process.argv.at(-1)||'').split('\\n').at(-1);
const lines=['','  Task: '+task,'','  Reading src/refunds/policy.ts','  Reading src/refunds/partial.ts','  The refund window is 30 days (src/refunds/policy.ts:1).','','  Plan:','   1. Split the refund amount across invoice lines','   2. Keep the 30-day window check before any split','   3. Add tests for a refund that spans two lines','','  Editing src/refunds/partial.ts',''];
for(const l of lines)console.log(l);process.stdout.write('> ');process.stdin.resume();`;
for (const p of ['claude', 'codex']) { writeFileSync(resolve(bin, p), fixture); chmodSync(resolve(bin, p), 0o755); }
const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: resolve(root, 'data'), JOURNAL_QUIT_POLICY: 'stop', JOURNAL_HEADLESS: '1' } });
const app = await electron.launch({ args: [repo], cwd: repo, env });
try {
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); globalThis.__journalFocused = () => true; }, project);
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.getByRole('button', { name: 'Open a project…', exact: true }).click();
  await page.getByLabel('Task', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const j = window.journal; const projectId = (await j.request('projects'))[0].id;
    const add = async (statement, category, scope = 'checkout') => { const m = await j.request('proposeMemory', { projectId, input: { statement, category, scope, area: '', source: { kind: 'user', note: 'Team convention' } } }); await j.request('setMemoryStatus', { id: m.id, status: 'active' }); };
    await add('Ledger records invoices and refunds for small shops. TypeScript, tests with npm test.', 'brief');
    await add('Refunds older than 30 days need a manager approval; never bypass the window check', 'constraint');
    await add('Money is stored in integer cents; never use floats for amounts', 'convention');
    await add('Partial refunds split by invoice line, not by percentage', 'decision', 'branch');
  });
  if (theme === 'light') await page.evaluate(() => { localStorage.setItem('journal-theme', 'light'); });
  await page.reload(); await page.getByLabel('Task', { exact: true }).waitFor();
  await page.getByLabel('Task', { exact: true }).fill('Add partial refunds across invoice lines');
  await page.getByRole('form', { name: 'Start a session' }).getByRole('button', { name: /^Start / }).click();
  await page.locator('.terminal-surface').getByText('Editing src/refunds/partial.ts').waitFor();
  await page.getByRole('tab', { name: /^Memory/ }).click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.mouse.move(1, 1);
  await page.screenshot({ path: out });
} finally { await app.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
