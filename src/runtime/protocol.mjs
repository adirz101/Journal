import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Local runtime protocol: newline-delimited JSON over a Unix socket or a
// Windows named pipe. Both sides prove knowledge of the random token in
// runtime.json (mode 0600) with HMAC challenges; the token itself is never
// sent, so a process squatting on the socket path learns nothing.
export const PROTOCOL = 5; // 5: durable orchestration, role-scoped tools and result-bound integration
export const nonce = () => randomBytes(24).toString('hex');
export const proof = (token, role, a, b) => createHmac('sha256', token).update(`${role}:${a}:${b}`).digest('hex');
export function proofMatches(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
export const MAX_LINE = 1024 * 1024;

export function socketPath(dataDir, platform = process.platform) {
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\journal-runtime-${hash}`;
  const preferred = join(dataDir, 'runtime.sock');
  // Unix socket paths are limited to about 104 bytes on macOS. The fallback
  // lives in a private per-user directory, never directly in the shared temp.
  if (Buffer.byteLength(preferred) < 100) return preferred;
  const dir = join(tmpdir(), `journal-${process.getuid?.() ?? 'user'}-${hash}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = statSync(dir);
  if ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error(`Refusing runtime socket directory ${dir}: not private to this user`);
  return join(dir, 'runtime.sock');
}

// Code identity of the process owner. A runtime from another build keeps its
// sessions; the app reports the mismatch instead of silently mixing versions.
const owned = ['runtime/runtime.mjs', 'runtime/protocol.mjs', 'runtime/observers.mjs', 'core/terminal.mjs', 'core/agents.mjs', 'core/process.mjs',
  'runtime/environment-sync.mjs', 'core/environments.mjs', 'core/store.mjs', 'core/store-methods.mjs', 'core/store-worker.mjs', 'desktop/store-client.mjs',
  'runtime/resources.mjs', 'runtime/verification.mjs', 'runtime/macos-verification.mjs', 'runtime/continuation.mjs', 'desktop/hook.mjs', 'runtime/continuation-response.mjs', 'runtime/workers.mjs', 'runtime/capacity.mjs', 'runtime/delivery.mjs', 'runtime/tool-router.mjs', 'runtime/tool-launch.mjs',
  'core/orchestration/model.mjs', 'core/orchestration/schema.mjs', 'core/orchestration/runs.mjs', 'core/orchestration/messages.mjs', 'core/orchestration/prompts.mjs',
  'core/orchestration/results.mjs', 'core/orchestration/gates.mjs', 'core/orchestration/workflows.mjs',
  'agent-tools/server.mjs', 'agent-tools/client.mjs', 'agent-tools/definitions.mjs',
  'runtime/adapters/index.mjs', 'runtime/adapters/common.mjs', 'runtime/adapters/claude.mjs', 'runtime/adapters/codex.mjs', 'runtime/adapters/cursor.mjs'];
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
