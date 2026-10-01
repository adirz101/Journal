// Journal runtime: a separate local process that owns native terminals. The
// desktop app connects to it; closing or crashing the app (or reloading the
// renderer) does not end running sessions. Started with the Electron binary in
// Node mode so node-pty uses the Electron-built native module.
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from '../core/terminal.mjs';
import { redact } from '../core/validation.mjs';
import { Observers } from './observers.mjs';
import { buildId, frame, lineReader, PROTOCOL, socketPath } from './protocol.mjs';

const METHODS = new Set(['list', 'start', 'attach', 'detach', 'acknowledge', 'write', 'resize', 'interrupt', 'stop', 'terminateSurvivors', 'terminateOrphan', 'confirmNativeId', 'release', 'shutdown', 'ping']);

export function canConnect(path, timeoutMs = 500) {
  return new Promise(resolvePromise => {
    const socket = net.connect(path); const done = value => { socket.destroy(); resolvePromise(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs).unref();
  });
}

export function logger(dataDir) {
  const file = join(dataDir, 'runtime.log');
  return message => {
    try {
      try { if (statSync(file).size > 512 * 1024) renameSync(file, `${file}.1`); } catch { /* new log */ }
      appendFileSync(file, `${new Date().toISOString()} ${redact(String(message), 1000)}\n`, { mode: 0o600 });
    } catch { /* logging never affects sessions */ }
  };
}

export async function startRuntime({ dataDir, store, spawn, platform = process.platform, identify, table, hookScript, execPath = process.execPath,
  idleMs = 60_000, log = () => {}, exit = () => {}, observerMs = 300, stopGraceMs }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = socketPath(dataDir, platform);
  if (await canConnect(path)) throw Object.assign(new Error('A Journal runtime is already running for this data directory'), { code: 'RUNTIME_EXISTS' });
  if (platform !== 'win32') rmSync(path, { force: true });
  const token = randomBytes(32).toString('hex'); const runtimeId = randomUUID(); const build = buildId();
  let manager = null;
  const observers = new Observers({ dataDir, hookScript, execPath, platform, ingest: (id, event) => manager.ingest(id, event) });
  manager = new TerminalManager({ store, spawn, runtimeId, platform, makeSettings: (session, project) => observers.settings(session, project),
    ...(identify ? { identify } : {}), ...(table ? { table } : {}), ...(stopGraceMs ? { stopGraceMs } : {}) });
  const recovered = await manager.recover();
  if (recovered.length) log(`recovered ${recovered.length} session(s) from a previous runtime`);
  let client = null; let lastClientAt = Date.now(); let closing = null;
  manager.on('event', event => {
    if (event.type === 'status' && !['starting', 'running', 'waiting', 'stopping'].includes(event.session.status)) setTimeout(() => observers.release(event.session.id), 500).unref();
    client?.send({ event });
  });
  const observerTimer = setInterval(() => observers.poll(), observerMs); observerTimer.unref();

  const handlers = {
    ping: () => ({ runtimeId, build }),
    list: () => manager.list(),
    start: params => manager.start(params),
    attach: ({ id }) => manager.attach(id),
    detach: ({ id } = {}) => manager.detach(id),
    acknowledge: ({ id, sequence }) => manager.acknowledge(id, sequence),
    write: ({ id, data }) => manager.write(id, data),
    resize: ({ id, cols, rows }) => manager.resize(id, cols, rows),
    interrupt: ({ id }) => manager.interrupt(id),
    stop: ({ id }) => manager.stop(id),
    terminateSurvivors: ({ id }) => manager.terminateSurvivors(id),
    terminateOrphan: ({ id }) => manager.terminateOrphan(id),
    confirmNativeId: ({ id, nativeId }) => manager.confirmNativeId(id, nativeId),
    release: ({ id }) => manager.release(id),
    shutdown: ({ stopSessions = true } = {}) => { setImmediate(() => void shutdown({ stopSessions })); return { stopping: manager.liveEntries().length }; },
  };

  const server = net.createServer(socket => {
    let authenticated = false;
    const connection = { send: message => { if (!socket.destroyed) socket.write(frame(message)); }, close: () => socket.destroy() };
    socket.setEncoding('utf8');
    socket.on('data', lineReader(async message => {
      const { id, method, params } = message ?? {};
      if (!authenticated) {
        if (method !== 'hello' || params?.token !== token || params?.protocol !== PROTOCOL) { connection.send({ id, error: 'Unauthorized runtime client' }); socket.destroy(); return; }
        authenticated = true;
        // One desktop client at a time; a restarted app replaces a stale one.
        if (client) { client.close(); manager.detach(); }
        client = connection; lastClientAt = Date.now();
        connection.send({ id, value: { runtimeId, build, protocol: PROTOCOL, pid: process.pid, live: manager.liveEntries().length } });
        return;
      }
      if (client !== connection) return;
      try {
        if (!METHODS.has(method)) throw new Error('Unknown runtime operation');
        connection.send({ id, value: await handlers[method](params ?? {}) ?? null });
      } catch (error) { connection.send({ id, error: error instanceof Error ? error.message : 'Runtime operation failed' }); }
    }, () => socket.destroy()));
    socket.on('error', () => {});
    socket.on('close', () => { if (client === connection) { client = null; lastClientAt = Date.now(); manager.detach(); log('client disconnected'); } });
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(path, resolvePromise); });
  const infoFile = join(dataDir, 'runtime.json');
  writeFileSync(`${infoFile}.tmp`, JSON.stringify({ pid: process.pid, socket: path, token, runtimeId, build, protocol: PROTOCOL, startedAt: new Date().toISOString() }), { mode: 0o600 });
  renameSync(`${infoFile}.tmp`, infoFile);
  log(`runtime ${runtimeId} listening (build ${build})`);

  // Exit when nothing is running and no app has been connected for a while.
  const idleTimer = setInterval(() => {
    if (!client && !manager.liveEntries().length && Date.now() - lastClientAt > idleMs) void shutdown({ stopSessions: false });
  }, Math.min(idleMs, 15_000)); idleTimer.unref();

  async function shutdown({ stopSessions = true } = {}) {
    if (closing) return closing;
    closing = (async () => {
      log(`shutdown (stop sessions: ${stopSessions})`);
      clearInterval(idleTimer); clearInterval(observerTimer);
      await manager.dispose({ stopSessions });
      client?.close(); server.close();
      try { if (JSON.parse(readFileSync(infoFile, 'utf8')).runtimeId === runtimeId) rmSync(infoFile, { force: true }); } catch { /* already gone */ }
      if (platform !== 'win32') rmSync(path, { force: true });
      await store.close?.();
      exit();
    })();
    return closing;
  }
  return { server, manager, token, runtimeId, build, path, infoFile, shutdown };
}

// Entry point when launched as a process.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = resolve(process.argv[process.argv.indexOf('--data') + 1]);
  const log = logger(dataDir);
  const here = fileURLToPath(new URL('.', import.meta.url));
  const unpacked = path => path.replace(`app.asar${process.platform === 'win32' ? '\\' : '/'}`, `app.asar.unpacked${process.platform === 'win32' ? '\\' : '/'}`);
  process.on('uncaughtException', error => { log(`uncaught: ${error.stack ?? error.message}`); process.exit(1); });
  process.on('unhandledRejection', error => { log(`unhandled: ${error?.stack ?? error}`); });
  try {
    const pty = await import('node-pty');
    const { launchTarget, resolveExecutable } = await import('../core/process.mjs');
    // Resolve on PATH (PATHEXT on Windows) and avoid cmd.exe for npm shims.
    const spawn = (executable, argv, options) => {
      const resolved = resolveExecutable(executable, options.env) ?? executable;
      const target = launchTarget(resolved, argv, { env: options.env });
      return pty.spawn(target.file, target.args, options);
    };
    const { StoreClient } = await import('../desktop/store-client.mjs');
    const store = new StoreClient(join(dataDir, 'journal.sqlite')); await store.ready;
    const runtime = await startRuntime({ dataDir, store, spawn, log, hookScript: unpacked(join(here, '../desktop/hook.mjs')),
      exit: () => setTimeout(() => process.exit(0), 50) });
    process.on('SIGTERM', () => void runtime.shutdown({ stopSessions: true }));
    process.on('SIGINT', () => void runtime.shutdown({ stopSessions: true }));
    process.on('SIGHUP', () => {}); // Detached from the app's terminal; keep sessions.
  } catch (error) {
    log(`startup failed: ${error.message}`);
    process.exit(error.code === 'RUNTIME_EXISTS' ? 0 : 1);
  }
}
