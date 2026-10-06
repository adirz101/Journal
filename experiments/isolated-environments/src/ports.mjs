import net from 'node:net';
import { execFileSync } from 'node:child_process';

// Port blocks for environments: a fixed-size block per environment from a reserved range, chosen
// deterministically (the lowest free block), skipping ports in Windows' excluded ranges and
// ports that something is already listening on. Advisory: development isolation, not enforcement.
export const DEFAULT_RANGE = { start: 42000, end: 46000, size: 10 };

// `netsh interface ipv4 show excludedportrange protocol=tcp` output → [[start, end], ...].
export function parseExcludedRanges(text) {
  const ranges = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d{1,5})\s+(\d{1,5})(?:\s+\*)?\s*$/.exec(line);
    if (match) ranges.push([Number(match[1]), Number(match[2])]);
  }
  return ranges;
}
export function windowsExcludedRanges(platform = process.platform) {
  if (platform !== 'win32') return [];
  try { return parseExcludedRanges(execFileSync('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { encoding: 'utf8', windowsHide: true })); } catch { return []; }
}

// Whether a TCP port can be bound on the loopback addresses right now.
export function portFree(port, hosts = ['127.0.0.1', '::1']) {
  return hosts.reduce((chain, host) => chain.then(ok => ok && new Promise(resolve => {
    const server = net.createServer(); server.unref();
    server.once('error', error => resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT'));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  })), Promise.resolve(true));
}

// The lowest block not held by another environment, whose every port is free and not excluded.
export async function allocateBlock(taken, { range = DEFAULT_RANGE, excluded = windowsExcludedRanges(), probe = portFree } = {}) {
  const held = new Set(taken);
  for (let start = range.start; start + range.size <= range.end; start += range.size) {
    if (held.has(start)) continue;
    const ports = Array.from({ length: range.size }, (_, i) => start + i);
    if (ports.some(port => excluded.some(([low, high]) => port >= low && port <= high))) continue;
    let free = true; for (const port of ports) if (!(await probe(port))) { free = false; break; }
    if (free) return { start, ports };
  }
  throw new Error('No free port block in the reserved range');
}
