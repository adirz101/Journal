// A fixture worker (no provider CLI): reads its environment variables, listens on its first port,
// writes a file in its own folder and in its temp folder, reports what it saw, and stays alive
// until killed. Two of these must run side by side without sharing ports or files.
import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.JOURNAL_PORT);
const server = net.createServer(socket => socket.end(`${process.env.JOURNAL_ENV_ID}\n`));
server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
  writeFileSync(join(process.cwd(), `worker-${process.env.JOURNAL_ENV_ID}.txt`), `written by ${process.env.JOURNAL_ENV_ID}\n`);
  writeFileSync(join(process.env.TMPDIR, 'scratch.txt'), `temp of ${process.env.JOURNAL_ENV_ID}\n`);
  process.stdout.write(`${JSON.stringify({ id: process.env.JOURNAL_ENV_ID, port, ports: process.env.JOURNAL_PORTS, base: process.env.JOURNAL_ENV_BASE, branch: process.env.JOURNAL_LOGICAL_BRANCH, cwd: process.cwd(), tmp: process.env.TMPDIR })}\n`);
});
server.on('error', error => { process.stdout.write(`${JSON.stringify({ error: error.code })}\n`); process.exit(3); });
setInterval(() => {}, 1 << 30);
