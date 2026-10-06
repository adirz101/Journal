import { mkdirSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareToolLaunch({ session, router, dataDir, socket, execPath }) {
  const grant = router.issue({ sessionId: session.id, launchId: session.launchId, role: session.role, runId: session.runId, attemptId: session.attemptId });
  const env = { JOURNAL_RUN_ID: session.runId, ...(session.taskId ? { JOURNAL_TASK_ID: session.taskId } : {}), ...(session.attemptId ? { JOURNAL_ATTEMPT_ID: session.attemptId } : {}), JOURNAL_TOOL_ID: grant.id, JOURNAL_TOOL_TOKEN: grant.token, JOURNAL_TOOL_SOCKET: socket };
  const server = fileURLToPath(new URL('../agent-tools/server.mjs', import.meta.url));
  const dir = join(dataDir, 'tools'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true, mode: 0o700 });
  const cli = fileURLToPath(new URL('../agent-tools/cli.mjs', import.meta.url));
  if (process.platform !== 'win32') {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(bin, 'journal'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(execPath)} ${quote(cli)} "$@"\n`, { mode: 0o700 });
    env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  }
  const file = join(dir, `${session.launchId}.json`);
  // Private launch configuration, outside the repository. Credentials never enter argv.
  if (session.provider === 'claude') writeFileSync(file, JSON.stringify({ mcpServers: { journal: { type: 'stdio', command: execPath, args: [server], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } } } }), { mode: 0o600 });
  return { env, config: { file, command: execPath, server }, credentialId: grant.id };
}
