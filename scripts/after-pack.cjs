// electron-builder afterPack hook (runs before signing).
//
// node-pty finds its spawn helper with path.replace('app.asar', 'app.asar.unpacked').
// Journal's runtime loads node-pty from app.asar.unpacked (a separate Node-mode
// process executes it), so that replace produced "app.asar.unpacked.unpacked"
// and every terminal failed with "posix_spawnp failed". Make the replace apply
// only to a path that is not already unpacked. Fails the build if node-pty's code
// changes, so an update cannot silently reintroduce the problem.
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ORIGINAL = "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');";
const FIXED = "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked'); // patched by Journal (scripts/after-pack.cjs)";

function patchUnixTerminal(file) {
  const source = readFileSync(file, 'utf8');
  if (source.includes(FIXED)) return false;
  if (!source.includes(ORIGINAL)) throw new Error(`node-pty changed: ${file} no longer contains the expected spawn-helper path code; review scripts/after-pack.cjs`);
  writeFileSync(file, source.replace(ORIGINAL, FIXED));
  return true;
}

function resourcesDir(context) {
  const app = `${context.packager.appInfo.productFilename}.app`;
  return context.electronPlatformName === 'darwin' ? join(context.appOutDir, app, 'Contents', 'Resources') : join(context.appOutDir, 'resources');
}

module.exports = async function afterPack(context) {
  const file = join(resourcesDir(context), 'app.asar.unpacked', 'node_modules', 'node-pty', 'lib', 'unixTerminal.js');
  if (!existsSync(file)) throw new Error(`node-pty is not unpacked at ${file}`);
  patchUnixTerminal(file);
};
module.exports.patchUnixTerminal = patchUnixTerminal;
module.exports.ORIGINAL = ORIGINAL;
module.exports.FIXED = FIXED;
