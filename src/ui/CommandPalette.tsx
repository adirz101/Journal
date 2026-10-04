import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useModalDialog } from './useModalDialog';
import { ProviderMark } from './ProviderMark';
import { keyLetter } from './keys';
import { palette as words } from './copy';
import { actionItems, buildGroups, fileGroup, findItem, keepActive, mergeFileSearches, moveActive, noteItems, optionDomId, PALETTE_ACTIONS, parseQuery, quietItems, searchesMemory, sessionMatches, splitPath,
  type PaletteActionId, type PaletteGroup, type PaletteItem, type RootSearch, type Span } from './paletteModel';
import { api, PROVIDER_NAMES, type CommandId, type FileRoot, type FileSearch, type MemoryPage, type Session } from './types';

export interface CommandPaletteProps {
  mode: 'all' | 'files'; purpose?: 'open' | 'reference';
  // lead: the action listed and active first (Open project… for open-file without a project).
  lead?: PaletteActionId;
  // rootKey: the Files tab's current root; its additional folders are searched too.
  projectId: string | null; rootKey: string; projectName: string | null;
  sessions: Session[]; now: number; connected: boolean; mac: boolean;
  keys: Partial<Record<CommandId, { label: string; aria: string }>>;
  // Why each action is unavailable (the guard its button or key uses), or null.
  blocks: Partial<Record<PaletteActionId, string | null>>;
  onRun(id: PaletteActionId): void; onOpenSession(session: Session): void; onOpenNote(id: string): void;
  onOpenFile(path: string, rootKey: string): void; onNewWithTask(text: string): void; onAddNote(text: string): void; onClose(): void;
}

const MEMORY_DELAY = 150; const FILE_DELAY = 120;

// Text with its matched ranges marked. offset: where text starts inside the string the spans index.
function marked(text: string, spans: Span[], offset = 0): ReactNode {
  const parts: ReactNode[] = []; let at = 0;
  for (const [start, end] of spans) {
    const from = Math.max(start - offset, at); const to = Math.min(end - offset, text.length);
    if (to <= from) continue;
    if (from > at) parts.push(text.slice(at, from));
    parts.push(<mark key={from}>{text.slice(from, to)}</mark>); at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

// The command palette and open-file (board 7): one input, the only tab stop, with the
// results as a listbox it controls (WAI-ARIA combobox; options are reached with
// aria-activedescendant, so focus, the caret and IME stay in the input). Opening and
// closing are instant: this is a keyboard surface used many times a day. The palette
// never acts by itself: it opens, selects and prefills; Start, Continue and Remember stay
// on their own buttons. Memoized: App passes stable callbacks and blocks, so it re-renders only
// when the session list, the clock (every 5-15 s) or the connection changes, not on terminal output.
export const CommandPalette = memo(function CommandPalette(props: CommandPaletteProps) {
  const { projectId, rootKey, sessions, now, connected, mac, keys, blocks, lead } = props;
  const dialog = useRef<HTMLDialogElement>(null); const input = useRef<HTMLInputElement>(null);
  useModalDialog(dialog);
  // After the dialog is shown (the hook above runs first), the input takes focus.
  useEffect(() => { input.current?.focus(); }, []);
  const reference = props.purpose === 'reference';
  const [mode, setMode] = useState<'all' | 'files'>(reference ? 'files' : props.mode);
  const files = mode === 'files';
  const [raw, setRaw] = useState('');
  const { text, actionsOnly } = useMemo(() => files ? { text: raw.trim(), actionsOnly: false } : parseQuery(raw), [raw, files]);

  // The roots searched (plan decision 12): the Files tab's current root, then its additional
  // folders (those that exist), as the Files tab shows them. The root's name is the placeholder's.
  const [roots, setRoots] = useState<{ key: string; label: string | null; folder: boolean }[] | null>(null);
  useEffect(() => {
    if (!files || !projectId) return; let current = true;
    void api<{ primary: FileRoot[]; folders: FileRoot[] }>('fileRoots', { projectId }).then(found => {
      if (!current) return;
      const primary = found.primary.find(root => root.key === rootKey);
      setRoots([{ key: rootKey, label: primary?.label ?? null, folder: false }, ...found.folders.filter(root => root.exists !== false && root.key !== rootKey).map(root => ({ key: root.key, label: root.label, folder: true }))]);
    }).catch(() => { if (current) setRoots([{ key: rootKey, label: null, folder: false }]); });
    return () => { current = false; };
  }, [files, projectId, rootKey]);
  const rootLabel = roots?.[0]?.label ?? null;

  // Project memory: debounced; only the latest request applies.
  const [notes, setNotes] = useState<{ query: string; page: MemoryPage | null }>({ query: '', page: null });
  const memoryWanted = !files && !!projectId && searchesMemory(text, actionsOnly);
  const memoryTicket = useRef(0);
  useEffect(() => {
    const ticket = ++memoryTicket.current;
    if (!memoryWanted) return;
    const timer = setTimeout(() => void api<MemoryPage>('memoryPage', { projectId, search: text, filter: 'active', limit: 5, offset: 0 })
      .then(page => { if (ticket === memoryTicket.current) setNotes({ query: text, page }); })
      .catch(() => { if (ticket === memoryTicket.current) setNotes({ query: text, page: { items: [], total: 0, offset: 0, limit: 5, counts: {} } }); }), MEMORY_DELAY);
    return () => clearTimeout(timer);
  }, [memoryWanted, projectId, text]);
  const notesLoading = memoryWanted && notes.query !== text;

  // Open-file search: debounced in the renderer; main caches each root's listing and ranks it.
  // Every root is searched at once and the hits are merged by score (mergeFileSearches).
  const [found, setFound] = useState<{ query: string; result: ReturnType<typeof mergeFileSearches> | null; failed: boolean }>({ query: '', result: null, failed: false });
  const fileTicket = useRef(0);
  useEffect(() => {
    const ticket = ++fileTicket.current;
    if (!files || !projectId || !text || !roots) return;
    const one = (root: { key: string; label: string | null; folder: boolean }): Promise<RootSearch> => api<FileSearch>('searchFiles', { projectId, rootKey: root.key, query: text.slice(0, 200), limit: 50 })
      .then(result => ({ rootKey: root.key, rootLabel: root.folder ? root.label : null, result }));
    const timer = setTimeout(() => void one(roots[0]).then(async first => {
      // An additional folder that fails is left out; the Files tab's root decides the notes.
      const rest = await Promise.all(roots.slice(1).map(root => one(root).catch(() => ({ rootKey: root.key, rootLabel: root.label, result: null }))));
      if (ticket === fileTicket.current) setFound({ query: text, result: mergeFileSearches([first, ...rest]), failed: false });
    }).catch(() => { if (ticket === fileTicket.current) setFound({ query: text, result: null, failed: true }); }), FILE_DELAY);
    return () => clearTimeout(timer);
  }, [files, projectId, roots, text]);

  const can = useMemo(() => (id: PaletteActionId) => blocks[id] ?? null, [blocks]);
  const groups: PaletteGroup[] = useMemo(() => {
    if (files) return text && found.result?.available ? fileGroup(found.result.hits) : [];
    const sessionItems = actionsOnly ? [] : sessionMatches(sessions, projectId, text, now, connected, keys);
    const quiet = actionsOnly || text ? [] : quietItems(sessions, now, connected);
    const memory = memoryWanted && notes.query === text ? noteItems(notes.page?.items ?? [], text) : [];
    const order = lead ? [lead, ...PALETTE_ACTIONS.filter(id => id !== lead)] : PALETTE_ACTIONS;
    return buildGroups({ text, actionsOnly, sessions: sessionItems, quiet, actions: actionItems(order, keys, can, text), notes: memory, notesLoading, fallbacks: !!projectId, actionsFirst: !!lead });
  }, [files, text, found, actionsOnly, sessions, projectId, now, connected, keys, can, memoryWanted, notes, notesLoading, lead]);

  // The active option is kept by id; when it goes, the first option is active
  // (in no-results, New session with this task).
  const [chosen, setChosen] = useState<string | null>(lead ? `action:${lead}` : null);
  const active = keepActive(groups, chosen);
  const flat = useMemo(() => groups.flatMap(group => group.items), [groups]);
  // DOM ids follow each option's own id (review I3); a rare hash collision gets a suffix.
  const domIds = useMemo(() => {
    const ids = new Map<string, string>(); const used = new Set<string>();
    for (const item of flat) { let dom = optionDomId(item.id); for (let n = 2; used.has(dom); n++) dom = `${optionDomId(item.id)}-${n}`; used.add(dom); ids.set(item.id, dom); }
    return ids;
  }, [flat]);
  const domId = (id: string | null) => id === null ? undefined : domIds.get(id);
  const activeDom = domId(active);
  useEffect(() => { if (activeDom) document.getElementById(activeDom)?.scrollIntoView({ block: 'nearest' }); }, [activeDom]);

  // Enter while the file list still shows an earlier query's results waits for this query's
  // reply, then opens its first file: a quick type-and-Enter never opens a stale match. Enter
  // while nothing is listed yet because notes are still loading waits the same way, then runs
  // what is first (in no results, New session with this task).
  const fileStale = files && !!text && found.query !== text;
  const waiting = fileStale || (notesLoading && !findItem(groups, active));
  const [enterPending, setEnterPending] = useState(false);
  useEffect(() => { if (enterPending && !waiting) { setEnterPending(false); run(findItem(groups, keepActive(groups, chosen))); } }); // eslint-disable-line react-hooks/exhaustive-deps
  function run(item: PaletteItem | null) {
    if (!item) return;
    if (item.kind === 'session') props.onOpenSession(item.session);
    else if (item.kind === 'action') { if (item.enabled) props.onRun(item.action); }
    else if (item.kind === 'note') props.onOpenNote(item.noteId);
    else if (item.kind === 'file') props.onOpenFile(item.path, item.rootKey);
    else if (item.id === 'new-with-task') props.onNewWithTask(text);
    else props.onAddNote(text);
  }

  // The palette's own keys: main stops routing shortcuts while a dialog is open, so the
  // toggle (⌘K, ⇧⌘P / Ctrl+Shift+P) closes it here and the open-file key (⌘P /
  // Ctrl+Shift+O) switches to files with the text kept (in files, it closes).
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    const letter = keyLetter(event.key, event.code);
    const command = mac ? event.metaKey && !event.ctrlKey && !event.altKey : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
    if (command && letter) {
      const toggle = mac ? (letter === 'k' && !event.shiftKey) || (letter === 'p' && event.shiftKey) : letter === 'p';
      const openFile = mac ? letter === 'p' && !event.shiftKey : letter === 'o';
      if (toggle || (openFile && files)) { event.preventDefault(); props.onClose(); return; }
      if (openFile && !reference) { event.preventDefault(); setMode('files'); setChosen(null); return; }
    }
    const move = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'PageDown' ? 'next-group' : event.key === 'PageUp' ? 'prev-group' : null;
    if (move !== null && !event.altKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setChosen(moveActive(groups, active, move)); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); if (waiting) setEnterPending(true); else run(findItem(groups, active)); return; }
    if (event.key === 'Tab') event.preventDefault();
  }

  const title = reference ? words.referenceTitle : files ? words.fileTitle : words.title;
  const placeholder = files ? (reference ? words.referencePlaceholder : words.filePlaceholder)(rootLabel ?? props.projectName ?? '') : words.placeholder;
  const result = found.query === text ? found.result : null;
  const fileNote = !files ? null : !projectId ? words.reasons.needsProject : !text ? words.fileHint
    : found.failed && found.query === text ? words.fileFailed
    : result && !result.available ? (result.reason === 'not-git' ? words.notGit : words.fileFailed)
    : result && !result.hits.length ? words.noFiles(text) : null;
  const truncated = files && text && result?.available && result.truncated ? words.filesTruncated(result.listed ?? result.total, result.truncatedBy) : null;
  const none = groups[0]?.id === 'none';
  // Kept while a query is still loading, so an intermediate count is never read out.
  // No results: the count says so; the visible message says what was searched.
  const countText = words.resultCount(none ? 0 : flat.length);
  const [settledCount, setSettledCount] = useState('');
  useEffect(() => { if (!waiting && !(files && text && !found.result && !found.failed)) setSettledCount(countText); }, [countText, waiting, files, text, found]);

  const option = (item: PaletteItem) => {
    const on = item.id === active; const disabled = item.kind === 'action' && !item.enabled;
    let body: ReactNode;
    if (item.kind === 'session') body = <><ProviderMark provider={item.session.provider} size={18} /><span className="palette-label"><span className="visually-hidden">{PROVIDER_NAMES[item.session.provider]}: </span>{marked(item.label, item.spans)}</span>
      <span className="palette-detail">{item.detail}</span>{item.keys && <kbd aria-hidden="true">{item.keys}</kbd>}{item.action === 'continue' && <span className="palette-hint">{words.continueHint}</span>}</>;
    else if (item.kind === 'action') body = <><span className="palette-glyph" aria-hidden="true">›</span><span className="palette-label">{marked(item.label, item.spans)}</span>
      {item.reason && <span className="palette-detail palette-reason">{item.reason}</span>}{item.keys && <kbd aria-hidden="true">{item.keys}</kbd>}</>;
    else if (item.kind === 'note') body = <><span className="palette-cat">{item.category}</span><span className="palette-label palette-clip" dir="auto">{marked(item.label, item.spans)}</span></>;
    else if (item.kind === 'file') { const { name, folder, nameStart } = splitPath(item.path);
      body = <><span className="palette-label palette-file">{marked(name, item.spans, nameStart)}</span>{(folder || item.rootLabel) && <span className="palette-folder"><span>{item.rootLabel && `${item.rootLabel}${folder ? '/' : ''}`}{marked(folder, item.spans)}</span></span>}</>; }
    else body = <><span className="palette-label">{item.label}</span>{item.id === 'new-with-task' && <kbd aria-hidden="true">↵</kbd>}</>;
    return <div key={item.id} id={domId(item.id)} role="option" aria-selected={on} aria-disabled={disabled || undefined} title={item.kind === 'file' ? (item.rootLabel ? `${item.rootLabel}/${item.path}` : item.path) : undefined}
      className={`palette-option${on ? ' active' : ''}${item.kind === 'fallback' ? ' fallback' : ''}`}
      onPointerMove={() => { if (!on) setChosen(item.id); }} onMouseDown={event => event.preventDefault()} onClick={() => run(item)}>{body}</div>;
  };

  // Escape is the dialog's native cancel; closing restores focus (useModalDialog).
  // A click on the backdrop (the dialog element itself, outside the box) closes too.
  return <dialog ref={dialog} className="palette" aria-label={title} onCancel={event => { event.preventDefault(); props.onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}>
    <div className="palette-box">
      <div className="palette-search">
        <svg className="palette-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input ref={input} role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" aria-activedescendant={activeDom} aria-label={title} aria-describedby="palette-how"
          placeholder={placeholder} value={raw} onChange={event => { setRaw(event.target.value); setChosen(null); setEnterPending(false); }} onKeyDown={onKeyDown} spellCheck={false} autoComplete="off" maxLength={200} />
        <kbd aria-hidden="true">esc</kbd>
      </div>
      <p id="palette-how" className="visually-hidden">{files ? words.fileHowTo : words.howTo}</p>
      <div id="palette-list" role="listbox" aria-label={files ? words.groups.files : words.results} className="palette-list">
        {groups.map(group => <div key={group.id} role="group" aria-labelledby={`palette-group-${group.id}`} className={`palette-group${group.id === 'none' ? ' none' : ''}`}>
          {group.id === 'none' ? <p id="palette-group-none" role="presentation" className="palette-none">{group.label}</p>
            : <div id={`palette-group-${group.id}`} role="presentation" className="palette-caption">{group.label}</div>}
          {group.id === 'none' ? <div className="palette-fallbacks">{group.items.map(option)}</div> : group.items.map(option)}
        </div>)}
      </div>
      {(fileNote || truncated) && <p className="palette-note" role="status">{fileNote ?? truncated}</p>}
      {/* The number of results, announced politely once the current query has settled (review I3). */}
      <p className="visually-hidden" role="status" aria-live="polite">{settledCount}</p>
      {none && <p className="palette-note">{words.searches}</p>}
      <div className="palette-footer" aria-hidden="true">
        <span><kbd>↑↓</kbd> {words.move}</span><span><kbd>↵</kbd> {words.open}</span>{!files && <span className="palette-footer-end">{words.commandsOnly.split('>')[0]}<kbd>&gt;</kbd>{words.commandsOnly.split('>')[1]}</span>}
      </div>
    </div>
  </dialog>;
});
