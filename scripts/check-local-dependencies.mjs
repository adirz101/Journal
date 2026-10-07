import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Branch switches change package-lock.json without updating node_modules.
// Refuse before Vite/Electron start, rather than opening an unusable desktop.
const root = process.cwd();
try {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const outdated = [];
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const expected = lock.packages?.[`node_modules/${name}`]?.version;
    let installed;
    try { installed = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch {}
    if (!installed || !expected || installed !== expected) outdated.push(name);
  }
  if (outdated.length) throw new Error(`Missing or outdated local dependencies: ${outdated.join(', ')}.`);
} catch (error) {
  console.error(`Cannot start Journal. ${error.message}\nRun npm ci in this checkout, then retry your start command.`);
  process.exitCode = 1;
}
