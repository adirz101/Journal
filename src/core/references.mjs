import { isAbsolute, relative, sep } from 'node:path';

// File references the user hands to an agent: paths and line ranges, never
// file contents. The agent reads the file itself with its own tools and
// permissions. Text is typed into the agent's input only (never submitted).

export const MAX_REFERENCES = 20;
const SAFE_PATH = /^[\w./@+-]+$/;

// A reference target relative to the session's working directory, with
// forward slashes; null when it lies outside it.
export function pathFromCwd(cwd, absolute) {
  const rel = relative(cwd, absolute);
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  return rel.split(sep).join('/');
}

const lines = (startLine, endLine) => startLine ? (endLine && endLine !== startLine ? `${startLine}-${endLine}` : `${startLine}`) : '';

// Claude Code: @path, @path#L10-20, @folder/. Codex: the plain path (its
// composer inserts paths the same way), with the line range in words.
// Paths with spaces or unusual characters are quoted and never use @.
export function formatReference(provider, { path, kind, startLine = null, endLine = null }) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\x00-\x1f\x7f]/.test(path)) throw new Error('This path cannot be referenced');
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown agent provider');
  const target = kind === 'folder' && !path.endsWith('/') ? `${path}/` : path;
  const range = lines(startLine, endLine);
  if (provider === 'claude' && SAFE_PATH.test(target)) return `@${target}${range ? `#L${range}` : ''}`;
  const quoted = SAFE_PATH.test(target) ? target : `"${target.replace(/"/g, '\\"')}"`;
  return `${quoted}${range ? ` (line${range.includes('-') ? 's' : ''} ${range})` : ''}`;
}

// The packet block for references chosen before a launch.
export function referencesBlock(references) {
  if (!references.length) return '';
  const rows = references.map(ref => `- ${ref.display}${ref.kind === 'lines' ? ` lines ${lines(ref.startLine, ref.endLine)}` : ''}${ref.kind === 'folder' ? ' (folder: focus on this area)' : ''}${ref.contentHash ? ` (sha256 ${ref.contentHash.slice(0, 12)})` : ''}`);
  return `\nReferenced by the user (read these yourself; their contents are not included here):\n${rows.join('\n')}\n`;
}

// Timeline metadata for a reference given to a running session: what was
// referenced and its fingerprint, never contents.
export function referenceEvent(reference, delivery) {
  const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
  const line = value => Number.isInteger(value) && value > 0 ? value : null;
  return { delivery, kind: ['file', 'lines', 'folder'].includes(reference?.kind) ? reference.kind : 'file', rootKey: String(reference?.rootKey ?? '').slice(0, 100),
    rootLabel: String(reference?.rootLabel ?? '').slice(0, 200), path: String(reference?.path ?? '').slice(0, 1024), text: String(reference?.text ?? '').slice(0, 1100),
    startLine: line(reference?.startLine), endLine: line(reference?.endLine), contentHash: hash(reference?.contentHash), rangeHash: hash(reference?.rangeHash), head: typeof reference?.head === 'string' ? reference.head.slice(0, 64) : null };
}
