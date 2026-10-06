import net from 'node:net';
import { frame, lineReader, nonce, proof, proofMatches, PROTOCOL } from '../runtime/protocol.mjs';

export class ToolClient {
  constructor({ socket, credentialId, token, role = 'tool', timeoutMs = 30000 }) { Object.assign(this, { path: socket, credentialId, token, role, timeoutMs }); this.sequence = 0; this.pending = new Map(); this.socket = null; }
  async connect() {
    if (this.socket) return this.hello;
    if (!this.path || !this.credentialId || !this.token) throw new Error('No Journal launch credential is available');
    const socket = net.connect(this.path); socket.setEncoding('utf8'); this.socket = socket;
    socket.on('data', lineReader(message => {
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(Object.assign(new Error(message.error), { code: message.code })); else request.resolve(message.value);
    }, error => socket.destroy(error)));
    const disconnect = () => { this.socket = null; for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Journal runtime disconnected; retry with the same requestId')); } this.pending.clear(); };
    socket.on('error', disconnect); socket.on('close', disconnect);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const mine = nonce(); const reply = await this.request('hello', { protocol: PROTOCOL, nonce: mine, role: this.role, credentialId: this.credentialId });
    if (!proofMatches(proof(this.token, 'server', mine, reply.challenge), reply.proof)) { this.close(); throw new Error('Journal runtime proof did not match'); }
    this.hello = await this.request('auth', { proof: proof(this.token, 'client', reply.challenge, mine) }); return this.hello;
  }
  request(method, params) {
    if (!this.socket) return Promise.reject(new Error('Journal runtime is disconnected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Journal request timed out; retry mutations with the same requestId')); }, this.timeoutMs); timer.unref();
      this.pending.set(id, { resolve, reject, timer }); this.socket.write(frame({ id, method, params }));
    });
  }
  async call(tool, args) { await this.connect(); return this.request('toolCall', { tool, args }); }
  close() { this.socket?.destroy(); this.socket = null; }
}

export const clientFromEnv = (env = process.env) => new ToolClient({ socket: env.JOURNAL_TOOL_SOCKET, credentialId: env.JOURNAL_TOOL_ID, token: env.JOURNAL_TOOL_TOKEN });
