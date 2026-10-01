import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import electron from 'electron';
const result = spawnSync(electron, [resolve('scripts/smoke-agents.mjs')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
