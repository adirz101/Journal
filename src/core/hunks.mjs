import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// What changed under a remembered note's cited lines (the out-of-date catch).
// Pure parsing plus two bounded, read-only Git readers. Line numbers on the old
// side are the note's own coordinates.

const MAX_BLOB = 1024 * 1024; const MAX_DIFF = 200 * 1024;
const MAX_HUNKS = 3; const MAX_LINES = 40; const MAX_TEXT = 300; const MAX_RANGE = 30;
const env = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' });
const run = (root, args, maxBuffer, encoding) => execFileSync('git', ['-C', root, ...args], { encoding, timeout: 8000, maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: env() });

// Whether the file at `commit` is exactly the content the note was saved from.
// The path is relative to `root` (./ keeps it relative inside a nested folder).
export function committedMatches(root, commit, path, hash) {
  if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit) || !hash) return false;
  try {
    const bytes = run(root, ['cat-file', 'blob', `${commit}:./${path}`], MAX_BLOB + 1, 'buffer');
    return bytes.length <= MAX_BLOB && createHash('sha256').update(bytes).digest('hex') === hash;
  } catch { return false; }
}

// The diff from `commit` to the working tree for one path; null when Git fails or the diff exceeds the cap.
// suppressBlankEmpty=false keeps the leading space on blank context lines, which parseHunks needs.
// Line endings: Git diffs the working tree after its clean filter, so with core.autocrlf a CRLF file
// is compared in its LF form. Such a file's saved hash (of the CRLF bytes) never matches the LF blob,
// so committedMatches fails and noteChange falls back to the saved excerpt; parseHunks also drops
// a trailing \r for a CRLF file committed as is.
export function diffText(root, commit, path) {
  try { return run(root, ['-c', 'diff.suppressBlankEmpty=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', commit, '--', path], MAX_DIFF, 'utf8'); }
  catch { return null; }
}

// Unified-diff hunks with both line numbers on every line. An added line also
// records `at`: the old line it follows (0 above the first line).
export function parseHunks(text) {
  const hunks = []; let hunk = null; let oldLine = 0; let newLine = 0;
  for (const raw of String(text ?? '').split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      const [oldStart, oldCount, newStart, newCount] = [Number(header[1]), header[2] === undefined ? 1 : Number(header[2]), Number(header[3]), header[4] === undefined ? 1 : Number(header[4])];
      hunk = { oldStart, oldCount, newStart, newCount, lines: [] }; hunks.push(hunk);
      // A zero count names the line before the hunk.
      oldLine = oldCount ? oldStart : oldStart + 1; newLine = newCount ? newStart : newStart + 1;
      continue;
    }
    if (!hunk || raw.startsWith('\\')) continue;
    const kind = raw[0]; const body = raw.slice(1).replace(/\r$/, '');
    if (kind === ' ') { hunk.lines.push({ kind, old: oldLine++, new: newLine++, text: body }); }
    else if (kind === '-') { hunk.lines.push({ kind, old: oldLine++, new: null, text: body }); }
    else if (kind === '+') { hunk.lines.push({ kind, old: null, new: newLine++, text: body, at: oldLine - 1 }); }
    else hunk = null; // the next file's header, or trailing text
  }
  return hunks;
}

// Hunks that touch [startLine, endLine]: a removed line inside it, or an insertion
// point in [startLine - 1, endLine]. Bounded for display: at most 3 hunks of 40 lines,
// each a window around the note's own lines (not the hunk's start), and lines of at most
// 300 characters. truncated: something that touches the note was cut, so the change was
// not shown in full (the wrap-up then asks for the full diff before "Still true").
export function selectHunks(hunks, startLine, endLine) {
  const touches = line => (line.kind === '-' && line.old >= startLine && line.old <= endLine)
    || (line.kind === '+' && line.at >= startLine - 1 && line.at <= endLine);
  // The note's own lines: old lines in range and insertions between them.
  const own = line => (line.kind !== '+' && line.old >= startLine && line.old <= endLine) || (line.kind === '+' && line.at >= startLine && line.at < endLine);
  const matched = hunks.filter(hunk => hunk.lines.some(touches));
  let truncated = matched.length > MAX_HUNKS;
  const selected = matched.slice(0, MAX_HUNKS).map(hunk => {
    const { lines } = hunk; let from = 0; let to = lines.length;
    if (lines.length > MAX_LINES) {
      let index = lines.map((line, i) => (own(line) ? i : -1)).filter(i => i >= 0);
      if (!index.length) index = lines.map((line, i) => (touches(line) ? i : -1)).filter(i => i >= 0);
      const first = index[0]; const last = index.at(-1);
      // Centre the window on the note's lines; when they alone are too many, start at the first.
      from = last - first + 1 >= MAX_LINES ? first : Math.max(0, first - Math.floor((MAX_LINES - (last - first + 1)) / 2));
      to = Math.min(lines.length, from + MAX_LINES); from = Math.max(0, to - MAX_LINES);
      truncated = true;
    }
    return { lines: lines.slice(from, to).map(({ kind, old, new: next, text }) => {
      if (text.length > MAX_TEXT) truncated = true;
      return { kind, old, new: next, text: text.slice(0, MAX_TEXT) };
    }) };
  });
  return { hunks: selected, truncated };
}

// Where an excerpt is now: its lines found exactly once at another position.
export function movedRange(excerpt, lines, startLine) {
  const wanted = String(excerpt ?? '').split(/\r?\n/); const found = [];
  for (let i = 0; i + wanted.length <= lines.length && found.length < 2; i++) {
    if (wanted.every((line, k) => lines[i + k] === line)) found.push(i + 1);
  }
  if (found.length !== 1) return { found: found.length, range: null };
  return { found: 1, range: found[0] === startLine ? null : { startLine: found[0], endLine: found[0] + wanted.length - 1 } };
}

// The old range moved by the lines added and removed above it, clamped to 30 lines and the file.
export function shiftedRange(hunks, startLine, endLine, lineCount) {
  let delta = 0;
  for (const hunk of hunks) for (const line of hunk.lines) {
    if (line.kind === '+' && line.at < startLine) delta++;
    else if (line.kind === '-' && line.old < startLine) delta--;
  }
  if (!delta) return null;
  const start = startLine + delta; const end = Math.min(start + Math.min(endLine - startLine, MAX_RANGE - 1), lineCount);
  return start >= 1 && end >= start ? { startLine: start, endLine: end } : null;
}

// Display data for one note: hunks when the note was saved from committed content
// that Git still has, otherwise the saved excerpt beside the current lines.
// `current` is the file's current text (null when it is gone or unreadable).
export function noteChange({ root, git }, source, current) {
  const lines = current === null ? null : current.split(/\r?\n/);
  const { startLine, endLine } = source;
  const empty = { hunks: null, before: { startLine, lines: String(source.excerpt ?? '').split(/\r?\n/) }, after: null, suggestedRange: null, truncated: false };
  if (!lines) return empty;
  const moved = movedRange(source.excerpt, lines, startLine);
  if (git && committedMatches(root, source.commit, source.path, source.contentHash)) {
    const text = diffText(root, source.commit, source.path);
    if (text !== null) {
      const all = parseHunks(text); const { hunks, truncated } = selectHunks(all, startLine, endLine);
      return { hunks, truncated, before: null, after: null,
        suggestedRange: moved.found === 1 ? moved.range : shiftedRange(all, startLine, endLine, lines.length) };
    }
  }
  const at = Math.min(startLine, Math.max(1, lines.length));
  return { ...empty, after: { startLine: at, lines: lines.slice(at - 1, Math.min(endLine, lines.length)) }, suggestedRange: moved.range };
}
