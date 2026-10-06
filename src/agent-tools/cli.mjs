import { clientFromEnv } from './client.mjs';
const client = clientFromEnv();
try {
  const [tool, flag, payload] = process.argv.slice(2);
  if (!tool || (flag && flag !== '--json')) throw new Error('Usage: journal <tool> --json <arguments>');
  const result = await client.call(tool, payload ? JSON.parse(payload) : {});
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code })}\n`); process.exitCode = 1; }
finally { client.close(); }
