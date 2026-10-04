import net from 'node:net';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildId, frame, lineReader, nonce, proof, proofMatches, PROTOCOL } from '../runtime/protocol.mjs';
import { isAlive } from '../core/process.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// The desktop app's connection to the runtime. It starts the runtime when none
// is listening, reconnects after the runtime restarts, and reports a build
// mismatch instead of silently mixing versions.
export class RuntimeClient extends EventEmitter {
  constructor({ dataDir, launch, connectTimeoutMs = 15000 }) {
    super(); this.dataDir = dataDir; this.launch = launch; this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null; this.pending = new Map(); this.sequence = 0; this.closing = false; this.info = null; this.connecting = null;
    this.launched = null; this.launches = 0;
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
        if (!launched) launched = this.maybeLaunch() || true;
        await wait(150);
      }
      throw new Error('Could not start the Journal runtime');
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  adopt({ socket, hello }) {
    this.socket = socket; this.info = hello;
    if (hello.build !== buildId()) this.emit('warning', 'Sessions are running in a runtime from another Journal build. Stop them to switch to this build.');
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const pending of this.pending.values()) pending.reject(new Error('Journal runtime disconnected'));
      this.pending.clear();
      if (!this.closing) { this.emit('disconnected'); void this.reconnect(); }
    });
  }
  async reconnect() {
    for (let attempt = 0; !this.closing && !this.socket; attempt++) {
      try { const hello = await this.connect(); this.mismatch = false; this.emit('reconnected', hello); return; }
      // Another version's runtime will not change by retrying quickly.
      catch (error) { await wait(error.mismatch ? 30000 : Math.min(5000, 500 * (attempt + 1))); }
    }
  }
  receive(message) {
    if (message.event) { this.emit('event', message.event); return; }
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id);
    message.error ? pending.reject(Object.assign(new Error(message.error), message.code ? { code: message.code } : {})) : pending.resolve(message.value);
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
    this.closing = true;
    if (shutdown && this.socket) { try { await this.call('shutdown', { stopSessions }); } catch { /* runtime already gone */ } }
    this.socket?.end(); this.socket = null;
  }
}
