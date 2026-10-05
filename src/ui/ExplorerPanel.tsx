import { JOURNAL_FILE } from './fileDrag';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { hotkeysCoreFeature, searchFeature, selectionFeature, syncDataLoaderFeature, type ItemInstance } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { menuPosition, showMenu, type MenuItem } from './menu';
import { branches as branchWords, copy, shell, tip } from './copy';
import { api, isLive, type DirectoryListing, type FilePreviewData, type FileReference, type FileRoot, type FileStatus, type GitKind, type Project, type Session } from './types';
import type { LineRange } from './FilePreview';

// Read-only explorer: browse the session's workspace (or any root of the
// project), see Git state, preview files and hand references to an agent.
// No editing, no file operations.

const FilePreview = lazy(() => import('./FilePreview'));
const ROW = 30; const ROOT = '\u0000roots';
const LETTER: Record<GitKind, string> = { conflict: '!', deleted: 'D', modified: 'M', renamed: 'R', typechange: 'T', added: 'A', untracked: 'U', submodule: 'S', ignored: '' };
const DESCRIBE: Record<GitKind, string> = { conflict: 'conflict', deleted: 'deleted', modified: 'modified', renamed: 'renamed', typechange: 'type changed', added: 'added', untracked: 'untracked', submodule: 'submodule changed', ignored: 'ignored by Git' };

interface Item { id: string; rootKey: string; path: string; name: string; type: 'root' | 'directory' | 'file' | 'symlink' | 'other' | 'more'; sensitive: boolean; }
const idOf = (rootKey: string, path: string) => `${rootKey}\u0000${path}`;
// A row dragged onto a session's terminal becomes a reference there (TerminalPane, fileDrag.ts).
const dragFile = (event: DragEvent<HTMLElement>, rootKey: string, path: string) => {
  event.dataTransfer.setData(JOURNAL_FILE, JSON.stringify({ rootKey, path })); event.dataTransfer.effectAllowed = 'copy';
};
// Phase 8: the last palette request handled, kept across remounts (the Files tab mounts this
// panel each time it is shown), so an old request never opens its file again.
let revealHandled = 0;
type Roots = { primary: FileRoot[]; folders: FileRoot[] };
interface Preview { rootKey: string; path: string; mode: 'file' | 'diff'; data?: FilePreviewData; diff?: { text: string; truncated: boolean; hidden: boolean }; error?: string; line?: number; }

// Git state of one path: its own entry, or the untracked/ignored folder that contains it.
function lookup(status: FileStatus | undefined) {
  const exact = new Map(status?.entries.map(entry => [entry.path, entry]) ?? []);
  const collapsed = status?.entries.filter(entry => entry.directory) ?? [];
  return (path: string) => {
    const own = exact.get(path); if (own) return own;
    return collapsed.find(entry => entry.path === '' || path === entry.path || path.startsWith(`${entry.path}/`)) ?? null;
  };
}

export function ExplorerPanel({ project, session, rootsVersion, revealLabel, focusSignal, onFocusHandled, onPreviewing, onAddReference, onSaveEvidence, onError, reveal, onRoot, onSwitchBranch }: {
  project: Project; session: Session | null; rootsVersion: string; revealLabel: string; focusSignal: number; onFocusHandled?: () => void;
  // Phase 8 review M2: the root shown (the palette searches it), and null on unmount.
  onRoot?: (projectId: string, rootKey: string | null) => void;
  // Opens the branch picker on a repository root (the shown checkout or worktree, or a Git folder).
  onSwitchBranch?: (rootKey: string) => void;
  // Phase 8: a file opened from the palette (seq increases per request); previewed once its root is shown.
  reveal?: { projectId: string; rootKey: string; path: string; seq: number } | null;
  onPreviewing: (previewing: boolean) => void; onAddReference: (reference: FileReference) => Promise<void>;
  onSaveEvidence: (source: { rootKey: string; path: string; startLine: number; endLine: number }) => void; onError: (error: unknown) => void;
}) {
  const [roots, setRoots] = useState<Roots | null>(null);
  const [override, setOverride] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'changed'>('all');
  const [statuses, setStatuses] = useState<Record<string, FileStatus>>({});
  const [preview, setPreview] = useState<Preview | null>(null); const [range, setRange] = useState<LineRange | null>(null);
  const [note, setNote] = useState(''); const [, setVersion] = useState(0); const [expanded, setExpanded] = useState<string[]>([]);
  const items = useRef(new Map<string, Item>()); const children = useRef(new Map<string, string[]>()); const loading = useRef(new Set<string>());
  const generation = useRef(0); const expandedRef = useRef(expanded); expandedRef.current = expanded;
  const loadRef = useRef<(id: string) => void>(() => {});
  const scroller = useRef<HTMLDivElement>(null);
  const ownSession = session && session.projectId === project.id ? session : null;
  const liveSession = ownSession && isLive(ownSession) ? ownSession : null;
  // Follow the selected session's workspace unless the user picked another root.
  const followKey = ownSession?.workspaceId && !ownSession.workspaceId.startsWith('root:') ? ownSession.workspaceId : 'checkout';
  const primaryKey = roots?.primary.some(root => root.key === (override ?? followKey)) ? override ?? followKey : 'checkout';
  const primary = roots?.primary.find(root => root.key === primaryKey) ?? null;
  const visible = useMemo(() => primary ? [primary, ...(roots?.folders.filter(root => root.exists !== false) ?? [])] : [], [primary, roots]);
  // A root's branch is part of the key: after a branch switch its listings are read again.
  const visibleKey = visible.map(root => `${root.key}\u0000${root.branch ?? ''}`).join('|');
  const onRootRef = useRef(onRoot); onRootRef.current = onRoot;
  useEffect(() => { if (primary) onRootRef.current?.(project.id, primaryKey); }, [project.id, primaryKey, primary]);
  useEffect(() => () => onRootRef.current?.(project.id, null), [project.id]);
  const rootFor = (key: string) => visible.find(root => root.key === key) ?? null;

  useEffect(() => { setOverride(null); }, [ownSession?.id]);
  useEffect(() => { let cancelled = false; void api<Roots>('fileRoots', { projectId: project.id }).then(next => { if (!cancelled) setRoots(next); }).catch(onError); return () => { cancelled = true; }; }, [project.id, project.roots?.length, rootsVersion, onError]);

  const tree = useTree<Item>({
    rootItemId: ROOT, indent: 12,
    state: { expandedItems: expanded }, setExpandedItems: setExpanded,
    getItemName: item => item.getItemData()?.name ?? '',
    isItemFolder: item => ['root', 'directory'].includes(item.getItemData()?.type ?? ''),
    dataLoader: {
      getItem: id => items.current.get(id) ?? { id, rootKey: '', path: '', name: '', type: 'other', sensitive: false },
      getChildren: id => {
        if (id === ROOT) return visible.map(root => idOf(root.key, ''));
        const cached = children.current.get(id); if (cached) return cached;
        loadRef.current(id); return [];
      },
    },
    scrollToItem: item => {
      const node = scroller.current; if (!node) return;
      const index = item.getItemMeta().index;
      if (index * ROW < node.scrollTop) node.scrollTop = index * ROW;
      else if ((index + 1) * ROW > node.scrollTop + node.clientHeight) node.scrollTop = (index + 1) * ROW - node.clientHeight;
    },
    // Keys act on the tree's focused item (DOM focus follows a moment later).
    hotkeys: {
      customOpen: { hotkey: 'Enter', preventDefault: true, isEnabled: t => !t.isSearchOpen(), handler: (_e, t) => activate(t.getFocusedItem()) },
      customMenu: { hotkey: 'Shift+F10', preventDefault: true, handler: (_e, t) => menuAt(t.getFocusedItem()) },
      customMenuKey: { hotkey: 'ContextMenu', preventDefault: true, handler: (_e, t) => menuAt(t.getFocusedItem()) },
    },
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, searchFeature],
  });
  function activate(item: ItemInstance<Item>) {
    const data = item.getItemData();
    if (data.type === 'file' && !data.sensitive) void openPreview(data.rootKey, data.path);
    else if (item.isFolder()) { if (item.isExpanded()) item.collapse(); else item.expand(); }
  }
  function menuAt(item: ItemInstance<Item>) {
    const rect = item.getElement()?.getBoundingClientRect();
    void itemMenu(item.getItemData(), rect ? { x: Math.round(rect.left + 16), y: Math.round(rect.bottom) } : undefined);
  }

  // Listings load when a folder is first expanded; nothing is scanned ahead.
  const load = useCallback(async (id: string) => {
    const item = items.current.get(id); if (!item || loading.current.has(id)) return;
    loading.current.add(id); const started = generation.current;
    try {
      await Promise.resolve(); // never update state during a render
      const listing = await api<DirectoryListing>('listDirectory', { projectId: project.id, rootKey: item.rootKey, path: item.path });
      if (started !== generation.current) return;
      const ids = listing.entries.map(entry => {
        const child: Item = { id: idOf(item.rootKey, entry.path), rootKey: item.rootKey, path: entry.path, name: entry.name, type: entry.type, sensitive: entry.sensitive };
        items.current.set(child.id, child); return child.id;
      });
      if (listing.truncated) { const more = `${id}\u0000more`; items.current.set(more, { id: more, rootKey: item.rootKey, path: item.path, name: `${listing.total - listing.entries.length} more not shown`, type: 'more', sensitive: false }); ids.push(more); }
      children.current.set(id, ids);
    } catch (error) {
      if (started !== generation.current) return;
      const failed = `${id}\u0000error`; items.current.set(failed, { id: failed, rootKey: item.rootKey, path: item.path, name: `Cannot list: ${error instanceof Error ? error.message : 'unavailable'}`, type: 'more', sensitive: false });
      children.current.set(id, [failed]);
    } finally { loading.current.delete(id); }
    if (started === generation.current) { tree.rebuildTree(); setVersion(v => v + 1); }
  }, [project.id, tree]);
  loadRef.current = id => void load(id);

  // A new set of roots starts a fresh tree with the primary root open.
  useEffect(() => {
    generation.current++; items.current.clear(); children.current.clear(); loading.current.clear();
    for (const root of visible) items.current.set(idOf(root.key, ''), { id: idOf(root.key, ''), rootKey: root.key, path: '', name: root.label, type: 'root', sensitive: false });
    setExpanded(visible[0] ? [idOf(visible[0].key, '')] : []); setPreview(null); setStatuses({});
    tree.rebuildTree(); setVersion(v => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  // === Phase 8: a file opened from the palette ===
  // Show its root (unless it is a folder root, always listed), then expand its folders and
  // preview it once that root's tree is in place (the effect above resets the tree first).
  useEffect(() => {
    if (!reveal || reveal.seq <= revealHandled || !roots) return;
    const primaryRoot = roots.primary.some(root => root.key === reveal.rootKey);
    // Another project's request, or a root that is gone, is dropped rather than kept waiting.
    if (reveal.projectId !== project.id || (!primaryRoot && !roots.folders.some(root => root.key === reveal.rootKey))) { revealHandled = reveal.seq; return; }
    if (primaryRoot && primaryKey !== reveal.rootKey) { setOverride(reveal.rootKey === followKey ? null : reveal.rootKey); return; }
    if (!visible.some(root => root.key === reveal.rootKey)) return;
    revealHandled = reveal.seq; setFilter('all');
    const parts = reveal.path.split('/').slice(0, -1);
    const folders = [idOf(reveal.rootKey, ''), ...parts.map((_, i) => idOf(reveal.rootKey, parts.slice(0, i + 1).join('/')))];
    setExpanded(current => [...new Set([...current, ...folders])]);
    void openPreview(reveal.rootKey, reveal.path);
  }, [reveal, roots, primaryKey, visibleKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // === End Phase 8 ===

  const refreshStatus = useCallback(async () => {
    const started = generation.current;
    const results = await Promise.all(visible.filter(root => root.git).map(async root => [root.key, await api<FileStatus>('fileStatus', { projectId: project.id, rootKey: root.key }).catch(() => null)] as const));
    if (started === generation.current) setStatuses(Object.fromEntries(results.filter(([, status]) => status)) as Record<string, FileStatus>);
  }, [visible, project.id]);
  useEffect(() => { void refreshStatus(); }, [refreshStatus, project.head]);

  // Watch the primary root; changed folders reload, Git status refreshes once per burst.
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined); const statusPendingSince = useRef(0);
  // Trailing debounce with a maximum wait, so a continuous build still refreshes every 3 s.
  const scheduleStatus = useCallback(() => {
    const now = Date.now(); if (!statusPendingSince.current) statusPendingSince.current = now;
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => { statusPendingSince.current = 0; void refreshStatus(); }, now - statusPendingSince.current > 3000 ? 0 : 750);
  }, [refreshStatus]);
  useEffect(() => {
    if (!primary) return;
    const key = `${project.id}\u0000${primary.key}`;
    void api('watchRoot', { projectId: project.id, rootKey: primary.key }).catch(() => {});
    const reload = (id: string) => { if (children.current.delete(id) && expandedRef.current.includes(id)) void load(id); };
    const off = window.journal?.onEvent(event => {
      if (event.type !== 'files' || event.key !== key) return;
      if (event.overflow) { for (const id of [...children.current.keys()]) if (items.current.get(id)?.rootKey === primary.key) reload(id); }
      else for (const folder of event.folders) reload(idOf(primary.key, folder));
      tree.rebuildTree(); setVersion(v => v + 1);
      scheduleStatus();
    });
    // Agents commit, stage and edit in worktrees too: their turns and commands refresh status.
    const offTimeline = window.journal?.onEvent(event => { if (event.type === 'timeline' && ['turn-end', 'command-end', 'file', 'stop', 'exit'].includes(event.event.kind)) scheduleStatus(); });
    const focus = () => void refreshStatus();
    window.addEventListener('focus', focus);
    return () => { off?.(); offTimeline?.(); window.removeEventListener('focus', focus); clearTimeout(statusTimer.current); void api('unwatchRoot', {}).catch(() => {}); };
  }, [primary, project.id, load, refreshStatus, scheduleStatus, tree]);

  useEffect(() => { onPreviewing(!!preview); }, [preview, onPreviewing]);
  useEffect(() => () => onPreviewing(false), [onPreviewing]);

  const lookups = useMemo(() => Object.fromEntries(Object.entries(statuses).map(([key, status]) => [key, lookup(status)])), [statuses]);
  const stateOf = (item: Item) => item.type === 'root' ? null : lookups[item.rootKey]?.(item.path) ?? null;
  const folderKind = (item: Item) => item.type === 'root' || item.type === 'directory' ? statuses[item.rootKey]?.folders[item.path] ?? null : null;

  // Only the latest request may fill the preview (a slow read never lands in a newer one).
  const previewToken = useRef(0);
  async function openPreview(rootKey: string, path: string, mode: 'file' | 'diff' = 'file', line?: number) {
    const token = ++previewToken.current; const current = () => token === previewToken.current;
    setRange(null); setNote('');
    setPreview({ rootKey, path, mode, line });
    try {
      if (mode === 'diff') {
        const diff = await api<{ text: string; truncated: boolean; hidden: boolean }>('fileDiff', { projectId: project.id, rootKey, path });
        if (current()) setPreview(value => value ? { ...value, mode, diff } : value);
      } else {
        const data = await api<FilePreviewData>('previewFile', { projectId: project.id, rootKey, path });
        if (current()) setPreview(value => value ? { ...value, mode, data } : value);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unavailable';
      if (current()) setPreview(value => value ? { ...value, error: /ENOENT|no such file/i.test(message) ? 'This file no longer exists.' : message } : value);
    }
  }
  const closePreview = () => { previewToken.current++; setPreview(null); requestAnimationFrame(() => tree.updateDomFocus()); };

  const describeTarget = (rootKey: string, path: string, kind: 'file' | 'lines' | 'folder', lines?: LineRange | null): FileReference =>
    ({ kind, rootKey, rootLabel: rootFor(rootKey)?.label, path, startLine: lines?.startLine ?? null, endLine: lines?.endLine ?? null });
  async function referenceInSession(reference: FileReference) {
    if (!liveSession) return;
    try {
      const result = await api<{ inserted: boolean; copied?: boolean; reason?: string; text: string }>('referenceInSession', { sessionId: liveSession.id, projectId: project.id, rootKey: reference.rootKey, path: reference.path, startLine: reference.startLine, endLine: reference.endLine });
      setNote(result.inserted ? `Typed ${result.text} into the agent's input. Review it and press Enter to send.` : `Copied ${result.text}. Paste it into the terminal (${result.reason ?? 'Journal could not type it'}).`);
      // Hand focus to the session's terminal so the user can paste right away.
      if (!result.inserted) window.dispatchEvent(new CustomEvent('journal:focus-terminal', { detail: liveSession.id }));
    } catch (error) { setNote(''); onError(error); }
  }
  async function addToTask(reference: FileReference) {
    try { await onAddReference(reference); setNote(`Added ${reference.path}${reference.startLine ? ` lines ${reference.startLine}-${reference.endLine}` : ''} to the next task.`); }
    catch (error) { onError(error); }
  }
  const act = (action: () => Promise<unknown>) => void action().catch(onError);

  async function itemMenu(item: Item, position?: { x: number; y: number }) {
    if (item.type === 'more') return;
    const folder = item.type === 'root' || item.type === 'directory'; const link = item.type === 'symlink' || item.type === 'other';
    const changed = !folder && !!stateOf(item) && stateOf(item)!.kind !== 'ignored'; const root = rootFor(item.rootKey);
    const blocked = item.sensitive || link;
    const choice = await showMenu([
      !folder && { id: 'preview', label: 'Open Preview', enabled: !blocked },
      !folder && changed && root?.git && { id: 'diff', label: 'View Diff', enabled: !item.sensitive },
      { separator: true },
      { id: 'refSession', label: liveSession ? `Reference ${folder ? 'Folder ' : ''}in Session` : 'Reference in Session (no running session)', enabled: !!liveSession && !blocked && !!item.path },
      { id: 'refNext', label: folder ? 'Focus Next Task on This Folder' : 'Add to Next Task', enabled: !blocked && !!item.path },
      { separator: true },
      item.type === 'root' && root?.git && onSwitchBranch && { id: 'branch', label: branchWords.menu },
      item.type === 'root' && root?.git && onSwitchBranch && { separator: true },
      { id: 'copyRel', label: 'Copy Relative Path' }, { id: 'copyAbs', label: 'Copy Path' },
      { id: 'reveal', label: revealLabel },
      !folder && { id: 'editor', label: 'Open in Editor', enabled: !blocked },
    ] as (MenuItem | false)[], position);
    const target = describeTarget(item.rootKey, item.path, folder ? 'folder' : 'file');
    if (choice === 'preview') void openPreview(item.rootKey, item.path);
    else if (choice === 'diff') void openPreview(item.rootKey, item.path, 'diff');
    else if (choice === 'refSession') void referenceInSession(target);
    else if (choice === 'refNext') void addToTask(target);
    else if (choice === 'copyRel' || choice === 'copyAbs') act(() => api('copyFilePath', { projectId: project.id, rootKey: item.rootKey, path: item.path, absolute: choice === 'copyAbs' }));
    else if (choice === 'branch') onSwitchBranch?.(item.rootKey);
    else if (choice === 'reveal') act(() => api('revealFile', { projectId: project.id, rootKey: item.rootKey, path: item.path }));
    else if (choice === 'editor') act(() => api('openInEditor', { projectId: project.id, rootKey: item.rootKey, path: item.path }));
  }

  // Virtualized rows: only the visible window is in the DOM.
  const [top, setTop] = useState(0); const [height, setHeight] = useState(400);
  useEffect(() => {
    const node = scroller.current; if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight)); observer.observe(node); return () => observer.disconnect();
  }, [preview, filter]);
  // One-shot: App clears the signal once handled, so a remount (a tab switch) never takes focus.
  // When the tree has not loaded yet (the panel was just mounted), focus waits for its first row
  // instead of staying behind (in the terminal, for example). The wait ends, without taking focus,
  // when the user goes on elsewhere: focus moving outside the inspector, a key pressed outside it,
  // ⌘E / Ctrl+Shift+E (journal:focus-terminal), or 2 s. When the rows arrive, the tree takes focus
  // only if focus is still where it was when the key was pressed, on the page, or in the inspector.
  const focusPending = useRef<{ at: number; from: Element | null } | null>(null);
  const inInspector = (node: EventTarget | Element | null) => node instanceof Element && !!node.closest('.inspector-root');
  // The request is recorded at once (a frame callback can run late in a hidden or busy window,
  // after the user has moved on); each attempt checks it is still wanted.
  const focusTree = () => {
    const pending = focusPending.current; if (!pending) return;
    const active = document.activeElement;
    if (Date.now() - pending.at > 2000 || !(active === pending.from || !active || active === document.body || inInspector(active))) { focusPending.current = null; return; }
    const focused = tree.getFocusedItem?.(); const row = focused?.getElement() ?? scroller.current?.querySelector<HTMLElement>('[role=treeitem]');
    if (row) { focusPending.current = null; row.focus(); }
  };
  useEffect(() => {
    if (!focusSignal) return; onFocusHandled?.();
    if (preview) closePreview(); else { focusPending.current = { at: Date.now(), from: document.activeElement }; requestAnimationFrame(focusTree); }
  }, [focusSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const cancel = (event: Event) => { if (focusPending.current && !inInspector(event.target)) focusPending.current = null; };
    const cancelAlways = () => { focusPending.current = null; };
    document.addEventListener('focusin', cancel); document.addEventListener('keydown', cancel, true); window.addEventListener('journal:focus-terminal', cancelAlways);
    return () => { document.removeEventListener('focusin', cancel); document.removeEventListener('keydown', cancel, true); window.removeEventListener('journal:focus-terminal', cancelAlways); };
  }, []);

  const rows = tree.getItems();
  useEffect(() => { if (focusPending.current && rows.length) requestAnimationFrame(focusTree); }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = Math.max(0, Math.floor(top / ROW) - 8); const last = Math.min(rows.length, Math.ceil((top + height) / ROW) + 8);
  const selectedId = preview ? idOf(preview.rootKey, preview.path) : null;

  const changedRows = useMemo(() => visible.filter(root => statuses[root.key]).flatMap(root => statuses[root.key].entries.filter(entry => entry.kind !== 'ignored').map(entry => ({ root, entry }))), [visible, statuses]);
  const previewRoot = preview ? rootFor(preview.rootKey) : null;
  const previewState = preview ? lookups[preview.rootKey]?.(preview.path) ?? null : null;
  const canEvidence = preview?.mode === 'file' && range && (preview.rootKey === 'checkout' || preview.rootKey.startsWith('root:')) && range.endLine - range.startLine < 30;

  return <div className="panel-content explorer-content">
    <div className="explorer-header">
      <label className="explorer-root"><span className="visually-hidden">Root</span>
        <select aria-label="Explorer root" value={primaryKey} onChange={event => setOverride(event.target.value === followKey ? null : event.target.value)}>
          {roots?.primary.map(root => <option key={root.key} value={root.key}>{root.kind === 'checkout' ? 'Checkout' : `${root.kind === 'managed' ? copy.separateCopy : 'Existing worktree'} · ${root.branch ?? 'detached'}`}</option>)}
        </select></label>
      {primary && onSwitchBranch && <button type="button" className="branch-trigger" aria-haspopup="dialog" aria-label={branchWords.trigger(primary.label, primary.branch)} title={branchWords.title(primary.label)}
        onClick={() => onSwitchBranch(primary.key)}><span aria-hidden="true">⑂</span><span className="branch-trigger-name">{primary.branch ?? branchWords.detached}</span><span className="branch-trigger-chevron" aria-hidden="true">▾</span></button>}
      <div className="explorer-tools" role="group" aria-label="Show">
        <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
        <button aria-pressed={filter === 'changed'} title={tip.uncommitted} onClick={() => setFilter('changed')}>{shell.uncommitted}{changedRows.length ? ` ${changedRows.length}` : ''}</button>
        <button aria-label="Refresh files" title="Refresh" onClick={() => { generation.current++; children.current.clear(); loading.current.clear(); tree.rebuildTree(); setVersion(v => v + 1); void refreshStatus(); for (const id of expanded) void load(id); }}>↻</button>
      </div>
    </div>
    <p className="explorer-follow muted">{override ? <>Browsing {primary?.label}. <button className="text-button" onClick={() => setOverride(null)}>Follow {ownSession ? 'session' : 'checkout'}</button></> : ownSession ? <>Following {ownSession.displayName || ownSession.title}{ownSession.workspaceId?.startsWith('root:') ? ' (runs in a folder below)' : ''}</> : 'Showing the project checkout'}</p>
    {note && <p className="explorer-note" role="status">{note}</p>}

    {preview ? <section className="file-preview" aria-label={`Preview of ${preview.path}`} onKeyDown={event => { if (event.key === 'Escape' && !(event.target as HTMLElement).closest('.cm-search')) { event.preventDefault(); closePreview(); } }}>
      <div className="preview-heading">
        <button className="text-button" onClick={closePreview} aria-label="Back to files">← Files</button>
        <span className="preview-path" title={`${previewRoot?.label ?? ''} / ${preview.path}`}>{preview.path}</span>
        {previewState && previewState.kind !== 'ignored' && <span className={`git-letter git-${previewState.kind}`} title={DESCRIBE[previewState.kind]}>{LETTER[previewState.kind]}</span>}
      </div>
      <div className="preview-actions">
        {previewRoot?.git && previewState && previewState.kind !== 'ignored' && <div role="group" aria-label="View" className="segmented">
          <button aria-pressed={preview.mode === 'file'} onClick={() => void openPreview(preview.rootKey, preview.path, 'file')}>File</button>
          <button aria-pressed={preview.mode === 'diff'} onClick={() => void openPreview(preview.rootKey, preview.path, 'diff')}>Diff</button></div>}
        {preview.mode === 'file' && preview.data?.kind === 'text' && <>
          <button disabled={!liveSession} title={liveSession ? 'Type the reference into the running agent\'s input' : 'Select a running session of this project'} onClick={() => void referenceInSession(describeTarget(preview.rootKey, preview.path, range ? 'lines' : 'file', range))}>{range ? `Reference lines ${range.startLine}–${range.endLine}` : 'Reference in session'}</button>
          <button onClick={() => void addToTask(describeTarget(preview.rootKey, preview.path, range ? 'lines' : 'file', range))}>Add to next task</button>
          {canEvidence && <button onClick={() => onSaveEvidence({ rootKey: preview.rootKey, path: preview.path, startLine: range!.startLine, endLine: range!.endLine })}>Save as a note…</button>}
        </>}
        <button onClick={() => act(() => api('openInEditor', { projectId: project.id, rootKey: preview.rootKey, path: preview.path, line: range?.startLine }))}>Open in editor</button>
      </div>
      {preview.error ? <p className="preview-message">{preview.error}</p>
        : preview.mode === 'diff' ? !preview.diff ? <p className="preview-message muted">Loading diff…</p>
          : preview.diff.hidden ? <p className="preview-message">This file can contain credentials, so its diff is not shown.</p>
          : !preview.diff.text ? <p className="preview-message muted">No differences from HEAD.</p>
          : <Suspense fallback={<p className="preview-message muted">Loading viewer…</p>}>{preview.diff.truncated && <p className="hint">Showing the first 200 KB of the diff.</p>}<FilePreview text={preview.diff.text} path={preview.path} highlight diff onSelection={() => {}} /></Suspense>
        : !preview.data ? <p className="preview-message muted">Loading…</p>
        : preview.data.kind === 'sensitive' ? <p className="preview-message">This file can contain credentials, so Journal does not read or show it. Use {revealLabel} to open it yourself.</p>
        : preview.data.kind === 'too-large' ? <p className="preview-message">This file is {formatSize(preview.data.size ?? 0)}, over the 5 MB preview limit. Open it in your editor instead.</p>
        : preview.data.kind === 'binary' ? <p className="preview-message">Binary file ({formatSize(preview.data.size ?? 0)}). It cannot be previewed as text.</p>
        : <Suspense fallback={<p className="preview-message muted">Loading viewer…</p>}>
          <p className="preview-meta muted">{formatSize(preview.data.size ?? 0)} · {preview.data.lineCount} line{preview.data.lineCount === 1 ? '' : 's'}{preview.data.eol && preview.data.eol !== 'lf' && preview.data.eol !== 'none' ? ` · ${preview.data.eol.toUpperCase()}` : ''}{!preview.data.highlight ? ' · plain text (over 1 MB)' : ''} · read-only · select lines or click line numbers to reference them</p>
          {preview.data.invalidUtf8 && <p className="hint">This file is not valid UTF-8; invalid bytes are shown as replacement characters.</p>}
          <FilePreview text={preview.data.text ?? ''} path={preview.path} highlight={!!preview.data.highlight} initialLine={preview.line} onSelection={setRange} />
        </Suspense>}
    </section>

    : filter === 'changed' ? <ul className="changed-list" aria-label="Changed files">
      {!changedRows.length && <li className="muted">{visible.some(root => root.git) ? 'No changes against HEAD.' : 'No Git repository in these roots.'}</li>}
      {changedRows.slice(0, 500).map(({ root, entry }) => {
        const name = entry.path.split('/').pop() || root.label; const dir = entry.path.split('/').slice(0, -1).join('/');
        const item: Item = { id: idOf(root.key, entry.path), rootKey: root.key, path: entry.path, name, type: entry.directory ? 'directory' : 'file', sensitive: !!entry.sensitive };
        return <li key={item.id}><button className="changed-row" draggable={!entry.directory && entry.kind !== 'deleted'} onDragStart={event => { if (entry.directory || entry.kind === 'deleted') { event.preventDefault(); return; } dragFile(event, root.key, entry.path); }} disabled={(entry.directory && entry.kind !== 'untracked') || !!entry.submodule} onClick={() => { if (entry.directory) { setFilter('all'); return; } void openPreview(root.key, entry.path, entry.kind === 'deleted' ? 'diff' : 'file'); }}
          onContextMenu={event => { event.preventDefault(); void itemMenu(item, menuPosition(event)); }} title={`${DESCRIBE[entry.kind]}${entry.from ? ` from ${entry.from}` : ''}${entry.staged ? ' · staged' : ''}${entry.unstaged ? ' · unstaged' : ''}`}>
          <span className={`tree-name git-${entry.kind}`}>{name}{entry.directory ? '/' : ''}</span><span className="tree-dir">{visible.length > 1 ? `${root.label}${dir ? ' / ' : ''}` : ''}{dir}</span>
          <span className={`git-letter git-${entry.kind}`} aria-label={DESCRIBE[entry.kind]}>{LETTER[entry.kind]}</span></button></li>;
      })}
      {changedRows.length > 500 && <li className="muted">{changedRows.length - 500} more changed files not shown.</li>}
      {Object.values(statuses).some(status => status.truncated) && <li className="muted">Git reported more than 5000 entries; the list is incomplete.</li>}
    </ul>

    : <div className="file-tree" ref={scroller} onScroll={event => setTop(event.currentTarget.scrollTop)}>
      {tree.isSearchOpen() && <input {...tree.getSearchInputElementProps()} className="tree-search" onKeyDown={event => { if (event.key === 'Escape') event.preventDefault(); /* the tree closes its search; the overlay stays */ }} aria-label="Find in loaded files" placeholder="Find in open folders" />}
      <div {...tree.getContainerProps('Files')} className="tree-rows" style={{ height: rows.length * ROW }}>
        {rows.slice(first, last).map(item => {
          const data = item.getItemData(); const meta = item.getItemMeta(); const state = stateOf(data); const dot = folderKind(data);
          const kind = state?.kind ?? null; const folder = item.isFolder();
          const label = `${data.name}${data.sensitive ? ', may contain credentials' : ''}${data.type === 'symlink' ? ', link (not followed)' : ''}${kind ? `, ${DESCRIBE[kind]}` : ''}${dot && dot !== 'ignored' ? ', contains changes' : ''}`;
          return <div {...item.getProps()} key={item.getId()} aria-label={label} aria-selected={item.getId() === selectedId}
            className={`tree-row${item.isFocused() ? ' focused' : ''}${item.getId() === selectedId ? ' selected' : ''}${data.type === 'root' ? ' tree-root' : ''}${data.type === 'more' ? ' tree-more' : ''}`}
            style={{ top: meta.index * ROW, paddingLeft: 6 + meta.level * 12 }}
            // Files and folders can be dragged onto a session's terminal as a reference (never sensitive ones).
            draggable={(data.type === 'file' || data.type === 'directory') && !data.sensitive}
            onDragStart={event => { if ((data.type !== 'file' && data.type !== 'directory') || data.sensitive) { event.preventDefault(); return; } dragFile(event, data.rootKey, data.path); }}
            onContextMenu={event => { event.preventDefault(); item.setFocused(); void itemMenu(data, menuPosition(event)); }}
            onClick={event => { item.getProps().onClick?.(event); if (data.type === 'file' && !data.sensitive) void openPreview(data.rootKey, data.path); }}>
            <span className="tree-twisty" aria-hidden="true">{folder && <svg viewBox="0 0 24 24" focusable="false"><path d={item.isExpanded() ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} /></svg>}</span>
            {data.type !== 'root' && data.type !== 'more' && <span className={`tree-icon${folder ? ' folder' : ''}`} aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">{folder
              ? <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
              : <path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v4h4" />}</svg></span>}
            <span className={`tree-name${kind ? ` git-${kind}` : ''}${data.sensitive ? ' sensitive' : ''}`}>{data.name}</span>
            {data.type === 'root' && <span className="tree-dir">{rootFor(data.rootKey)?.branch ? `⑂ ${rootFor(data.rootKey)!.branch}` : rootFor(data.rootKey)?.family === 'folder' ? 'folder' : ''}</span>}
            {data.sensitive && <span className="tree-badge" aria-hidden="true" title="May contain credentials: not previewed"><svg viewBox="0 0 24 24" width="11" height="11" focusable="false"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg></span>}
            {data.type === 'symlink' && <span className="tree-badge" aria-hidden="true" title="Link: not followed">↪</span>}
            {kind && kind !== 'ignored' ? <span className={`git-letter git-${kind}`} aria-hidden="true">{LETTER[kind]}</span>
              : dot && dot !== 'ignored' ? <span className={`git-dot git-${dot}`} aria-hidden="true">●</span> : null}
          </div>;
        })}
      </div>
    </div>}
  </div>;
}

const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
