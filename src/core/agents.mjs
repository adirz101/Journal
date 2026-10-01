import { execFileSync } from 'node:child_process';

// Journal-owned adapter for the documented interactive CLI arguments.
// https://code.claude.com/docs/en/cli-reference
// https://developers.openai.com/codex/cli/reference/
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CODEX_RESUME_MARKER = 'To continue this session, run';

export function buildAgentLaunch(request) {
  const { provider, nativeId, resume, prompt, settingsFile } = request;
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown agent provider');
  if ((resume || nativeId) && !UUID.test(nativeId ?? '')) throw new Error('An exact native session ID is required');

  const sessionArgs = provider === 'codex'
    ? (resume ? ['resume', nativeId] : [])
    : (resume ? ['--resume', nativeId] : nativeId ? ['--session-id', nativeId] : []);
  const settingsArgs = provider === 'claude' && settingsFile ? ['--settings', settingsFile] : [];
  return { executable: provider, argv: [...sessionArgs, ...settingsArgs, ...(prompt ? ['--', prompt] : [])] };
}

export function captureCodexId(output) {
  // Native banner is a hint, never a trusted acknowledgment or auto-resume authorization.
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // Current Codex prints a colon/newline before the command; retain the older
  // inline form too. Validate the latest banner, even if its ID is malformed.
  const marker = CODEX_RESUME_MARKER;
  const offset = clean.lastIndexOf(marker);
  if (offset < 0) return null;
  const candidate = clean.slice(offset + marker.length).match(/^:?\s+codex resume\s+(\S+)/)?.[1];
  return UUID.test(candidate) ? candidate : null;
}

export function detectAgents() {
  return ['claude', 'codex'].map(provider => {
    try {
      const version = execFileSync(provider, ['--version'], { timeout: 4000, encoding: 'utf8', windowsHide: true, maxBuffer: 16384, stdio: 'pipe' });
      return { provider, available: true, version: version.trim().split('\n').at(-1) };
    } catch { return { provider, available: false, version: null }; }
  });
}
