// Journal runtime: a separate local process that owns native terminals. The
// desktop app connects to it; closing or crashing the app (or reloading the
// renderer) does not end running sessions. Started with the Electron binary in
// Node mode so node-pty uses the Electron-built native module.
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerResolver, TerminalManager } from '../core/terminal.mjs';
import { isAlive, processIdentity, sameIdentity } from '../core/process.mjs';
import { redact } from '../core/validation.mjs';
import { Observers } from './observers.mjs';
import { buildId, frame, lineReader, nonce, proof, proofMatches, PROTOCOL, socketPath } from './protocol.mjs';

const METHODS = new Set(['list', 'start', 'attach', 'detach', 'acknowledge', 'write', 'resize', 'interrupt', 'stop', 'terminateSurvivors', 'terminateOrphan', 'confirmNativeId', 'paste', 'release', 'shutdown', 'ping', 'acknowledgeRecovery', 'setAppearance']);

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

// One runtime per data directory: an exclusive lock file names the owner by
// PID and process identity. A lock whose owner is gone (or is now another
// program) is stale and replaced; a live owner means this start must exit.
export async function acquireLock(dataDir, path, identify = processIdentity) {
  const file = join(dataDir, 'runtime.lock'); const mine = { pid: process.pid, identity: await identify(process.pid) };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600); writeFileSync(fd, JSON.stringify(mine)); closeSync(fd);
      return () => { try { if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) rmSync(file, { force: true }); } catch { /* already gone */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null; try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch { /* unreadable lock is stale */ }
      const verified = !!owner?.identity && sameIdentity(await identify(owner.pid), owner.identity);
      const unverifiedButServing = owner && !owner.identity && isAlive(owner.pid) && await canConnect(path);
      if (owner && owner.pid !== process.pid && (verified || unverifiedButServing)) throw Object.assign(new Error('A Journal runtime is already running for this data directory'), { code: 'RUNTIME_EXISTS' });
      rmSync(file, { force: true });
    }
  }
  throw Object.assign(new Error('A Journal runtime is already running for this data directory'), { code: 'RUNTIME_EXISTS' });
}

export async function startRuntime({ dataDir, store, spawn, platform = process.platform, identify, table, hookScript, execPath = process.execPath,
  idleMs = 60_000, log = () => {}, exit = () => {}, observerMs = 300, stopGraceMs, resolveProvider = null }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = socketPath(dataDir, platform);
  const releaseLock = await acquireLock(dataDir, path, identify ?? processIdentity);
  if (await canConnect(path)) { releaseLock(); throw Object.assign(new Error('A Journal runtime is already running for this data directory'), { code: 'RUNTIME_EXISTS' }); }
  // We hold the lock and nothing answers: any socket file left here is stale.
  if (platform !== 'win32') rmSync(path, { force: true });
  const token = randomBytes(32).toString('hex'); const runtimeId = randomUUID(); const build = buildId();
  let manager = null;
  const observers = new Observers({ dataDir, hookScript, execPath, platform, ingest: (id, event) => manager.ingest(id, event),
    lost: id => manager.record(id, 'error', { message: 'Activity observation stopped: the hook event file reached its size limit.' }) });
  // Set by main when it launches the runtime; otherwise this checkout's version.
  const appVersion = process.env.JOURNAL_APP_VERSION || (() => { try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();
  manager = new TerminalManager({ store, spawn, runtimeId, platform, appVersion, makeSettings: (session, project) => observers.settings(session, project),
    ...(identify ? { identify } : {}), ...(table ? { table } : {}), ...(stopGraceMs ? { stopGraceMs } : {}), resolveProvider });
  const recovered = await manager.recover();
  // Trace retention (timelines of long-ended sessions); knowledge is never pruned.
  try { await store.applyRetention?.({ eventDays: 90 }); } catch (error) { log(`retention skipped: ${error.message}`); }
  if (recovered.length) log(`recovered ${recovered.length} session(s) from a previous runtime`);
  // Phase 8: what this runtime recovered, reported in every hello until the app
  // acknowledges it. In memory only: the sessions themselves stay recorded as
  // interrupted or orphaned, so losing this list (an idle exit before any app
  // connects) loses a convenience, not the record. At most 100 rows, like liveSessions;
  // total counts every recovered session, which the app shows, so the count stays right
  // if the list is ever cut (today recover() itself sees at most 100 live sessions).
  let recovery = recovered.length ? { at: new Date().toISOString(), runtimeId, total: recovered.length,
    sessions: recovered.slice(0, 100).map(session => ({ id: session.id, status: session.status, identityVerified: session.identityVerified ?? null })) } : null;
  let client = null; let lastClientAt = Date.now(); let closing = null; const ended = new Set();
  manager.on('event', event => {
    if (event.type === 'status' && !['starting', 'running', 'waiting', 'stopping'].includes(event.session.status) && !ended.has(event.session.id)) {
      ended.add(event.session.id);
      setTimeout(() => { try { observers.release(event.session.id); } catch (error) { log(`observer release failed: ${error.message}`); } }, 500).unref();
      // Deterministic proposals after a session ends; never blocks or fails the session.
      // Always sent, naming the session and including zero, so the wrap-up stops looking at the real moment;
      // failed: generation threw, so "no suggestions" would be untrue.
      const { id: sessionId, projectId } = event.session;
      setTimeout(() => {
        Promise.resolve().then(() => store.generateProposals?.(sessionId))
          .then(created => ({ count: created?.length ?? 0 }), error => { log(`proposals failed: ${error?.message ?? error}`); return { count: 0, failed: true }; })
          .then(result => { client?.send({ event: { type: 'proposals', projectId, sessionId, ...result } }); });
      }, 1500).unref();
    }
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
    paste: ({ id, text, reference }) => manager.paste(id, text, reference),
    resize: ({ id, cols, rows }) => manager.resize(id, cols, rows),
    setAppearance: ({ appearance } = {}) => manager.setAppearance(appearance),
    interrupt: ({ id }) => manager.interrupt(id),
    stop: ({ id }) => manager.stop(id),
    terminateSurvivors: ({ id }) => manager.terminateSurvivors(id),
    terminateOrphan: ({ id }) => manager.terminateOrphan(id),
    confirmNativeId: ({ id, nativeId }) => manager.confirmNativeId(id, nativeId),
    release: ({ id }) => manager.release(id),
    // Clears the recovery only when at names it, so a stale acknowledgement never hides a newer one.
    acknowledgeRecovery: ({ at } = {}) => { const cleared = !!recovery && typeof at === 'string' && at === recovery.at; if (cleared) recovery = null; return { cleared }; },
    shutdown: ({ stopSessions = true } = {}) => { setImmediate(() => void shutdown({ stopSessions })); return { stopping: manager.liveEntries().length }; },
  };

  const server = net.createServer(socket => {
    let authenticated = false; let challenge = null;
    const connection = { send: message => { if (!socket.destroyed) socket.write(frame(message)); }, close: () => socket.destroy() };
    socket.setEncoding('utf8');
    socket.on('data', lineReader(async message => {
      const { id, method, params } = message ?? {};
      if (!authenticated) {
        // hello: client nonce -> server proves the token and issues a challenge.
        if (method === 'hello' && !challenge && params?.protocol === PROTOCOL && typeof params?.nonce === 'string' && params.nonce.length >= 32) {
          challenge = { client: params.nonce, server: nonce() };
          connection.send({ id, value: { challenge: challenge.server, proof: proof(token, 'server', challenge.client, challenge.server) } }); return;
        }
        if (method === 'hello' && params?.protocol !== PROTOCOL) { connection.send({ id, error: 'Protocol mismatch', protocol: PROTOCOL, build }); socket.destroy(); return; }
        if (method !== 'auth' || !challenge || !proofMatches(proof(token, 'client', challenge.server, challenge.client), params?.proof)) { connection.send({ id, error: 'Unauthorized runtime client' }); socket.destroy(); return; }
        authenticated = true;
        // One desktop client at a time; a restarted app replaces a stale one.
        if (client) { client.close(); manager.detach(); }
        client = connection; lastClientAt = Date.now();
        // recovery is optional in the hello (no protocol change): older apps ignore it.
        connection.send({ id, value: { runtimeId, build, protocol: PROTOCOL, pid: process.pid, live: manager.liveEntries().length, recovery } });
        return;
      }
      if (client !== connection) return;
      try {
        if (!METHODS.has(method)) throw new Error('Unknown runtime operation');
        connection.send({ id, value: await handlers[method](params ?? {}) ?? null });
      } catch (error) { connection.send({ id, error: error instanceof Error ? error.message : 'Runtime operation failed', ...(error?.code ? { code: String(error.code).slice(0, 40) } : {}) }); }
    }, () => socket.destroy()));
    socket.on('error', () => {});
    socket.on('close', () => { if (client === connection) { client = null; lastClientAt = Date.now(); manager.detach(); log('client disconnected'); } });
  });
  try { await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(path, resolvePromise); }); }
  catch (error) { releaseLock(); throw error; }
  // Remember our socket file so shutdown never unlinks another runtime's.
  const socketInode = platform === 'win32' ? null : lstatSync(path).ino;
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
      try { if (platform !== 'win32' && lstatSync(path).ino === socketInode) rmSync(path, { force: true }); } catch { /* already gone */ }
      releaseLock();
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
    const { launchTarget, resolveExecutable, testProviderAllowed } = await import('../core/process.mjs');
    // Resolve on PATH (PATHEXT on Windows) and avoid cmd.exe for npm shims.
    const spawn = (executable, argv, options) => {
      const resolved = resolveExecutable(executable, options.env) ?? executable;
      // Headless test runs: never a provider CLI outside the fixture folder (also checked before the start).
      if (!testProviderAllowed(resolved, options.env)) throw Object.assign(new Error('Provider CLI outside the test provider folder'), { code: 'PROVIDER_MISSING' });
      const target = launchTarget(resolved, argv, { env: options.env });
      return pty.spawn(target.file, target.args, options);
    };
    const { StoreClient } = await import('../desktop/store-client.mjs');
    const store = new StoreClient(join(dataDir, 'journal.sqlite')); await store.ready;
    // A missing Claude or Codex CLI is found before the start (PROVIDER_MISSING, nothing sent).
    const runtime = await startRuntime({ dataDir, store, spawn, log, hookScript: unpacked(join(here, '../desktop/hook.mjs')), resolveProvider: providerResolver(),
      exit: () => setTimeout(() => process.exit(0), 50) });
    process.on('SIGTERM', () => void runtime.shutdown({ stopSessions: true }));
    process.on('SIGINT', () => void runtime.shutdown({ stopSessions: true }));
    process.on('SIGHUP', () => {}); // Detached from the app's terminal; keep sessions.
  } catch (error) {
    log(`startup failed: ${error.message}`);
    process.exit(error.code === 'RUNTIME_EXISTS' ? 0 : 1);
  }
}
