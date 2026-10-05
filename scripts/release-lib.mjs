import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// One version source: package.json. Tags, artifact names and the app version
// derive from it; anything that disagrees fails the release.
const require = createRequire(import.meta.url);
export const readVersion = (path = 'package.json') => JSON.parse(readFileSync(path, 'utf8')).version;
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const isPrerelease = version => version.includes('-');
export const tagFor = version => `v${version}`;

export function checkTag(tag, version) {
  if (!SEMVER.test(version)) throw new Error(`package.json version "${version}" is not a valid semantic version`);
  if (tag !== tagFor(version)) throw new Error(`Tag "${tag}" does not match package.json version ${version} (expected ${tagFor(version)})`);
  return true;
}

// The installers each platform must produce, and nothing else that ships.
export function expectedArtifacts(version) {
  return {
    mac: [`Journal-${version}-arm64.dmg`, `Journal-${version}-arm64.zip`],
    win: [`Journal-Setup-${version}-x64.exe`, `Journal-Portable-${version}-x64.exe`],
  };
}
export const RELEASE_EXTRAS = ['SHA256SUMS.txt', 'THIRD-PARTY-NOTICES.txt'];
// Update metadata electron-updater reads from the release (sizes and SHA-512 of the installers).
export const UPDATE_FILES = { mac: ['latest-mac.yml'], win: ['latest.yml'] };

// Applies electron-builder's artifactName templates the way it does, so the
// configuration and expectedArtifacts cannot drift apart unnoticed.
export function configArtifacts(config, version) {
  const fill = (template, arch, ext) => template.replace('${productName}', config.productName).replace('${version}', version).replace('${arch}', arch).replace('${ext}', ext);
  return {
    mac: [fill(config.dmg.artifactName, 'arm64', 'dmg'), fill(config.mac.artifactName, 'arm64', 'zip')],
    win: [fill(config.nsis.artifactName, 'x64', 'exe'), fill(config.portable.artifactName, 'x64', 'exe')],
  };
}
export const loadConfig = (path = fileURLToPath(new URL('../electron-builder.config.cjs', import.meta.url))) => { delete require.cache[require.resolve(path)]; return require(path); };

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256'); const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolve(hash.digest('hex')));
  });
}
// The format `sha256sum -c` and `shasum -a 256 -c` read: "<hash>  <name>".
export async function checksumLines(paths) {
  const lines = [];
  for (const path of [...paths].sort((a, b) => basename(a).localeCompare(basename(b)))) lines.push(`${await sha256File(path)}  ${basename(path)}`);
  return `${lines.join('\n')}\n`;
}

// What may ship inside the app (paths inside app.asar or app.asar.unpacked).
// Everything else is a packaging mistake: tests, fixtures, caches, sources of
// the renderer, local data or credentials.
export const ALLOWED = [
  /^dist\/(?:index\.html|assets\/[^/]+)$/,
  /^src\/(?:core|desktop|runtime)\/[^/]+\.(?:mjs|cjs)$/,
  // Provider hook adapters (the runtime and the hook script import them).
  /^src\/runtime\/adapters\/[^/]+\.mjs$/,
  /^assets\/branding\/journal-app-icon\.png$/,
  /^(?:package\.json|LICENSE|NOTICE|THIRD_PARTY_NOTICES\.md)$/,
  /^node_modules\/node-pty\/(?:package\.json|LICENSE|lib\/.+\.js|build\/Release\/(?:pty\.node|spawn-helper|conpty\.node|conpty_console_list\.node|winpty-agent\.exe|winpty\.dll|[^/]+\.(?:node|dll|exe)|conpty\/(?:conpty\.dll|OpenConsole\.exe)))$/,
];
export const FORBIDDEN = [/(?:^|\/)\.env(?:\.|$)/i, /\.(?:sqlite|db|log|map|pem|key|p12|pfx|cer|keychain|provisionprofile)$/i, /(?:^|\/)\.(?:cache|git|journal-data)\//, /(?:^|\/)(?:tests?|fixtures|docs|scripts|benchmarks|test-results)\//, /^src\/ui\//];

// Production packages from package-lock.json (for example "electron-updater" or
// "electron-updater/node_modules/semver"); node-pty keeps its own stricter rule.
export function productionPackages(lock) {
  return Object.entries(lock.packages ?? {}).filter(([path, info]) => path.startsWith('node_modules/') && !info.dev && !info.devOptional)
    .map(([path]) => path.slice('node_modules/'.length)).filter(name => name !== 'node-pty' && !name.startsWith('node-pty/') && name !== 'node-addon-api');
}
// electron-builder may hoist a nested copy (electron-updater/node_modules/semver
// ships as node_modules/semver), so a production package is allowed at any level.
const inPackage = (entry, packages) => packages.some(path => { const name = path.split('node_modules/').at(-1); return entry.startsWith(`node_modules/${path}/`) || new RegExp(`^node_modules/(?:[^/]+/node_modules/)*${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`).test(entry); });
export function auditEntries(entries, packages = []) {
  const problems = [];
  for (const entry of entries) {
    if (FORBIDDEN.some(pattern => pattern.test(entry))) problems.push(`forbidden: ${entry}`);
    else if (!ALLOWED.some(pattern => pattern.test(entry)) && !inPackage(entry, packages)) problems.push(`not on the allow-list: ${entry}`);
  }
  return problems;
}
// Text that must never ship: local absolute paths and key material.
// A React profiling build (npm run build:profile, for tests/desktop-performance.spec.ts) must never
// ship: its renderer keeps per-fiber timing fields that the production build compiles out.
export const isProfilingBundle = text => /\btreeBaseDuration\b/.test(text);
export const LEAKS = [/\/Users\/[A-Za-z0-9._-]+\//, /\/home\/(?!runner\b)[A-Za-z0-9._-]+\//, /[A-Z]:\\\\Users\\\\[A-Za-z0-9._-]+\\\\/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
