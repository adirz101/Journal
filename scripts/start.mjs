import { spawn } from 'node:child_process';
import { journalElectron } from './electron-runtime.mjs';

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(journalElectron(), ['.'], { env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
