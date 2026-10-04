import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { queryTermSpans } from '../core/retrieval.mjs';
import { segments, type Segment } from './taskMirror';
import { composer } from './copy';

const HOVER = '(hover: hover) and (pointer: fine)';
const OPEN_DELAY = 300; const CLOSE_GRACE = 150; const CARD_WIDTH = 340; const MIN_ROWS = 3; const MAX_ROWS = 8;
type Card = { term: string | null; source: 'hover' | 'button'; left: number; top: number };

function useFinePointer() {
  const [fine, setFine] = useState(() => typeof matchMedia === 'function' && matchMedia(HOVER).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(HOVER); const change = () => setFine(query.matches);
    query.addEventListener('change', change); return () => query.removeEventListener('change', change);
  }, []);
  return fine;
}

// The task box (board B13): a textarea over an aria-hidden mirror that
// underlines the task words the latest preview matched. Spans come from the
// current text on every render (queryTermSpans, the words core searches), so
// an underline never lands on the wrong characters; only the matched set lags.
// Hovering an underline for 300 ms opens a card with its notes (fine pointers
// only); the "N notes match" button opens the same card for keyboard and touch.
// Nothing here animates: typing and hovering are high-frequency.
export const TaskField = forwardRef<HTMLTextAreaElement, {
  value: string; onChange(value: string): void; matched: ReadonlySet<string>; matchCount: number;
  cardNotes(term: string | null): ReactNode; footer?: ReactNode;
}>(function TaskField({ value, onChange, matched, matchCount, cardNotes, footer }, forwarded) {
  const textarea = useRef<HTMLTextAreaElement>(null); const mirror = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null); const button = useRef<HTMLButtonElement>(null); const dialog = useRef<HTMLDivElement>(null);
  useImperativeHandle(forwarded, () => textarea.current!, []);
  const fine = useFinePointer();
  const [card, setCard] = useState<Card | null>(null);
  // IME: keep the last segments while a composition is open, so nothing flickers under it.
  const composing = useRef(false); const last = useRef<Segment[]>([]); const [, setComposed] = useState(0);
  const current = useMemo(() => segments(value, queryTermSpans(value), matched), [value, matched]);
  if (!composing.current) last.current = current;
  const shown = composing.current ? last.current : current;

  // Mark rectangles for hit-testing, measured once per render and dropped on scroll or resize.
  const rects = useRef<{ term: string; rect: DOMRect }[] | null>(null);
  useLayoutEffect(() => { rects.current = null; });
  useEffect(() => {
    const drop = () => { rects.current = null; };
    window.addEventListener('resize', drop); document.addEventListener('scroll', drop, true);
    return () => { window.removeEventListener('resize', drop); document.removeEventListener('scroll', drop, true); };
  }, []);
  const marks = () => rects.current ??= [...(mirror.current?.querySelectorAll<HTMLElement>('mark[data-term]') ?? [])]
    .flatMap(mark => [...mark.getClientRects()].map(rect => ({ term: mark.dataset.term!, rect })));

  // The textarea grows from 3 to 8 rows, then scrolls; the mirror follows its scroll.
  const fit = useCallback(() => {
    const el = textarea.current; if (!el) return;
    const style = getComputedStyle(el); const line = parseFloat(style.lineHeight) || 20;
    const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const top = el.scrollTop;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth), line * MIN_ROWS + chrome), line * MAX_ROWS + chrome)}px`;
    el.scrollTop = top;
    if (mirror.current) mirror.current.scrollTop = el.scrollTop;
    rects.current = null;
  }, []);
  useLayoutEffect(fit, [value, fit]);
  // Refit when the field's width changes (window resize, a pane docking or folding) and once fonts load.
  useEffect(() => {
    let live = true; void document.fonts?.ready.then(() => { if (live) fit(); });
    const field = textarea.current?.parentElement; let width = field?.clientWidth ?? 0;
    const observer = typeof ResizeObserver === 'function' && field ? new ResizeObserver(() => { if (field.clientWidth !== width) { width = field.clientWidth; fit(); } }) : null;
    if (field) observer?.observe(field);
    return () => { live = false; observer?.disconnect(); };
  }, [fit]);

  // Hover card timing: 300 ms warm-up, instant switches once open, 150 ms grace to reach the card.
  const openTimer = useRef<{ term: string; id: number } | null>(null); const closeTimer = useRef<number | null>(null);
  const cancelOpen = () => { if (openTimer.current) { clearTimeout(openTimer.current.id); openTimer.current = null; } };
  const cancelClose = () => { if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  useEffect(() => () => { cancelOpen(); cancelClose(); }, []);
  const place = (rect: DOMRect | null): { left: number; top: number } => {
    const frame = box.current?.getBoundingClientRect(); if (!frame) return { left: 0, top: 0 };
    const anchor = rect ?? button.current?.getBoundingClientRect() ?? frame;
    const width = Math.min(CARD_WIDTH, frame.width);
    return { left: Math.max(0, Math.min(anchor.left - frame.left, frame.width - width)), top: anchor.bottom - frame.top + 6 };
  };
  const scheduleClose = () => {
    if (closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setCard(open => open?.source === 'hover' ? null : open); }, CLOSE_GRACE);
  };
  const onPointerMove = (event: PointerEvent<HTMLTextAreaElement>) => {
    if (!fine || event.pointerType !== 'mouse' || card?.source === 'button') return;
    const hit = marks().find(({ rect }) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    if (!hit) { cancelOpen(); if (card?.source === 'hover') scheduleClose(); return; }
    cancelClose();
    if (card) { if (card.term !== hit.term) setCard({ term: hit.term, source: 'hover', ...place(hit.rect) }); return; }
    if (openTimer.current?.term === hit.term) return;
    cancelOpen();
    const rect = hit.rect;
    openTimer.current = { term: hit.term, id: window.setTimeout(() => { openTimer.current = null; setCard({ term: hit.term, source: 'hover', ...place(rect) }); }, OPEN_DELAY) };
  };
  const onPointerLeave = () => { cancelOpen(); if (card?.source === 'hover') scheduleClose(); };

  // Focus inside the card: a Leave out removes its own button, so focus returns to the
  // card (Esc keeps working). A card whose word no longer matches, or with nothing left
  // to list, closes and gives focus back to the button or the task box.
  const inCard = useRef(false);
  useLayoutEffect(() => {
    if (card && inCard.current && (!document.activeElement || document.activeElement === document.body)) dialog.current?.focus();
  });
  useEffect(() => {
    if (!card || (card.term ? matched.has(card.term) : matchCount)) return;
    setCard(null);
    if (inCard.current) { inCard.current = false; (button.current?.isConnected ? button.current : textarea.current)?.focus(); }
  }, [card, matched, matchCount]);
  // Clicking outside closes it.
  useEffect(() => {
    if (!card) return;
    const outside = (event: globalThis.PointerEvent) => { const target = event.target as Node; if (!dialog.current?.contains(target) && !button.current?.contains(target)) { inCard.current = false; setCard(null); } };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [card]);
  // Opened from the button, the card takes focus so Esc reaches it.
  useEffect(() => { if (card?.source === 'button') dialog.current?.focus(); }, [card?.source]);
  const toggleFromButton = () => setCard(open => open?.source === 'button' ? null : { term: null, source: 'button', ...place(null) });
  const onCardKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    const from = card?.source; setCard(null); inCard.current = false;
    (from === 'button' && button.current ? button.current : textarea.current)?.focus();
  };

  return <div className="task-box" ref={box}>
    <div className="task-field">
      <div ref={mirror} className="task-input task-mirror" aria-hidden="true" dir="auto">
        {shown.map((segment, index) => segment.term ? <mark key={index} data-term={segment.term}>{segment.text}</mark> : segment.text)}
      </div>
      <textarea ref={textarea} id="task" className="task-input" value={value} maxLength={4000} dir="auto" rows={MIN_ROWS} spellCheck
        placeholder={composer.taskPlaceholder} aria-describedby={matchCount > 0 ? 'task-hint task-matches' : 'task-hint'}
        onChange={event => onChange(event.target.value)} onScroll={event => { if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop; rects.current = null; }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; setComposed(n => n + 1); }}
        onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} />
    </div>
    {(footer || matchCount > 0) && <div className="task-footer">
      {footer}
      {matchCount > 0 && <button ref={button} type="button" className="task-matches" aria-expanded={card?.source === 'button'} aria-controls={card ? 'task-card' : undefined} onClick={toggleFromButton}>
        <span className="task-matches-dot" aria-hidden="true" /><span id="task-matches" aria-live="polite">{composer.notesMatch(matchCount)}</span>{fine && <span aria-hidden="true"> · {composer.hoverHint}</span>}
      </button>}
    </div>}
    {card && <div ref={dialog} id="task-card" className="task-card" role="dialog" tabIndex={-1} aria-label={card.term ? composer.notesMatching(card.term) : composer.notesMatchingTask}
      style={{ left: card.left, top: card.top }} onKeyDown={onCardKey}
      onFocus={() => { inCard.current = true; }} onBlur={event => { if (event.relatedTarget && !dialog.current?.contains(event.relatedTarget as Node)) inCard.current = false; }}
      onPointerEnter={cancelClose} onPointerLeave={() => { if (card.source === 'hover') scheduleClose(); }}>
      {cardNotes(card.term)}
    </div>}
  </div>;
});
