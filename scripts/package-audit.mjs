// node scripts/package-audit.mjs <path to Journal.app, or the folder holding resources/>
// Lists every file in app.asar and app.asar.unpacked and fails on anything
// outside the allow-list, forbidden files, local absolute paths or key material.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { auditEntries, isProfilingBundle, LEAKS, productionPackages } from './release-lib.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const target = process.argv[2]; if (!target) throw new Error('Usage: package-audit.mjs <app>');
const resources = [join(target, 'Contents', 'Resources'), join(target, 'resources'), target].find(dir => existsSync(join(dir, 'app.asar')));
if (!resources) throw new Error(`No app.asar under ${target}`);
const archive = join(resources, 'app.asar');
// The audit compares "/" paths; @electron/asar looks entries up with the
// platform separator (\ on Windows). A failed lookup fails the audit.
const native = entry => entry.split('/').join(sep);
const packed = asar.listPackage(archive).map(entry => entry.replace(/^[\\/]/, '').split(sep).join('/'))
  .filter(entry => { const stat = asar.statFile(archive, native(entry)); if (!stat) throw new Error(`Cannot read ${entry} in app.asar`); return !stat.files; });
const walk = dir => existsSync(dir) ? readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; }) : [];
const unpackedDir = join(resources, 'app.asar.unpacked');
const unpacked = walk(unpackedDir).map(path => relative(unpackedDir, path).split(sep).join('/'));
const packages = productionPackages(JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')));
const problems = auditEntries([...new Set([...packed, ...unpacked])], packages);
// Text files: no local absolute paths or private keys.
for (const entry of packed.filter(name => /\.(?:mjs|cjs|js|json|html|css|md)$/.test(name))) {
  const text = asar.extractFile(archive, native(entry)).toString('utf8');
  for (const leak of LEAKS) if (leak.test(text)) problems.push(`leak (${leak}): ${entry}`);
  if (entry.startsWith('dist/') && entry.endsWith('.js') && isProfilingBundle(text)) problems.push(`React profiling build (react-dom/profiling): ${entry}`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Package audit passed: ${packed.length} packed and ${unpacked.length} unpacked files, all on the allow-list.`);
