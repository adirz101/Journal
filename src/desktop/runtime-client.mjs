import net from 'node:net';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildId, frame, lineReader, PROTOCOL } from '../runtime/protocol.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// The desktop app's connection to the runtime. It starts the runtime when none
// is listening, reconnects after the runtime restarts, and reports a build
// mismatch instead of silently mixing versions.
export class RuntimeClient extends EventEmitter {
  constructor({ dataDir, launch, connectTimeoutMs = 15000 }) {
    super(); this.dataDir = dataDir; this.launch = launch; this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null; this.pending = new Map(); this.sequence = 0; this.closing = false; this.info = null; this.connecting = null;
  }
  readInfo() { try { return JSON.parse(readFileSync(join(this.dataDir, 'runtime.json'), 'utf8')); } catch { return null; } }
  async attempt() {
    const info = this.readInfo(); if (!info) return null;
    return new Promise(resolve => {
      const socket = net.connect(info.socket); let settled = false;
      const fail = () => { if (!settled) { settled = true; socket.destroy(); resolve(null); } };
      socket.setEncoding('utf8'); socket.once('error', fail); setTimeout(fail, 2000).unref();
      socket.once('connect', () => {
        const reader = lineReader(message => {
          if (settled) return this.receive(message);
          settled = true;
          if (message.error) { socket.destroy(); resolve(null); return; }
          resolve({ socket, hello: message.value, reader });
        }, fail);
        socket.on('data', chunk => reader(chunk));
        socket.write(frame({ id: 0, method: 'hello', params: { token: info.token, protocol: PROTOCOL } }));
      });
    });
  }
  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let launched = false; const deadline = Date.now() + this.connectTimeoutMs;
      while (Date.now() < deadline && !this.closing) {
        const connection = await this.attempt();
        if (connection) {
          if (connection.hello.build !== buildId() && !connection.hello.live && !launched) {
            // An idle runtime from another build: replace it.
            connection.socket.write(frame({ id: -1, method: 'shutdown', params: { stopSessions: false } }));
            connection.socket.destroy(); await wait(300); continue;
          }
          this.adopt(connection); return connection.hello;
        }
        if (!launched) { launched = true; this.launch(); }
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
      try { const hello = await this.connect(); this.emit('reconnected', hello); return; }
      catch { await wait(Math.min(5000, 500 * (attempt + 1))); }
    }
  }
  receive(message) {
    if (message.event) { this.emit('event', message.event); return; }
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id);
    message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.value);
  }
  async call(method, params = {}) {
    if (!this.socket) { if (this.closing) throw new Error('Journal runtime is closed'); await this.connect(); }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error('Journal runtime did not respond')); }, 30000); timer.unref();
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
