export function text(value, label, max = 2000, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

export function choice(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function refuseCredentials(value) {
  if (/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{16,}|\b(?:password|api[_-]?key|secret|access[_-]?token)\s*[=:]\s*["']?[^\s"']{4,}/i.test(value)) {
    throw new Error('Possible credential detected; remove it before saving knowledge');
  }
}

export function relativePath(value, allowEmpty = false) {
  const path = text(value, 'relative path', 1024, allowEmpty);
  if (!path && allowEmpty) return '';
  if (path.startsWith('/') || path.includes('\\') || path.includes(':') || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Source must be a relative path inside this checkout');
  }
  return path;
}

// Replace credential-looking substrings before text is persisted, logged or
// shown in activity views. Finite patterns: a mitigation, not a guarantee.
const CREDENTIALS = /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[abposr]-[A-Za-z0-9-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\bBearer\s+[A-Za-z0-9._-]{16,}|\b((?:password|passwd|api[_-]?key|secret|access[_-]?token|auth[_-]?token)\s*[=:]\s*)["']?[^\s"']{4,}/gi;
export function redact(value, max = 2000) {
  if (typeof value !== 'string') return '';
  return value.replace(CREDENTIALS, (match, assignment) => assignment ? `${assignment}[redacted]` : '[redacted]').slice(0, max);
}
