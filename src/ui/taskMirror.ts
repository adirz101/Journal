// The task box's underline mirror (board B13). Pure: TaskField renders the
// segments under the textarea and tests/task-mirror.test.mjs checks them.
export interface TermSpan { term: string; start: number; end: number; whole: boolean }
export interface Segment { text: string; term?: string }

// Splits text into plain and marked segments. A whole word is marked when its
// term matched; otherwise only its matched parts are (createRefund → refund).
// Overlaps resolve left to right and the longest span wins. The segments cover
// the text exactly once, in order; a trailing newline adds one zero-width space
// so the mirror keeps the textarea's last (empty) line and its height.
export const MIRROR_PAD = '​';
export function segments(text: string, spans: TermSpan[], matched: ReadonlySet<string>): Segment[] {
  const marks = spans.filter(span => matched.has(span.term) && span.start < span.end && span.end <= text.length)
    .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: Segment[] = []; let cursor = 0;
  for (const span of marks) {
    if (span.start < cursor) continue;
    if (span.start > cursor) out.push({ text: text.slice(cursor, span.start) });
    out.push({ text: text.slice(span.start, span.end), term: span.term });
    cursor = span.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  if (text.endsWith('\n')) out.push({ text: MIRROR_PAD });
  return out;
}
