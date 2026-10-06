import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { clientFromEnv } from './client.mjs';
import { DEFINITIONS } from './definitions.mjs';

export async function serve(client = clientFromEnv(), transport = new StdioServerTransport()) {
  const hello = await client.connect();
  const server = new McpServer({ name: 'journal', version: '1.0.0' });
  for (const name of hello.tools) {
    const definition = DEFINITIONS[name]; if (!definition) continue;
    server.registerTool(name, definition, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await client.call(name, args)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code ?? 'TOOL_FAILED', message: error.message }) }] }; }
    });
  }
  await server.connect(transport); return { server, client };
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  serve().catch(error => { process.stderr.write(`Journal tool server: ${error.message}\n`); process.exitCode = 1; });
}
