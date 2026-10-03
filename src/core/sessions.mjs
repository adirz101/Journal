// Deterministic session titles from the initial task: no model call.
// First meaningful line, markdown and rule prefixes removed, whitespace
// collapsed, cut at a word boundary.
export function generateTitle(task, prior = null) {
  if (prior) return `Resume · ${prior.displayName || prior.title || 'session'}`.slice(0, 80);
  const line = String(task ?? '').split(/\r?\n/).map(value => value.trim()).find(value => value && !/^```/.test(value)) ?? '';
  const clean = line.replace(/^(?:#+|[-*>]|\d+[.)])\s+/, '').replace(/^(?:rule|remember|decision|constraint|convention|lesson|task)\s*:\s*/i, '')
    // Markdown emphasis and code markers only; identifiers like snake_case stay intact.
    .replace(/`/g, '').replace(/(\*\*|__|~~)(\S(?:.*?\S)?)\1/g, '$2').replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$)/g, '$1$2').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Interactive session';
  if (clean.length <= 60) return clean;
  const cut = clean.slice(0, 60); const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

// Fields the user owns. Runtime status saves never overwrite them.
export const SESSION_USER_FIELDS = ['displayName', 'pinned', 'pinSeq', 'archived', 'archivedAt', 'removed', 'removedAt'];
