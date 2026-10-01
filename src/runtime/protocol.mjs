import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Local runtime protocol: newline-delimited JSON over a Unix socket or a
// Windows named pipe. The first message must carry the random token from
// runtime.json (mode 0600 in the user's data directory).
export const PROTOCOL = 1;
export const MAX_LINE = 1024 * 1024;

export function socketPath(dataDir, platform = process.platform) {
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\journal-runtime-${hash}`;
  const preferred = join(dataDir, 'runtime.sock');
  // Unix socket paths are limited to about 104 bytes on macOS.
  return Buffer.byteLength(preferred) < 100 ? preferred : join(tmpdir(), `journal-${hash}.sock`);
}

// Code identity of the process owner. A runtime from another build keeps its
// sessions; the app reports the mismatch instead of silently mixing versions.
const owned = ['runtime/runtime.mjs', 'runtime/protocol.mjs', 'runtime/observers.mjs', 'core/terminal.mjs', 'core/agents.mjs', 'core/process.mjs'];
export function buildId() {
  const hash = createHash('sha256');
  for (const file of owned) { try { hash.update(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)))); } catch { hash.update(file); } }
  return hash.digest('hex').slice(0, 16);
}

export function lineReader(onMessage, onError) {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    if (buffer.length > MAX_LINE && !buffer.includes('\n')) { buffer = ''; onError(new Error('Message too large')); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { onError(new Error('Malformed message')); continue; }
      onMessage(message);
    }
  };
}

export const frame = message => `${JSON.stringify(message)}\n`;
