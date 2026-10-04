import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { auditEntries, checkTag, checksumLines, configArtifacts, expectedArtifacts, LEAKS, loadConfig, productionPackages, readVersion, tagFor, UPDATE_FILES } from '../scripts/release-lib.mjs';
import { dataDirectory, guiPathEntries, unpackedPath, withGuiPath } from '../src/desktop/environment.mjs';
import { removeLater } from './support/cleanup.mjs';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const withEnv = (vars, action) => { const saved = {}; for (const key of Object.keys(vars)) { saved[key] = process.env[key]; if (vars[key] === undefined) delete process.env[key]; else process.env[key] = vars[key]; } try { return action(); } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; } };

test('one version source: tag, package.json and artifact names agree', () => {
  const version = readVersion(); assert.equal(version, pkg.version);
  assert.equal(tagFor(version), `v${version}`); assert.ok(checkTag(`v${version}`, version));
  assert.throws(() => checkTag('v9.9.9', version), /does not match/); assert.throws(() => checkTag('v1.0', '1.0'), /not a valid semantic version/);
  assert.deepEqual(expectedArtifacts('0.2.0-alpha'), { mac: ['Journal-0.2.0-alpha-arm64.dmg', 'Journal-0.2.0-alpha-arm64.zip'], win: ['Journal-Setup-0.2.0-alpha-x64.exe', 'Journal-Portable-0.2.0-alpha-x64.exe'] });
  assert.deepEqual(configArtifacts(loadConfig(), version), expectedArtifacts(version), 'The packaging config produces exactly the expected names');
  execFileSync(process.execPath, ['scripts/release-check.mjs', '--tag', `v${version}`], { stdio: 'pipe' });
  assert.throws(() => execFileSync(process.execPath, ['scripts/release-check.mjs', '--tag', 'v0.0.1'], { stdio: 'pipe' }));
});

test('packaging config: stable ID, platforms, per-user installer, data kept, update feed', () => {
  const config = withEnv({ CSC_LINK: undefined, APPLE_API_KEY: undefined }, () => loadConfig());
  assert.equal(config.appId, 'io.github.adirz101.journal'); assert.equal(config.productName, 'Journal');
  // The update feed: electron-updater reads it from app-update.yml. Builds never upload; the release workflow does.
  assert.deepEqual(config.publish, [{ provider: 'github', owner: 'adirz101', repo: 'Journal' }]); assert.equal(config.detectUpdateChannel, false);
  assert.deepEqual(UPDATE_FILES, { mac: ['latest-mac.yml'], win: ['latest.yml'] });
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }]);
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }]);
  assert.equal(config.nsis.perMachine, false); assert.equal(config.nsis.oneClick, true, 'Per user without an all-users choice');
  assert.equal(config.nsis.createStartMenuShortcut, true); assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.ok(config.dmg.contents.some(item => item.type === 'link' && item.path === '/Applications'), 'Drag to Applications');
  assert.ok(config.asarUnpack.includes('node_modules/node-pty/**') && config.asarUnpack.includes('src/**'));
  assert.equal(config.afterPack, './scripts/after-pack.cjs');
  for (const pattern of ['!src/ui/**', '!**/*.map', '!node_modules/node-pty/prebuilds/**', '!node_modules/node-pty/third_party/**', '!node_modules/node-pty/build/{deps,node_modules,node-addon-api}/**']) assert.ok(config.files.includes(pattern), pattern);
  assert.equal(config.mac.files, undefined, 'No platform-level file lists (an exclusion-only list would include everything)');
  assert.equal(config.win.files, undefined);
  // Unsigned: ad-hoc only, no hardened runtime, no notarization.
  assert.equal(config.mac.identity, '-'); assert.equal(config.mac.hardenedRuntime, false); assert.equal(config.mac.notarize, false);
  const signed = withEnv({ CSC_LINK: 'secret-path', CSC_IDENTITY_AUTO_DISCOVERY: undefined, APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' }, () => loadConfig());
  assert.equal(signed.mac.identity, undefined); assert.equal(signed.mac.hardenedRuntime, true); assert.equal(signed.mac.notarize, true);
  // A local build signs with a keychain identity and notarizes with a notarytool profile.
  const local = withEnv({ CSC_LINK: undefined, CSC_NAME: 'Adir Zak (N859VCGPS7)', CSC_IDENTITY_AUTO_DISCOVERY: undefined, APPLE_API_KEY: undefined, APPLE_KEYCHAIN_PROFILE: 'journal-notary' }, () => loadConfig());
  assert.equal(local.mac.hardenedRuntime, true); assert.equal(local.mac.notarize, true);
  // macOS gets full-bleed artwork (macOS 26+ masks it); other platforms keep the original.
  assert.equal(config.mac.icon, 'assets/branding/Journal.icon'); assert.equal(config.icon, 'assets/branding/journal-app-icon.png');
  // One layer, the full-bleed artwork as is: no glass, shadow, highlight or translucency.
  const icon = JSON.parse(readFileSync(join(config.mac.icon, 'icon.json'), 'utf8'));
  assert.equal(icon.groups.length, 1); const [group] = icon.groups;
  assert.deepEqual(group.layers, [{ glass: false, 'image-name': 'journal.png', name: 'journal' }]);
  assert.equal(group.specular, false); assert.equal(group.shadow.kind, 'none'); assert.equal(group.translucency.enabled, false);
  assert.deepEqual(icon['supported-platforms'], { squares: ['macOS'] });
  const png = readFileSync(join(config.mac.icon, 'Assets', 'journal.png')); assert.equal(png.readUInt32BE(16), 1024); assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[25], 2, 'Opaque RGB: no transparent margin for macOS to frame');
  const signedOnly = withEnv({ CSC_LINK: 'secret-path', CSC_IDENTITY_AUTO_DISCOVERY: undefined, APPLE_API_KEY: undefined }, () => loadConfig());
  assert.equal(signedOnly.mac.notarize, false, 'Notarization only with App Store Connect credentials');
  // node-pty and electron-updater ship as modules; the renderer libraries are bundled by Vite.
  assert.deepEqual(Object.keys(pkg.dependencies), ['electron-updater', 'node-pty']);
  for (const name of pkg.journal.rendererBundle) assert.ok(pkg.devDependencies[name], name);
});

test('notices cover everything that ships', () => {
  const notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
  const shipped = productionPackages(JSON.parse(readFileSync('package-lock.json', 'utf8'))).map(path => path.split('node_modules/').at(-1));
  assert.ok(shipped.includes('electron-updater') && shipped.includes('sax'), 'Updater dependencies, including deduplicated ones');
  for (const name of [...pkg.journal.rendererBundle, ...shipped, 'node-pty', 'electron']) assert.match(notices, new RegExp(`^## ${name.replace(/[/@.]/g, '\\$&')} `, 'm'), name);
  assert.match(notices, /^## @fontsource\/jetbrains-mono .*\n\nLicense: OFL-1\.1$/m, 'The bundled monospace font');
  assert.match(notices, /^## Provider marks \(Simple Icons\)\n\nLicense: CC0-1\.0$/m, 'Artwork copied into the source');
});

test('the node-pty spawn-helper path fix is applied once and fails closed on change', t => {
  const { patchUnixTerminal, ORIGINAL, FIXED } = require('../scripts/after-pack.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'afterpack-')); t.after(() => removeLater(dir));
  const file = join(dir, 'unixTerminal.js'); writeFileSync(file, `var a = 1;\n${ORIGINAL}\n`);
  assert.equal(patchUnixTerminal(file), true); assert.match(readFileSync(file, 'utf8'), /patched by Journal/);
  assert.equal(patchUnixTerminal(file), false, 'Idempotent');
  writeFileSync(file, 'something else'); assert.throws(() => patchUnixTerminal(file), /node-pty changed/);
  // The fixed replacement leaves an unpacked path alone and still fixes a packed one.
  const helper = path => path.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
  assert.ok(FIXED.includes('(?!\\.unpacked)'));
  assert.equal(helper('/A/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper'), '/A/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper');
  assert.equal(helper('/A/Resources/app.asar/node_modules/node-pty/build/Release/spawn-helper'), '/A/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper');
});

test('package audit: allow-list, forbidden files and leaks', () => {
  assert.deepEqual(auditEntries(['dist/index.html', 'dist/assets/index-abc.js', 'src/core/store.mjs', 'src/desktop/main.mjs', 'src/runtime/runtime.mjs', 'package.json', 'THIRD_PARTY_NOTICES.md',
    'node_modules/node-pty/lib/index.js', 'node_modules/node-pty/build/Release/pty.node', 'node_modules/node-pty/build/Release/spawn-helper', 'assets/branding/journal-app-icon.png',
    'dist/assets/jetbrains-mono-latin-400-normal-V6pRDFza.woff2']), []);
  for (const bad of ['.env', 'src/core/.env.local', 'data/journal.sqlite', 'runtime-stderr.log', 'dist/assets/index.js.map', '.cache/tmp/x', 'tests/a.test.mjs', 'fixtures/x.json', 'docs/a.md', 'src/ui/App.tsx', 'certs/dev.p12'])
    assert.equal(auditEntries([bad]).length, 1, bad);
  assert.match(auditEntries(['node_modules/react/index.js'])[0], /not on the allow-list/);
  // Production dependencies from the lockfile are allowed, nested ones by their full path; secrets are still not.
  const lock = { packages: { '': {}, 'node_modules/electron-updater': {}, 'node_modules/electron-updater/node_modules/semver': {}, 'node_modules/vite': { dev: true }, 'node_modules/node-pty': {} } };
  const packages = productionPackages(lock); assert.deepEqual(packages, ['electron-updater', 'electron-updater/node_modules/semver']);
  assert.deepEqual(auditEntries(['node_modules/electron-updater/out/main.js', 'node_modules/electron-updater/node_modules/semver/index.js', 'node_modules/semver/index.js'], packages), [], 'Nested or hoisted');
  assert.equal(auditEntries(['node_modules/semverx/index.js', 'node_modules/xsemver/index.js'], packages).length, 2, 'Exact package names only');
  assert.equal(auditEntries(['node_modules/vite/index.js'], packages).length, 1); assert.equal(auditEntries(['node_modules/electron-updater/.env'], packages).length, 1);
  // Windows node-pty files are allowed; generated build projects are not.
  assert.deepEqual(auditEntries(['node_modules/node-pty/build/Release/conpty.node', 'node_modules/node-pty/build/Release/winpty-agent.exe', 'node_modules/node-pty/build/Release/conpty/OpenConsole.exe', 'node_modules/node-pty/lib/worker/conoutSocketWorker.js']), []);
  assert.equal(auditEntries(['node_modules/node-pty/build/deps/winpty/src/winpty.vcxproj']).length, 1);
  assert.ok(LEAKS.some(leak => leak.test('"/Users/someone/Documents/GitHub/Journal/src"')));
  assert.ok(!LEAKS.some(leak => leak.test('"/home/runner/work/x"')), 'CI paths are not personal');
});

test('checksums use the sha256sum format, sorted, and match the system tool', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sums-')); t.after(() => removeLater(dir));
  writeFileSync(join(dir, 'b.exe'), 'bbb'); writeFileSync(join(dir, 'a.dmg'), 'aaa');
  const text = await checksumLines([join(dir, 'b.exe'), join(dir, 'a.dmg')]);
  assert.match(text, /^[0-9a-f]{64} {2}a\.dmg\n[0-9a-f]{64} {2}b\.exe\n$/);
  execFileSync(process.execPath, ['scripts/checksums.mjs', dir, 'a.dmg', 'b.exe'], { stdio: 'pipe' });
  if (process.platform !== 'win32') execFileSync('shasum', ['-a', '256', '-c', 'SHA256SUMS.txt'], { cwd: dir, stdio: 'pipe' });
});

test('packaged environment: GUI PATH, data folder and unpacked paths', () => {
  const home = '/Users/me'; const present = new Set(['/Users/me/.local/bin', '/opt/homebrew/bin', '/Users/me/.nvm/versions/node/v22.3.0/bin']);
  const entries = guiPathEntries({ platform: 'darwin', home, exists: dir => present.has(dir), list: () => ['v20.11.1', 'v22.3.0', 'v9.0.0'] });
  assert.deepEqual(entries, ['/Users/me/.local/bin', '/opt/homebrew/bin', '/Users/me/.nvm/versions/node/v22.3.0/bin']);
  assert.deepEqual(guiPathEntries({ platform: 'win32', home }), [], 'Windows GUI apps already get the user PATH');
  const env = withGuiPath({ PATH: '/opt/homebrew/bin:/usr/bin' }, { platform: 'darwin', home, exists: dir => present.has(dir), list: () => [] });
  assert.deepEqual(withGuiPath({}, { platform: 'darwin', home, exists: () => false, list: () => [] }), {}, 'Nothing added: env unchanged (no "undefined" PATH)');
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin', 'Existing PATH first, no duplicates');
  assert.equal(dataDirectory({}, '/Users/me/Library/Application Support'), resolve('/Users/me/Library/Application Support', 'journal-desktop'));
  assert.equal(dataDirectory({ JOURNAL_DATA_DIR: '/tmp/j' }, '/x'), resolve('/tmp/j'));
  assert.equal(unpackedPath('/A/Journal.app/Contents/Resources/app.asar/src/runtime/runtime.mjs', '/'), '/A/Journal.app/Contents/Resources/app.asar.unpacked/src/runtime/runtime.mjs');
  assert.equal(unpackedPath('C:\\J\\resources\\app.asar\\src\\desktop\\hook.mjs', '\\'), 'C:\\J\\resources\\app.asar.unpacked\\src\\desktop\\hook.mjs');
  assert.equal(unpackedPath('/dev/src/runtime/runtime.mjs', '/'), '/dev/src/runtime/runtime.mjs', 'Development paths are unchanged');
});
