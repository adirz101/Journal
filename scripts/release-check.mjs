// Fails closed before anything is published:
//   node scripts/release-check.mjs [--tag vX.Y.Z] [--artifacts <dir> --platform mac|win]
// Checks that the tag, package.json and the packaging configuration agree and,
// with --artifacts, that exactly the expected installers were produced.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkTag, configArtifacts, expectedArtifacts, loadConfig, readVersion, SEMVER, UPDATE_FILES } from './release-lib.mjs';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const version = readVersion();
if (!SEMVER.test(version)) throw new Error(`Invalid version ${version}`);
const tag = arg('tag'); if (tag) checkTag(tag, version);
const expected = expectedArtifacts(version); const configured = configArtifacts(loadConfig(), version);
for (const platform of ['mac', 'win']) if (JSON.stringify(expected[platform]) !== JSON.stringify(configured[platform])) throw new Error(`Packaging config names ${configured[platform].join(', ')} but releases expect ${expected[platform].join(', ')}`);
const dir = arg('artifacts');
if (dir) {
  const platform = arg('platform'); if (!expected[platform]) throw new Error('--platform must be mac or win');
  const missing = [...expected[platform], ...UPDATE_FILES[platform]].filter(name => !existsSync(join(dir, name)));
  if (missing.length) throw new Error(`Missing release artifacts: ${missing.join(', ')}`);
  const installers = readdirSync(dir).filter(name => /\.(?:dmg|zip|exe|msi|pkg|AppImage|deb)$/.test(name));
  const extra = installers.filter(name => !expected[platform].includes(name));
  if (extra.length) throw new Error(`Unexpected artifacts: ${extra.join(', ')}`);
}
console.log(`Release check passed for ${version}${tag ? ` (${tag})` : ''}${dir ? ` with ${arg('platform')} artifacts` : ''}.`);
