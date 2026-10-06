import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { descendants, processTable, sameIdentity } from '../core/process.mjs';

const run = (file, args) => new Promise(resolve => execFile(file, args, { encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, output) => resolve(error ? null : output)));
export function parseVmStat(output) {
  const page = Number(output?.match(/page size of (\d+) bytes/)?.[1]);
  const values = ['free', 'inactive', 'speculative'].map(name => Number(output?.match(new RegExp(`Pages ${name}:\\s+(\\d+)\\.`))?.[1]));
  return page > 0 && values.every(Number.isFinite) ? page * values.reduce((a, b) => a + b, 0) : null;
}
export function estimateFootprint(samples, provider, mode) {
  const values = samples.filter(item => item.provider === provider && item.mode === mode && Number.isFinite(item.rssBytes) && item.rssBytes > 0).slice(-30).map(item => item.rssBytes).sort((a, b) => a - b);
  const median = values.length ? values[Math.floor(values.length / 2)] : null;
  return { bytes: Math.max(256e6, median ?? (provider === 'codex' ? 800e6 : 1.2e9)) + 128e6, source: median == null ? 'estimate' : 'measured', samples: values.length, overheadBytes: 128e6 };
}
export const reclaimEligible = conditions => ['enabled', 'capacityOnly', 'settled', 'captured', 'inboxEmpty', 'noApproval', 'descendantsEnded', 'idleLongEnough', 'exactResume', 'safePressure'].every(key => conditions[key] === true);

export class ResourceProbe {
  constructor({ dataDir, platform = process.platform, clock = Date.now }) { Object.assign(this, { dataDir, platform, clock }); this.last = null; this.pending = null; }
  sample(force = false) {
    if (this.pending) return this.pending;
    if (!force && this.last && this.clock() - this.last.at < 5000) return Promise.resolve(this.last);
    this.pending = this.read().then(value => this.last = value).finally(() => this.pending = null); return this.pending;
  }
  async read() {
    const [vm, pressure, disk] = await Promise.all([
      this.platform === 'darwin' ? run('vm_stat', []) : null,
      this.platform === 'darwin' ? run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']) : null,
      statfs(this.dataDir).catch(() => null),
    ]);
    const measured = parseVmStat(vm); const totalBytes = os.totalmem(); const availableBytes = measured ?? os.freemem();
    return { at: this.clock(), platform: this.platform, totalBytes, availableBytes, memorySource: measured == null ? 'os-fallback' : 'vm_stat',
      pressure: ({ 1: 'normal', 2: 'warning', 4: 'critical' })[pressure?.trim()] ?? null,
      load: this.platform === 'win32' ? null : os.loadavg()[0], cores: os.availableParallelism(), freeDiskBytes: disk ? disk.bavail * disk.bsize : null,
      limitations: this.platform === 'win32' ? ['Memory uses OS free bytes; pressure and CPU load are unavailable', 'Process-tree RSS is unavailable'] : measured == null ? ['Detailed memory probe unavailable; using OS free bytes'] : [] };
  }
  async footprints(entries) {
    if (this.platform === 'win32' || !entries.length) return [];
    const [table, output] = await Promise.all([processTable(this.platform), run('ps', ['-A', '-o', 'pid=', '-o', 'rss='])]);
    if (!table || !output) return [];
    const rss = new Map(output.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)));
    return entries.flatMap(entry => {
      const session = entry.session; const root = table.find(row => row.pid === session.pid);
      if (!sameIdentity(root, session.processIdentity ?? session.identity)) return [];
      const pids = [root, ...descendants(table, root.pid)];
      if (pids.some(row => !Number.isFinite(rss.get(row.pid)))) return [];
      return [{ provider: session.provider, mode: session.mode ?? 'build', sessionId: session.id, rssBytes: pids.reduce((sum, row) => sum + rss.get(row.pid) * 1024, 0), at: this.clock() }];
    });
  }
}
