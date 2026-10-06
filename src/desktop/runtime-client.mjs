import net from 'node:net';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildId, frame, lineReader, nonce, proof, proofMatches, PROTOCOL } from '../runtime/protocol.mjs';
import { isAlive } from '../core/process.mjs';

// Sessions a runtime still holds: while any is in one of these states, it is not replaced.
const KEPT = new Set(['starting', 'running', 'waiting', 'stopping', 'orphaned']);
export const OTHER_BUILD = 'Running sessions use another version of Journal. They keep working, and Journal switches to this version when they end. Until then, new sessions start there too, without worktrees, read-only or plan mode, Cursor or file references.';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// The pause between reconnect attempts: unref'd, and cleared when its signal aborts
// (retryNow or close), so a woken pause leaves no timer behind.
const pauseFor = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms); timer.unref?.();
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

// The desktop app's connection to the runtime. It starts the runtime when none
// is listening, reconnects after the runtime restarts, and reports a build
// mismatch instead of silently mixing versions.
// delay(ms, signal): the timer between reconnect attempts (tests inject one); retryNow()
// wakes it and aborts signal.
export class RuntimeClient extends EventEmitter {
  constructor({ dataDir, launch, connectTimeoutMs = 15000, delay = pauseFor }) {
    super(); this.dataDir = dataDir; this.launch = launch; this.connectTimeoutMs = connectTimeoutMs; this.delay = delay;
    this.socket = null; this.pending = new Map(); this.sequence = 0; this.closing = false; this.info = null; this.connecting = null;
    this.launched = null; this.launches = 0;
    // warning: the build-mismatch warning of the current connection, or null.
    this.warning = null;
    // reconnecting: the one reconnect loop's promise; wake: ends its current pause; retry: a user retry
    // asks the connect() in progress to try launching again.
    this.reconnecting = null; this.wake = null; this.retry = false;
  }
  readInfo() { try { return JSON.parse(readFileSync(join(this.dataDir, 'runtime.json'), 'utf8')); } catch { return null; } }
  async attempt() {
    const info = this.readInfo(); if (!info) return null;
    return new Promise(resolve => {
      const socket = net.connect(info.socket); let settled = false;
      const fail = () => { if (!settled) { settled = true; socket.destroy(); resolve(null); } };
      socket.setEncoding('utf8'); socket.once('error', fail); setTimeout(fail, 2000).unref();
      socket.once('connect', () => {
        const mine = nonce(); let challenged = false;
        const reader = lineReader(message => {
          if (settled) return this.receive(message);
          if (message.error === 'Protocol mismatch') { settled = true; socket.destroy(); resolve({ mismatch: message.protocol }); return; }
          if (message.closing === true) { settled = true; socket.destroy(); resolve({ closing: true }); return; }
          if (message.error) { fail(); return; }
          if (!challenged) {
            // The server must prove the token before we prove ours.
            challenged = true;
            const { challenge, proof: serverProof } = message.value ?? {};
            if (typeof challenge !== 'string' || !proofMatches(proof(info.token, 'server', mine, challenge), serverProof)) { fail(); return; }
            socket.write(frame({ id: 0, method: 'auth', params: { proof: proof(info.token, 'client', challenge, mine) } }));
            return;
          }
          settled = true; resolve({ socket, hello: message.value, reader });
        }, fail);
        socket.on('data', chunk => reader(chunk));
        socket.write(frame({ id: 0, method: 'hello', params: { protocol: PROTOCOL, nonce: mine } }));
      });
    });
  }
  // Start a runtime only when none we launched is still starting, and at most
  // three times in a row without a successful connection.
  maybeLaunch() {
    if (this.launched && (typeof this.launched.alive === 'function' ? this.launched.alive() : isAlive(this.launched))) return false;
    if (this.launches >= 3) { this.emit('failed', 'The Journal runtime could not be started. See runtime.log in the data directory.'); return false; }
    this.launches++; this.launched = this.launch() ?? null; return true;
  }
  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let launched = false; const deadline = Date.now() + this.connectTimeoutMs;
      while (Date.now() < deadline && !this.closing) {
        const connection = await this.attempt();
        // The runtime is finishing its shutdown: wait for it to go, never launch over it.
        if (connection?.closing) { await wait(150); continue; }
        if (connection?.mismatch !== undefined) {
          // A runtime from another Journal version still holds this data directory.
          // Never launch over it; its sessions stay running until it is stopped.
          const message = `A Journal runtime from another version (protocol ${connection.mismatch}) is running and keeps its sessions. Quit that version of Journal, or end its runtime, to connect.`;
          if (!this.mismatch) this.emit('warning', message);
          this.mismatch = true; throw Object.assign(new Error(message), { mismatch: true });
        }
        if (connection) {
          if (connection.hello.build !== buildId() && !connection.hello.live && !launched) {
            // An idle runtime from another build: replace it.
            connection.socket.write(frame({ id: -1, method: 'shutdown', params: { stopSessions: false } }));
            connection.socket.destroy(); await wait(300); continue;
          }
          this.launches = 0; this.adopt(connection); return connection.hello;
        }
        if (!launched || this.retry) { this.retry = false; launched = this.maybeLaunch() || true; }
        await wait(150);
      }
      throw new Error('Could not start the Journal runtime');
    })();
    // A retry asked for during this connect() belongs to it alone.
    try { return await this.connecting; } finally { this.connecting = null; this.retry = false; }
  }
  adopt({ socket, hello }) {
    this.socket = socket; this.info = hello; this.switching = false;
    this.warning = hello.build !== buildId() ? OTHER_BUILD : null;
    if (this.warning) this.emit('warning', this.warning);
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const pending of this.pending.values()) pending.reject(new Error('Journal runtime disconnected'));
      this.pending.clear();
      if (!this.closing) { this.emit('disconnected'); void this.reconnect(); }
    });
  }
  // One loop at a time, so 'reconnected' is emitted once per reconnection. A
  // connection made meanwhile by call() also ends the loop with 'reconnected'.
  reconnect() {
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      for (let attempt = 0; !this.closing; attempt++) {
        if (this.socket) { this.mismatch = false; this.emit('reconnected', this.info); return; }
        try { await this.connect(); continue; }
        // Another version's runtime will not change by retrying quickly.
        catch (error) { await this.pause(error.mismatch ? 30000 : Math.min(5000, 500 * (attempt + 1))); }
      }
    })().finally(() => { this.reconnecting = null; });
    return this.reconnecting;
  }
  // A wait between attempts that retryNow() (or close()) can end early.
  pause(ms) {
    if (this.closing) return Promise.resolve();
    return new Promise(resolve => {
      const controller = new AbortController();
      const done = () => { if (this.wake === done) this.wake = null; controller.abort(); resolve(); };
      this.wake = done; Promise.resolve(this.delay(ms, controller.signal)).then(done, done);
    });
  }
  // Reconnect now (the disconnected banner): try at once instead of after the
  // current pause. It also resets the launch counter, so a retry may start the
  // runtime again after the three-launch 'failed' stop, and clears the mismatch
  // flag, so a remaining protocol mismatch is reported again. False when there
  // is nothing to retry (connected, or closing).
  retryNow() {
    if (this.socket || this.closing) return false;
    this.launches = 0; this.mismatch = false; this.retry = !!this.connecting;
    this.wake?.();
    void this.reconnect();
    return true;
  }
  receive(message) {
    if (message.event) { this.emit('event', message.event); return; }
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id);
    message.error ? pending.reject(Object.assign(new Error(message.error), message.code ? { code: message.code } : {})) : pending.resolve(message.value);
  }
  // Connected to a runtime of another Journal build (sessions kept running across an update).
  get otherBuild() { return !!this.socket && !!this.info && this.info.build !== buildId(); }
  // Once the other build's runtime has no session left that it must keep, it is told to shut
  // down (stopping nothing) and the reconnect starts this build's runtime. Uses only list and
  // shutdown, which every earlier runtime has. true when the switch has begun.
  async switchIfIdle() {
    if (!this.otherBuild || this.switching) return false;
    let sessions; try { sessions = await this.call('list'); } catch { return false; }
    if (!this.otherBuild || this.switching || !Array.isArray(sessions) || sessions.some(session => KEPT.has(session?.status))) return false;
    return this.beginSwitch(false);
  }
  // The user's choice: stop the other build's sessions now and switch (each can be continued).
  async switchNow() { return this.otherBuild && !this.switching ? this.beginSwitch(true) : false; }
  async beginSwitch(stopSessions) {
    this.switching = true; this.emit('switching');
    try { await this.call('shutdown', { stopSessions }); } catch { /* its close starts the reconnect either way */ }
    return true;
  }
  async call(method, params = {}) {
    if (!this.socket) { if (this.closing) throw new Error('Journal runtime is closed'); await this.connect(); }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      // Starting a session may legitimately take long; never time it out and
      // invite a duplicate launch of the same task.
      const timer = method === 'start' ? null : setTimeout(() => { if (this.pending.delete(id)) reject(new Error('Journal runtime did not respond')); }, 30000); timer?.unref();
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.socket.write(frame({ id, method, params }));
    });
  }
  async close({ shutdown = false, stopSessions = true } = {}) {
    // Mark closing first so the runtime's own disconnect is not treated as a crash.
    this.closing = true; this.wake?.();
    if (shutdown && this.socket) { try { await this.call('shutdown', { stopSessions }); } catch { /* runtime already gone */ } }
    this.socket?.end(); this.socket = null;
  }
}
