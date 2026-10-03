import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import electron from 'electron';
import { realpathSync } from 'node:fs';

const launcher = await import('../scripts/electron-runtime.mjs').catch(() => ({}));

test('the macOS local launcher presents Journal to the operating system', { skip: process.platform !== 'darwin' }, async () => {
  const executable = launcher.journalElectron ? await launcher.journalElectron() : electron;
  const bundle = resolve(executable, '../../..');
  const plist = resolve(bundle, 'Contents/Info.plist');
  const read = key => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim();
  assert.equal(read('CFBundleDisplayName'), 'Journal');
  assert.equal(read('CFBundleName'), 'Journal');
  assert.equal(read('CFBundleIdentifier'), 'com.adirzak.journal.local');
  assert.ok(bundle.endsWith('/Journal.app'));
  const framework = resolve(bundle, 'Contents/Frameworks/Electron Framework.framework/Electron Framework');
  assert.ok(realpathSync.native(framework).startsWith(`${bundle}/`), 'Framework links must remain inside the Journal runtime');
  // The shared dependency must retain its original identity.
  const original = resolve(electron, '../../Info.plist');
  assert.equal(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleDisplayName', 'raw', original], { encoding: 'utf8' }).trim(), 'Electron');
});
