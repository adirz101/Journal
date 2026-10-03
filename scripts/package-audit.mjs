// node scripts/package-audit.mjs <path to Journal.app, or the folder holding resources/>
// Lists every file in app.asar and app.asar.unpacked and fails on anything
// outside the allow-list, forbidden files, local absolute paths or key material.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { auditEntries, LEAKS } from './release-lib.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const target = process.argv[2]; if (!target) throw new Error('Usage: package-audit.mjs <app>');
const resources = [join(target, 'Contents', 'Resources'), join(target, 'resources'), target].find(dir => existsSync(join(dir, 'app.asar')));
if (!resources) throw new Error(`No app.asar under ${target}`);
const archive = join(resources, 'app.asar');
const packed = asar.listPackage(archive).map(entry => entry.replace(/^[\\/]/, '').split(sep).join('/'))
  .filter(entry => { try { return !asar.statFile(archive, entry).files; } catch { return true; } });
const walk = dir => existsSync(dir) ? readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; }) : [];
const unpackedDir = join(resources, 'app.asar.unpacked');
const unpacked = walk(unpackedDir).map(path => relative(unpackedDir, path).split(sep).join('/'));
const problems = auditEntries([...new Set([...packed, ...unpacked])]);
// Text files: no local absolute paths or private keys.
for (const entry of packed.filter(name => /\.(?:mjs|cjs|js|json|html|css|md)$/.test(name))) {
  const text = asar.extractFile(archive, entry).toString('utf8');
  for (const leak of LEAKS) if (leak.test(text)) problems.push(`leak (${leak}): ${entry}`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Package audit passed: ${packed.length} packed and ${unpacked.length} unpacked files, all on the allow-list.`);
