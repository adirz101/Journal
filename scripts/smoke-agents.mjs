import { spawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildAgentLaunch, detectAgents } from '../src/core/agents.mjs';

// Startup only: no task, input, trust acceptance, login or paid inference.
mkdirSync('.cache/tmp', { recursive: true });
const root = mkdtempSync(resolve('.cache/tmp', 'native-smoke-'));
execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
const results = [];
for (const agent of detectAgents()) {
  if (!agent.available) { results.push(agent); continue; }
  const launch = buildAgentLaunch({ provider: agent.provider, nativeId: agent.provider === 'claude' ? randomUUID() : undefined });
  const env = { ...process.env, TERM: 'xterm-256color' }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise(resolveResult => {
    let output = ''; let child;
    try { child = spawn(launch.executable, launch.argv, { cwd: root, env, cols: 100, rows: 30 }); }
    catch (error) { resolveResult({ ...agent, launched: false, error: error.message }); return; }
    child.onData(data => { output = (output + data).slice(-64000); });
    const finish = () => resolveResult({ ...agent, launched: true, sawOutput: output.length > 0,
      trustPrompt: /trust|trusted|safety check/i.test(output), authPrompt: /sign in|log in|not logged|login/i.test(output),
      nativeHeader: /Claude Code|Codex/i.test(output), taskSubmitted: false });
    const timer = setTimeout(() => { try { child.kill(); } catch {} setTimeout(finish, 300).unref(); }, 5000);
    child.onExit(() => { clearTimeout(timer); finish(); });
  });
  results.push(result);
}
rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
