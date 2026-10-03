// Deterministic session titles from the initial task: no model call.
// First meaningful line, markdown and rule prefixes removed, whitespace
// collapsed, cut at a word boundary.
export function generateTitle(task, prior = null) {
  if (prior) return `Resume · ${String(prior.displayName || prior.title || 'session').replace(/^(?:Resume · )+/, '')}`.slice(0, 80);
  const line = String(task ?? '').split(/\r?\n/).map(value => value.trim()).find(value => /[\p{L}\p{N}]/u.test(value) && !/^```/.test(value)) ?? '';
  const clean = line.replace(/^(?:#+|[-*>]|\d+[.)])\s+/, '').replace(/^(?:rule|remember|decision|constraint|convention|lesson|task)\s*:\s*/i, '')
    // Markdown emphasis (asterisks, strikethrough) and code markers only;
    // underscores are left alone so snake_case and __dunder__ names survive.
    .replace(/`/g, '').replace(/(^|\s)(\*\*|~~)(\S(?:.*?\S)?)\2(?=\s|$|[.,;:!?])/g, '$1$3').replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|$)/g, '$1$2').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Interactive session';
  const points = [...clean]; // code points: never split an emoji or surrogate pair
  if (points.length <= 60) return clean;
  const cut = points.slice(0, 60).join(''); const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

// Fields the user owns. Runtime status saves never overwrite them.
export const SESSION_USER_FIELDS = ['displayName', 'pinned', 'pinSeq', 'archived', 'archivedAt', 'removed', 'removedAt'];
