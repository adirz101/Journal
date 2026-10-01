import electron from 'electron';
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function installEntryPoint(bundle) {
  // The local bundle must also open Journal when launched without CLI arguments.
  // Point to this checkout; keep application code and dependencies in the repo.
  const directory = resolve(bundle, 'Contents/Resources/app');
  const manifest = resolve(directory, 'package.json');
  const entry = resolve(directory, 'entry.mjs');
  const entryContent = `import ${JSON.stringify(pathToFileURL(resolve(root, 'src/desktop/main.mjs')).href)};\n`;
  const content = JSON.stringify({ name: 'journal-desktop', productName: 'Journal', version: '0.1.0', license: 'Apache-2.0', type: 'module', main: 'entry.mjs' }, null, 2) + '\n';
  if (existsSync(manifest) && readFileSync(manifest, 'utf8') === content && existsSync(entry) && readFileSync(entry, 'utf8') === entryContent) return;
  mkdirSync(directory, { recursive: true }); writeFileSync(entry, entryContent); writeFileSync(manifest, content);
}

// macOS reads the Dock label from the running bundle, not app.setName().
// Keep the installed Electron dependency intact and use a project-local copy.
export function journalElectron() {
  if (process.platform !== 'darwin') return electron;
  const version = require('electron/package.json').version;
  const cache = resolve(root, '.cache/electron-runtime', `${version}-${process.arch}-v2`);
  const bundle = resolve(cache, 'Journal.app');
  const executable = resolve(bundle, 'Contents/MacOS/Electron');
  const marker = resolve(cache, 'ready.json');
  if (existsSync(executable) && existsSync(marker)) { installEntryPoint(bundle); return executable; }

  mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(resolve(cache, 'prepare-'));
  try {
    const prepared = resolve(staging, 'Journal.app');
    cpSync(resolve(electron, '../../..'), prepared, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const plist = resolve(prepared, 'Contents/Info.plist');
    for (const [key, value] of Object.entries({ CFBundleDisplayName: 'Journal', CFBundleName: 'Journal', CFBundleIdentifier: 'com.adirzak.journal.local' })) {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    }
    installEntryPoint(prepared);
    // The stock development binary is ad-hoc signed and does not seal Info.plist.
    // Preserve its binary, helpers, entitlements and Chromium sandbox unchanged.
    try { renameSync(prepared, bundle); }
    catch (error) { if (!existsSync(marker)) throw error; }
    writeFileSync(marker, JSON.stringify({ version, name: 'Journal' }));
    return executable;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
