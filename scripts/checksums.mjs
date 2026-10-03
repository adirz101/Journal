// node scripts/checksums.mjs <dir> <file>... → writes <dir>/SHA256SUMS.txt
// (verify with `shasum -a 256 -c SHA256SUMS.txt` or `sha256sum -c SHA256SUMS.txt`).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checksumLines } from './release-lib.mjs';

const [dir, ...files] = process.argv.slice(2);
if (!dir || !files.length) throw new Error('Usage: checksums.mjs <dir> <file>...');
const text = await checksumLines(files.map(file => join(dir, file)));
writeFileSync(join(dir, 'SHA256SUMS.txt'), text);
process.stdout.write(text);
