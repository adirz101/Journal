// Lightweight lexical relevance. SQLite FTS5 (porter + unicode61) stems the
// statement and an alias column built from identifiers and paths, so a task
// that says "payment retries" can find a claim about src/payments/retry.mjs.
// Still lexical: no embeddings, no semantic claim.

export const STOPWORDS = new Set(('a an and are as at be by for from in is it of on or that the this to was with ' +
  'add make do does please should would could can will into onto out up use using new update fix change file files code').split(' '));
const GENERIC_SEGMENTS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'test', 'tests', 'spec', 'index', 'main', 'mjs', 'js', 'ts', 'tsx', 'jsx', 'cjs', 'md', 'core', 'utils', 'util']);

// Split identifiers and paths: readTable -> read, table; jsonStore.mjs -> json, store.
export function identifierParts(value) {
  return value.split(/[^\p{L}\p{N}]+/u).flatMap(word => word.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2').split(' '))
    .map(part => part.toLowerCase()).filter(part => part.length > 1);
}

const PATHISH = /[\w.-]+(?:\/[\w.-]+)+|[\w-]+\.(?:mjs|cjs|js|ts|tsx|jsx|py|rs|go|rb|java|kt|swift|json|ya?ml|toml|md|css|sql|sh)\b|\b[a-z]+[A-Z][\w]*\b|\b\w+_\w+\b/g;

// Alias text indexed beside the statement: split identifiers, mentioned paths,
// the claim's area and its evidence file path.
export function aliasesFor({ statement = '', area = '', source = {} }) {
  const parts = new Set();
  for (const token of statement.match(PATHISH) ?? []) for (const part of identifierParts(token)) parts.add(part);
  for (const path of [area, source?.kind === 'file' ? source.path : ''].filter(Boolean)) for (const part of identifierParts(path)) parts.add(part);
  return [...parts].filter(part => !GENERIC_SEGMENTS.has(part)).join(' ');
}

export function queryTerms(query, limit = 24) {
  const words = query.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
  const terms = [];
  for (const word of words) {
    const whole = word.toLowerCase().replace(/^[./-]+|[./-]+$/g, '');
    for (const term of [whole, ...identifierParts(word)]) if (term && !/[./-]/.test(term) && term.length > 1 && !STOPWORDS.has(term)) terms.push(term);
  }
  return [...new Set(terms)].slice(0, limit);
}

const singular = word => word.length > 4 && word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;

// A claim scoped to an area applies when the task names the path, or names a
// distinctive segment of it (src/payments matches "payment").
export function areaMatches(area, query) {
  if (!area) return true;
  const lower = query.toLocaleLowerCase();
  if (lower.includes(area.toLocaleLowerCase())) return true;
  const wanted = new Set(identifierParts(query).map(singular));
  const segments = identifierParts(area).filter(part => !GENERIC_SEGMENTS.has(part) && part.length >= 4).map(singular);
  return segments.some(part => wanted.has(part));
}

const contentWords = statement => new Set(identifierParts(statement).map(singular).filter(word => !STOPWORDS.has(word)));
export function similarity(a, b) {
  const x = contentWords(a); const y = contentWords(b);
  if (!x.size || !y.size) return 0;
  let shared = 0; for (const word of x) if (y.has(word)) shared++;
  return shared / (x.size + y.size - shared);
}
export const normalizedStatement = statement => statement.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const NEGATION = /\b(?:never|not|no|don'?t|do not|must not|avoid|without|disallow|forbid(?:den)?|deprecated|instead of)\b/i;
const numbers = statement => (statement.match(/\b\d+(?:\.\d+)?\b/g) ?? []).sort().join(',');
// Near-duplicates must agree on numbers and polarity; otherwise they may conflict.
export const isDuplicate = (a, b) => normalizedStatement(a) === normalizedStatement(b)
  || (similarity(a, b) >= 0.85 && numbers(a) === numbers(b) && NEGATION.test(a) === NEGATION.test(b));
// Basic conflict signal for review, not a verdict: similar subject matter with
// opposite polarity or different numbers.
export function possibleConflict(a, b) {
  if (normalizedStatement(a) === normalizedStatement(b) || similarity(a, b) < 0.35) return false;
  return NEGATION.test(a) !== NEGATION.test(b) || (numbers(a) !== numbers(b) && !!numbers(a) && !!numbers(b));
}
