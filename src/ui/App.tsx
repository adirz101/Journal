import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TerminalPane } from './TerminalPane';
import { KnowledgeForm } from './KnowledgeForm';
import { KnowledgePanel } from './KnowledgePanel';
import { ResizableWorkspace } from './ResizableWorkspace';
import { useShellLayout } from './useShellLayout';
import { useProposals } from './useProposals';
import { Sidebar } from './Sidebar';
import { nextNeedsYou, resumable, slotOrder, slotTarget, stateFor } from './sessionState';
import { ChangesPanel } from './ChangesPanel';
import { WorkspaceDialog } from './WorkspaceDialog';
import { ContextPanel } from './ContextPanel';
import { ExplorerPanel } from './ExplorerPanel';
import { CursorStatus } from './ProviderStatus';
import { ProcessDialog } from './ProcessDialog';
import { UpdateNotice, useUpdateState } from './UpdateNotice';
import { SettingsDialog } from './SettingsDialog';
import { ManageProjectDialog } from './ManageProjectDialog';
import { RenameDialog } from './RenameDialog';
import { Inspector } from './Inspector';
import { SessionTab } from './SessionTab';
import { FilesTab } from './FilesTab';
import { MemoryTab } from './MemoryTab';
import { NewSessionView } from './NewSessionView';
import { AttentionBanner, SessionHeader } from './SessionHeader';
import { StatusBar } from './StatusBar';
import { useSessionChanges, useSessionEvents } from './useSessionData';
import { diffSummary } from './sessionView';
import { showMenu } from './menu';
import { ProviderMark } from './ProviderMark';
import journalMarkWhite from '../../assets/branding/journal-mark-white.png';
import journalMarkDark from '../../assets/branding/journal-mark.png';
import journalWordmark from '../../assets/branding/journal-wordmark.png';
import { storedAppearance, type Appearance } from './theme';
import { copy, shell, tip } from './copy';
import { keyLetter } from './keys';
import { api, errorCode, isLive, PROVIDER_NAMES, type Bootstrap, type CommandId, type FileReference, type InspectorTab, type Memory, type Project, type ProjectState, type Provider, type Receipt, type Session, type StatusDraft, type TimelineEvent, type WorkspaceList } from './types';

const MAX_SESSIONS = 4;
const latest = (a: string | null | undefined, b: string | null | undefined) => !a ? b : !b ? a : a > b ? a : b;

export default function App() {
  const [appearance, setAppearance] = useState<Appearance>(storedAppearance);
  const journalMark = appearance === 'light' ? journalMarkDark : journalMarkWhite;
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = appearance;
    try { localStorage.setItem('journal-theme', appearance); } catch { /* Keep the toggle usable if storage is unavailable. */ }
  }, [appearance]);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null); const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<ProjectState | null>(null);
  const [sessions, setSessions] = useState<Record<string, Session>>({}); const [selectedId, setSelectedId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null); const [task, setTask] = useState('');
  const [panel, setPanel] = useState<InspectorTab>('memory');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [form, setForm] = useState<{ memory?: Memory; supersedes?: Memory; initialCategory?: string; draft?: StatusDraft } | null>(null);
  const [knowledgeVersion, setKnowledgeVersion] = useState(0);
  // Phase 5: note trust lines refetch on note changes and when a session starts running (a new delivery).
  const [runVersion, setRunVersion] = useState(0); const statuses = useRef(new Map<string, string>());
  const trustVersion = knowledgeVersion + runVersion;
  const [runtime, setRuntime] = useState<{ state: string; warning?: string | null }>({ state: 'connecting' });
  const [liveEvents, setLiveEvents] = useState<TimelineEvent[]>([]);
  // File and command-end events per session, counted as they arrive: liveEvents is capped, so its length stops changing.
  const [fileEventCounts, setFileEventCounts] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const [workspaces, setWorkspaces] = useState<WorkspaceList | null>(null); const [workspaceId, setWorkspaceId] = useState<string>(''); const [research, setResearch] = useState(false); const [plan, setPlan] = useState(false);
  const [processView, setProcessView] = useState<{ id: string; title: string; command?: string; kind: 'install' | 'login' } | null>(null); const [providerNote, setProviderNote] = useState(''); const [checkingProvider, setCheckingProvider] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState(false); const [disabled, setDisabled] = useState<string[]>([]); const [settingsOpen, setSettingsOpen] = useState(false); const [manageId, setManageId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ kind: 'project'; project: Project } | { kind: 'session'; session: Session } | null>(null);
  // Right panel: collapsible, wider while previewing a file; references chosen for the next task.
  const update = useUpdateState();
  const [previewing, setPreviewing] = useState(false); const [explorerFocus, setExplorerFocus] = useState(0);
  // The Files tab's view: the user's last choice for this app run, else Changed while the session changed something.
  const [filesChoice, setFilesChoice] = useState<'changed' | 'all' | null>(null); const [packetRequest, setPacketRequest] = useState<number | null>(null);
  const [references, setReferences] = useState<FileReference[]>([]); const [evidenceSource, setEvidenceSource] = useState<{ kind: 'file'; path: string; startLine: number; endLine: number; rootId?: string } | null>(null);
  // References belong to the project they were chosen in; switching projects drops them.
  useEffect(() => { setReferences([]); setEvidenceSource(null); }, [state?.project.id]);
  const referenceInputs = references.map(ref => ({ projectId: ref.projectId, rootKey: ref.rootKey, path: ref.path, startLine: ref.startLine, endLine: ref.endLine }));
  const [resumeDraft, setResumeDraft] = useState<{ sessionId: string; value: string } | null>(null);
  const session = selectedId ? sessions[selectedId] ?? null : null;
  // A confirmation draft belongs to one launch, never to another conversation.
  const resumeValue = resumeDraft?.sessionId === session?.id ? resumeDraft?.value ?? '' : session?.nativeId ?? '';
  const taskRef = useRef<HTMLTextAreaElement>(null); const removedIds = useRef(new Set<string>()); const projectRef = useRef<Project | null>(null);
  // Set once the user picks a project or session: the startup selection, which
  // waits for project data, must not override a choice made meanwhile.
  const userChose = useRef(false);
  // The newest providers event: one that arrives before bootstrap resolves is applied then.
  const latestAgents = useRef<Bootstrap['agents'] | null>(null);
  projectRef.current = state?.project ?? null;
  const connected = runtime.state === 'connected';
  // Wide, medium or narrow window: which side panes dock, fold to rails or open as overlays.
  const layout = useShellLayout(!!state);
  const failed = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  // Open suggestions, fetched once for the window: the `proposals` event and memory changes bump knowledgeVersion.
  const proposals = useProposals(state?.project.id ?? null, knowledgeVersion, failed);
  // Older snapshots (for example a slow store read) never replace newer runtime state,
  // and a snapshot read before a removal never brings the removed session back.
  const merge = useCallback((items: Session[]) => setSessions(current => {
    const next = { ...current };
    for (const item of items) {
      if (item.removed || removedIds.current.has(item.id)) continue; const known = next[item.id];
      // Output time only moves forward: an activity event can be newer than a stored snapshot of the same version.
      if (!known || (item.version ?? 0) >= (known.version ?? 0)) next[item.id] = { ...known, ...item, lastOutputAt: latest(known?.lastOutputAt, item.lastOutputAt) };
    }
    return next;
  }), []);
  // Activity events (Codex, Cursor) patch the output time without a version: status events stay the authority.
  const noteActivity = useCallback((sessionId: string, lastOutputAt: string) => setSessions(current => {
    const known = current[sessionId]; const next = latest(known?.lastOutputAt, lastOutputAt);
    return !known || next === known.lastOutputAt ? current : { ...current, [sessionId]: { ...known, lastOutputAt: next } };
  }), []);
  useEffect(() => { void api('setAppearance', { appearance }).catch(failed); }, [appearance, failed]);
  // Relative times only; no animation. While a live Codex or Cursor session is
  // listed, tick every 5 s so "output just now" ends within 5 s of its 10 s threshold.
  const outputClock = Object.values(sessions).some(s => !s.removed && isLive(s) && s.provider !== 'claude');
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), outputClock ? 5000 : 15000); return () => clearInterval(timer); }, [outputClock]);
  const refresh = useCallback(async (id?: string) => {
    const projectId = id ?? projectRef.current?.id; if (!projectId) return;
    const next = await api<ProjectState>('project', { projectId }); setState(next); merge(next.sessions);
    const list = await api<WorkspaceList>('workspaces', { projectId }).catch(() => null); setWorkspaces(list);
    setWorkspaceId(current => list?.workspaces.some(w => w.id === current && w.state === 'ready') || next.project.roots?.some(root => `root:${root.id}` === current) ? current : '');
    return next;
  }, [merge]);
  // Branch switches happen outside Journal (terminal, editor, the agent itself):
  // poll the checkout while visible and on focus, and refresh when it moved.
  useEffect(() => {
    let busy = false;
    const check = async () => {
      const current = projectRef.current; if (!current || busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const checkout = await api<{ branch: string | null; head: string | null }>('checkout', { projectId: current.id });
        if (projectRef.current?.id === current.id && (checkout.branch !== current.branch || checkout.head !== current.head)) { await refresh(current.id); setKnowledgeVersion(v => v + 1); }
      } catch { /* the next tick retries; project errors surface on explicit actions */ } finally { busy = false; }
    };
    const timer = setInterval(() => void check(), 3000);
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [refresh]);
  const reloadProjects = useCallback(async () => setProjects(await api<Project[]>('projects')), []);
  const reloadSessions = useCallback(async () => {
    const result = await api<{ live: Session[]; active: Session[] }>('sessions'); merge([...result.active, ...result.live]);
  }, [merge]);
  useEffect(() => {
    void api<Bootstrap>('bootstrap').then(async data => {
      setBootstrap(latestAgents.current ? { ...data, agents: latestAgents.current } : data); setProjects(data.projects); setRuntime(data.runtime); merge([...data.active, ...data.live]);
      const remembered = (() => { try { return localStorage.getItem('journal-project'); } catch { return null; } })();
      const firstLive = slotOrder([...data.active, ...data.live]).find(isLive);
      const selected = data.projects.find(p => p.id === (firstLive?.projectId ?? remembered));
      if (selected && !userChose.current) {
        const next = await refresh(selected.id); if (userChose.current) return;
        const live = data.live.find(s => isLive(s) && s.projectId === selected.id);
        if (live) { setSelectedId(live.id); setReceipt(await api<Receipt>('getReceipt', { id: live.receiptId })); }
        else if (next?.receipts[0]) setReceipt(next.receipts[0]);
      }
    }).catch(failed);
    return window.journal?.onEvent(event => {
      if (event.type === 'error') { setError(event.message); return; }
      if (event.type === 'runtime') {
        setRuntime({ state: event.state, warning: event.warning });
        if (event.state === 'connected') void reloadSessions().then(() => refresh()).catch(failed);
        return;
      }
      if (event.type === 'timeline') {
        setLiveEvents(current => [...current.slice(-1999), event.event]);
        const { sessionId, kind } = event.event;
        if (sessionId && (kind === 'file' || kind === 'command-end')) setFileEventCounts(current => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }));
        return;
      }
      if (event.type === 'proposals') { setKnowledgeVersion(v => v + 1); return; }
      if (event.type === 'providers') {
        latestAgents.current = event.agents; setBootstrap(current => current ? { ...current, agents: event.agents } : current);
        // After an install or sign-in exits, main checks that provider again and tags the result.
        const cursor = event.agents.find(a => a.provider === 'cursor');
        if (event.after?.provider === 'cursor' && cursor) setProviderNote(cursorNote(event.after.kind, cursor));
        return;
      }
      if (event.type === 'activity') { noteActivity(event.sessionId, event.lastOutputAt); return; }
      if (event.type !== 'status') return;
      // Main strips user-owned fields (names, pins, archive, removal) from runtime sessions.
      const before = statuses.current.get(event.session.id); statuses.current.set(event.session.id, event.session.status);
      if (event.session.status === 'running' && before !== 'running') setRunVersion(v => v + 1);
      merge([event.session]);
    });
  }, [refresh, reloadSessions, merge, noteActivity, failed]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (error) { failed(error); } finally { setBusy(false); } }
  // Only a real project change resets the selection and the task; a stopping session is not picked.
  async function chooseProject(project: Project) {
    userChose.current = true;
    if (project.id === state?.project.id) return;
    await run(async () => { const next = await refresh(project.id); try { localStorage.setItem('journal-project', project.id); } catch { /* optional */ }
      const live = slotOrder(Object.values(sessions)).find(s => isLive(s) && s.status !== 'stopping' && s.projectId === project.id);
      setSelectedId(live?.id ?? null); setReceipt(next?.receipts[0] ?? null); setTask(''); });
  }
  async function openProject() {
    userChose.current = true;
    await run(async () => { const project = await api<Project | null>('openProject'); if (!project) return; setProjects(items => [project, ...items.filter(p => p.id !== project.id)]); await refresh(project.id); try { localStorage.setItem('journal-project', project.id); } catch { /* optional */ } setSelectedId(null); setReceipt(null); });
  }
  const ordered = useMemo(() => Object.values(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [sessions]);
  const liveCount = ordered.filter(isLive).length;
  const canStart = connected && liveCount < MAX_SESSIONS;
  async function selectSession(next: Session) {
    userChose.current = true;
    await run(async () => {
      if (next.projectId !== state?.project.id) await refresh(next.projectId);
      setSelectedId(next.id); setReceipt(await api<Receipt>('getReceipt', { id: next.receiptId }));
    });
  }
  // The task box takes focus once the New session view has rendered (an effect, not a frame callback, which can run before the commit).
  const [taskFocus, setTaskFocus] = useState(0);
  useEffect(() => { if (taskFocus) taskRef.current?.focus(); }, [taskFocus]);
  function newSession() { userChose.current = true; setSelectedId(null); setTaskFocus(n => n + 1); }
  // === Region: command handler (Phase 3: A adds settings, B the tab commands, C the layout toggles) ===
  // App shortcuts arrive as commands from the main process (src/desktop/shortcuts.mjs),
  // so they also work while the terminal has focus. The ref keeps the handler current.
  const command = useRef<(id: CommandId) => void>(() => {});
  command.current = id => {
    // An open dialog owns the keyboard. Main stops claiming keys once it hears
    // about the dialog (setModalOpen); this covers a key pressed before that.
    if (document.querySelector('dialog[open]')) return;
    // Commands do only what the matching buttons allow at the moment.
    // Slot shortcuts follow the runtime's stable slots. They and next-needs-you
    // are ignored while busy (clicks are not) so two switches never overlap.
    const slot = /^slot-([1-4])$/.exec(id);
    if (slot) { const target = slotTarget(ordered, Number(slot[1])); if (!busy && target && target.id !== selectedId) void selectSession(target); return; }
    if (id === 'next-needs-you') { const target = nextNeedsYou(ordered, selectedId); if (!busy && target) void selectSession(target); return; }
    if (id === 'new-session') { if (state) newSession(); return; }
    if (id === 'open-project') { if (!busy) void openProject(); return; }
    if (id === 'settings') { setSettingsOpen(true); return; }
    if (id === 'toggle-sidebar') { layout.toggleSidebar(); return; }
    if (!projectRef.current) return;
    if (id === 'add-note') setForm({});
    else if (id === 'toggle-inspector') layout.toggleInspector();
    else if (id === 'focus-terminal') { if (session) window.dispatchEvent(new CustomEvent('journal:focus-terminal', { detail: session.id })); }
    else if (id === 'tab-session') { setPanel('session'); layout.showInspector(); }
    else if (id === 'tab-files') { setPanel('files'); layout.showInspector(); setExplorerFocus(n => n + 1); }
    else if (id === 'tab-memory') { setPanel('memory'); layout.showInspector(); }
  };
  // === End region: command handler ===
  // A notification click (main sends focus-session) selects its session like a click, busy or not,
  // except while a dialog is open: like commands, it must not switch the session behind it.
  const focusSession = useRef<(id: string) => void>(() => {});
  focusSession.current = id => { if (document.querySelector('dialog[open]')) return; const target = sessions[id]; if (target) void selectSession(target); };
  useEffect(() => window.journal?.onEvent(event => {
    if (event.type === 'command') command.current(event.id);
    else if (event.type === 'focus-session') focusSession.current(event.sessionId);
  }), []);
  // Windows and Linux: Ctrl+O is not routed, because the CLI owns it while the
  // terminal has focus (xterm stops the event there). Elsewhere it opens a project.
  useEffect(() => {
    if (!bootstrap || bootstrap.platform === 'darwin') return;
    const open = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || keyLetter(event.key, event.code) !== 'o') return;
      event.preventDefault(); command.current('open-project');
    };
    window.addEventListener('keydown', open); return () => window.removeEventListener('keydown', open);
  }, [bootstrap]);
  async function start(provider: Provider, resumeFrom?: Session) {
    const projectId = resumeFrom?.projectId ?? state?.project.id; if (!projectId) return;
    // Take the task now so text typed while this start finishes is never cleared.
    const submitted = resumeFrom ? '' : task; if (!resumeFrom) setTask('');
    await run(async () => {
      try {
        const result = await api<{ session: Session; receipt: Receipt }>('start', { projectId, provider, task: submitted, resumeId: resumeFrom?.id, ...(resumeFrom ? {} : { workspaceId: workspaceId || null, research, plan: plan && !research, disabled, references: referenceInputs }) });
        merge([result.session]); setSelectedId(result.session.id); setReceipt(result.receipt); setDisabled([]); if (!resumeFrom) setReferences([]); setPanel('session'); await refresh(projectId);
      } catch (error) {
        if (submitted) setTask(current => current || submitted);
        // Another window or a stale count: all four slots are taken. Catch up and say so plainly.
        if (errorCode(error) === 'SLOTS_FULL') { void reloadSessions().catch(() => {}); throw new Error(copy.slotsFull(MAX_SESSIONS)); }
        throw error;
      }
    });
  }
  const sessionAction = (action: string, extra: object = {}) => session && run(async () => { await api(action, { id: session.id, ...extra }); });
  // Session actions shared by the right-click menu and the session header.
  const sessionActions = {
    rename: (target: Session) => setRenameTarget({ kind: 'session', session: target }),
    pin: (target: Session) => run(async () => { merge([await api<Session>('setSessionPinned', { id: target.id, pinned: !target.pinned })]); }),
    archive: (target: Session) => run(async () => { merge([await api<Session>('archiveSession', { id: target.id })]); }),
    unarchive: (target: Session) => run(async () => { merge([await api<Session>('unarchiveSession', { id: target.id })]); }),
    remove: (target: Session) => run(async () => {
      const result = await api<Session | null>('removeSession', { id: target.id }); if (!result) return;
      if (result.removed) { removedIds.current.add(target.id); setSessions(current => { const next = { ...current }; delete next[target.id]; return next; }); setSelectedId(current => current === target.id ? null : current); await refresh(); }
      else merge([result]);
    }),
    resume: (target: Session) => start(target.provider, target),
    interrupt: (target: Session) => run(async () => { await api('interrupt', { id: target.id }); }),
    stop: (target: Session) => run(async () => { await api('stop', { id: target.id }); }),
    endOrphan: (target: Session) => run(async () => { await api('terminateOrphan', { id: target.id }); }),
    reveal: (target: Session) => run(async () => { await api('revealSession', { id: target.id }); }),
    copyPath: (target: Session) => run(async () => { await api('copySessionPath', { id: target.id }); }),
    copyNativeId: (target: Session) => run(async () => { await api('copySessionNativeId', { id: target.id }); }),
  };
  const revealLabel = bootstrap?.platform === 'darwin' ? 'Finder' : bootstrap?.platform === 'win32' ? 'File Explorer' : 'file manager';
  async function sessionMenu(target: Session, position?: { x: number; y: number }) {
    const live = isLive(target); const orphan = target.status === 'orphaned';
    const choice = await showMenu([
      { id: 'open', label: 'Open' }, { id: 'rename', label: 'Rename…' },
      { id: 'pin', label: target.pinned ? 'Unpin' : 'Pin' }, { id: target.archived ? 'unarchive' : 'archive', label: target.archived ? 'Unarchive' : 'Archive' },
      { separator: true },
      resumable(target) && { id: 'resume', label: copy.continue, enabled: canStart && !busy },
      live && { id: 'interrupt', label: 'Interrupt (Ctrl+C)', enabled: connected }, live && { id: 'stop', label: 'Stop', enabled: connected && target.status !== 'stopping' },
      orphan && target.identityVerified !== false && { id: 'endOrphan', label: 'End orphaned process' },
      { separator: true },
      { id: 'reveal', label: `Reveal Workspace in ${revealLabel}`, enabled: !!target.cwd }, { id: 'copyPath', label: 'Copy Workspace Path', enabled: !!target.cwd },
      { id: 'copyNativeId', label: target.nativeId && !target.nativeIdConfirmed ? 'Copy Native Session ID (unconfirmed)' : 'Copy Native Session ID', enabled: !!target.nativeId && target.nativeIdConfirmed },
      { separator: true }, { id: 'remove', label: 'Remove from Journal…' },
    ], position);
    if (choice === 'open') await selectSession(target);
    else if (choice && choice in sessionActions) await sessionActions[choice as keyof typeof sessionActions](target);
  }
  // === Region A: project menus ===
  // The switcher lists every project, then the current project's actions; right-click on it opens those actions alone.
  const removedProject = (id: string) => { setProjects(items => items.filter(p => p.id !== id)); if (state?.project.id === id) { setState(null); setSelectedId(null); setReceipt(null); } void reloadProjects().catch(failed); };
  const projectItems = (target: Project) => [
    { id: 'open-project', label: 'Open project…' }, { id: 'manage', label: 'Manage project…' }, { id: 'rename', label: 'Rename…' }, { id: 'pin', label: target.pinned ? 'Unpin' : 'Pin' }, { id: 'addFolder', label: 'Add folder…' },
    { separator: true as const }, { id: 'reveal', label: `Reveal in ${revealLabel}` }, { id: 'copyPath', label: 'Copy path' },
    { separator: true as const }, { id: 'remove', label: 'Remove from Journal…' },
  ];
  async function projectAction(choice: string | null, target: Project) {
    if (choice === 'open-project') await openProject();
    else if (choice === 'rename') setRenameTarget({ kind: 'project', project: target });
    else if (choice === 'pin') await run(async () => { await api('setProjectPinned', { id: target.id, pinned: !target.pinned }); await reloadProjects(); });
    else if (choice === 'manage') setManageId(target.id);
    else if (choice === 'addFolder') await run(async () => { await api('addProjectFolder', { id: target.id }); await reloadProjects(); if (state?.project.id === target.id) await refresh(); });
    else if (choice === 'reveal') await run(async () => { await api('revealProject', { id: target.id }); });
    else if (choice === 'copyPath') await run(async () => { await api('copyProjectPath', { id: target.id }); });
    else if (choice === 'remove') await run(async () => { if (await api('removeProject', { id: target.id })) removedProject(target.id); });
  }
  async function projectMenu(position?: { x: number; y: number }) {
    const target = state?.project; if (!target) return;
    await projectAction(await showMenu(projectItems(target), position), target);
  }
  // With no project open it lists the known projects and Open project…; with none known it opens one directly.
  async function switcherMenu(position?: { x: number; y: number }) {
    const current = state?.project ?? null; if (!current && !projects.length) { await openProject(); return; }
    // Menu item IDs are short (main allows 40 characters and 40 items), so projects are listed by position in this snapshot.
    // Past 28 projects a disabled line says how many are left out and how to reach them (there is no all-projects list).
    const listed = projects.slice(0, 28); const hidden = projects.length - listed.length;
    const choice = await showMenu([...listed.map((p, index) => ({ id: `project:${index}`, label: `${p.name}${p.pinned ? ' · Pinned' : ''}${p.id === current?.id ? ' · Current' : ''}` })),
      hidden > 0 && { id: 'more-projects', label: shell.moreProjects(hidden), enabled: false }, { separator: true },
      ...(current ? projectItems(current) : [{ id: 'open-project', label: 'Open project…' }])], position);
    const picked = choice?.startsWith('project:') ? listed[Number(choice.slice('project:'.length))] ?? null : null;
    if (picked) { if (picked.id !== current?.id) await chooseProject(picked); }
    else if (current) await projectAction(choice, current);
    else if (choice === 'open-project') await openProject();
  }
  // === End region A: project menus ===
  async function proposeUpdate(scope: 'checkout' | 'branch') {
    if (!state) return;
    await run(async () => { setForm({ draft: await api<StatusDraft>('proposeStatusUpdate', { projectId: state.project.id, scope }) }); });
  }
  const available = (provider: Provider) => bootstrap?.agents.some(a => a.provider === provider && a.available && (a.state ?? 'ready') === 'ready');
  const cursorAgent = bootstrap?.agents.find(a => a.provider === 'cursor');
  function cursorNote(after: string, next: NonNullable<typeof cursorAgent>) {
    if (after === 'install') return next.available ? `Cursor CLI ${next.version} is installed${next.state === 'login-required' ? '. Sign in to continue.' : '.'}` : next.state === 'not-cursor' ? 'The installer finished, but the agent command Journal finds is not the Cursor CLI.' : 'The installer finished, but Journal cannot find the agent command yet. Check the installer output; if it asks you to update PATH, do so and restart Journal.';
    return next.auth === 'signed-in' ? 'Signed in to Cursor.' : next.auth === 'signed-out' ? 'Cursor still reports that you are not signed in.' : 'Journal could not confirm the sign-in. Try starting a Cursor session.';
  }
  async function checkCursor() {
    setCheckingProvider(true);
    try {
      const next = await api<NonNullable<typeof cursorAgent>>('providerStatus', { provider: 'cursor' });
      setBootstrap(current => current ? { ...current, agents: current.agents.map(a => a.provider === 'cursor' ? next : a) } : current);
    } catch (error) { failed(error); } finally { setCheckingProvider(false); }
  }
  async function installCursor() { if (checkingProvider) return; setProviderNote(''); setCheckingProvider(true); try { const result = await api<{ id: string; command: string } | null>('providerInstall', { provider: 'cursor' }); if (result) setProcessView({ id: result.id, command: result.command, title: 'Install Cursor CLI', kind: 'install' }); } catch (error) { failed(error); } finally { setCheckingProvider(false); } }
  async function loginCursor() { if (checkingProvider) return; setProviderNote(''); setCheckingProvider(true); try { const result = await api<{ id: string }>('providerLogin', { provider: 'cursor' }); setProcessView({ id: result.id, command: 'agent login', title: 'Sign in to Cursor', kind: 'login' }); } catch (error) { failed(error); } finally { setCheckingProvider(false); } }
  const projectBranchChanged = session && state && !session.workspaceId && session.projectId === state.project.id && isLive(session) && session.branch !== undefined && session.branch !== state.project.branch;
  // One timeline fetch and one changes source per session, shared by the header, status bar and inspector.
  const { events } = useSessionEvents(session?.id ?? null, liveEvents, `${session?.status ?? ''}:${connected}`);
  const fileEvents = session ? fileEventCounts[session.id] ?? 0 : 0;
  const sessionChanges = useSessionChanges(session, fileEvents);
  const changed = diffSummary(sessionChanges.changes)?.files ?? 0;
  const filesView = filesChoice ?? (changed ? 'changed' : 'all');
  // A preview or an older record never feeds the status bar.
  const sessionReceipt = session && receipt?.id === session.receiptId ? receipt : null;
  // A note's origin opens its session when it is loaded; otherwise the card shows no link.
  const openSession = (id: string) => { const target = sessions[id]; if (target) void selectSession(target); };
  const showSent = () => { setPanel('session'); layout.showInspector(); setPacketRequest(n => (n ?? 0) + 1); };
  // === Region B: inspector ===
  const inspector = (pane: 'full' | 'rail', overlay: boolean) => state && <Inspector pane={pane} inOverlay={overlay} overlayOpen={layout.inspector === 'overlay'} tab={panel} onTab={setPanel} badges={{ files: changed, memory: proposals.length }} shortcuts={bootstrap?.shortcuts}
      
    onHide={overlay ? () => layout.closeOverlays(true) : layout.mode === 'wide' ? layout.toggleInspector : undefined} onShow={tab => tab ? layout.showInspector() : layout.toggleInspector()}>
      {panel === 'session' && <SessionTab session={session} events={events} now={now} onShowSent={showSent} context={<ContextPanel receipt={receipt} session={session} bootstrap={bootstrap} history={state.receipts} disabled={disabled} events={events} now={now} packetRequest={packetRequest} onPacketShown={() => setPacketRequest(null)}
        project={state.project} trustVersion={trustVersion} sessions={ordered} onOpenSession={openSession}
        onToggle={id => { const next = disabled.includes(id) ? disabled.filter(x => x !== id) : [...disabled, id]; setDisabled(next); if (receipt?.state === 'prepared') void api<Receipt>('prepareContext', { projectId: state.project.id, task: receipt.query, workspaceId: workspaceId || null, disabled: next, references: referenceInputs }).then(setReceipt).catch(failed); }}
        onSelectReceipt={setReceipt} onChanged={() => setKnowledgeVersion(v => v + 1)} onError={failed} />} />}
      {panel === 'files' && <FilesTab hasSession={!!session} view={filesView} onView={setFilesChoice} changed={changed}
        changes={session && <ChangesPanel session={session} changes={sessionChanges.changes} loading={sessionChanges.loading} error={sessionChanges.error} refresh={sessionChanges.refresh} />}
        files={<ExplorerPanel key={state.project.id} project={state.project} session={session} rootsVersion={workspaces?.workspaces.map(w => `${w.id}:${w.state}`).join(',') ?? ''} revealLabel={`Reveal in ${revealLabel}`} focusSignal={explorerFocus} onFocusHandled={() => setExplorerFocus(0)} onPreviewing={setPreviewing} onError={failed}
        onAddReference={async ref => {
          const projectId = state.project.id;
          const described = await api<FileReference>('describeReference', { projectId, workspaceId: workspaceId || null, rootKey: ref.rootKey, path: ref.path, startLine: ref.startLine, endLine: ref.endLine });
          if (projectRef.current?.id !== projectId) return; // switched projects meanwhile
          setReferences(current => current.some(r => r.rootKey === described.rootKey && r.path === described.path && r.startLine === described.startLine && r.endLine === described.endLine) ? current : [...current, described].slice(-20));
        }}
        onSaveEvidence={source => setEvidenceSource({ kind: 'file', path: source.path, startLine: source.startLine, endLine: source.endLine, ...(source.rootKey.startsWith('root:') ? { rootId: source.rootKey.slice(5) } : {}) })} />} />}
      {panel === 'memory' && <MemoryTab><KnowledgePanel project={state.project} version={knowledgeVersion} trustVersion={trustVersion} sessions={ordered} onOpenSession={openSession} busy={busy} proposals={proposals} onEdit={setForm} onPropose={scope => void proposeUpdate(scope)} onChanged={() => setKnowledgeVersion(v => v + 1)} onError={failed} /></MemoryTab>}
  </Inspector>;
  // === End region B: inspector ===
  // === Region C: the ResizableWorkspace wrapper (layout modes) ===
  return <ResizableWorkspace layout={layout} wide={previewing && panel === 'files'} inspector={state ? inspector : null}
    sidebar={(pane, overlay) => <Sidebar pane={pane} inOverlay={overlay} projects={projects} project={state?.project ?? null} sessions={ordered} proposals={proposals} selectedId={selectedId} connected={connected}
      runtimeState={runtime.state === 'connected' || runtime.state === 'disconnected' ? runtime.state : 'connecting'} now={now} canCompose={!!state}
      shortcuts={bootstrap?.shortcuts} appearance={appearance} update={state && session ? null : update}
      onSelect={next => { if (overlay || layout.inspector === 'overlay') layout.closeOverlays(false); void selectSession(next); }} onSessionMenu={(next, position) => void sessionMenu(next, position)} onNew={() => { if (overlay || layout.inspector === 'overlay') layout.closeOverlays(false); newSession(); }}
      onSwitchProject={position => void switcherMenu(position).catch(failed)} onProjectMenu={position => void projectMenu(position).catch(failed)}
      onOpenMemory={() => { setPanel('memory'); layout.showInspector(); }} onOpenSettings={() => setSettingsOpen(true)} onError={failed}
      onExpand={layout.toggleSidebar} onShowRecent={() => { layout.openSidebar(); requestAnimationFrame(() => document.getElementById('sidebar-recent')?.scrollIntoView({ block: 'start' })); }} />}>

    {/* === Region B: main column (session view) === */}
    <main className="workspace" aria-busy={busy || undefined}>
      {runtime.state === 'disconnected' && <div className="error-banner" role="status"><span>The Journal runtime is not connected. Reconnecting… Running sessions are shown as disconnected until their state is known; nothing is resent.</span></div>}
      {runtime.warning && <div className="error-banner" role="status"><span>{runtime.warning}</span></div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {!state ? <section className="welcome"><img className="welcome-wordmark" src={journalWordmark} alt="Journal" width={280} height={84} /><span className="eyebrow">A continuous thread</span><h2>Your project, remembered.</h2><p>Work with Claude Code and Codex in their native terminals.<br />Carry the decisions and lessons into the next session.</p><button className="primary" onClick={() => void openProject()} disabled={busy} aria-keyshortcuts={bootstrap?.shortcuts['open-project']?.aria}>Open project</button><div className="welcome-steps"><span>01 <strong>Open a checkout</strong></span><span>02 <strong>Work in a terminal</strong></span><span>03 <strong>Keep what matters</strong></span></div></section>
        : !session ? <NewSessionView mark={journalMark}>
          <section className="launch-bar" aria-label="Start an agent terminal"><label htmlFor="initial-task">Initial task <span className="optional">optional · picks relevant notes</span></label><textarea ref={taskRef} id="initial-task" value={task} onChange={e => setTask(e.target.value)} maxLength={4000} rows={2} placeholder="What are you working on? Mention a module or path to include notes about it." />
            {references.length > 0 && <ul className="reference-chips" aria-label="Files referenced for the next task">{references.map((ref, index) => <li key={`${ref.rootKey}:${ref.path}:${ref.startLine}`}>
              <span title={`${ref.rootLabel ?? ''} · ${ref.path}${ref.contentHash ? ` · sha256 ${ref.contentHash.slice(0, 12)}` : ''}`}>{ref.kind === 'folder' ? '▸ ' : ''}{ref.display ?? ref.path}{ref.startLine ? `:${ref.startLine}${ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}` : ''}</span>
              <button aria-label={`Remove ${ref.path} from the next task`} onClick={() => setReferences(current => current.filter((_, i) => i !== index))}>×</button></li>)}
              <li className="muted">Paths and lines only; the agent reads the files itself.</li></ul>}
            <div className="launch-actions"><div><button className="primary" disabled={busy || !canStart || !available('claude')} onClick={() => void start('claude')}>Start Claude</button><button disabled={busy || !canStart || !available('codex') || (plan && !research)} title={plan && !research ? 'Codex has no plan mode' : undefined} onClick={() => void start('codex')}>Start Codex</button><button disabled={busy || !canStart || !available('cursor') || ((research || plan) && !cursorAgent?.supports?.mode)} onClick={() => void start('cursor')}>Start Cursor</button>{liveCount >= MAX_SESSIONS && <span className="hint inline">{copy.slotsFull(MAX_SESSIONS)}</span>}</div><button className="text-button" disabled={busy} onClick={() => void run(async () => { setReceipt(await api<Receipt>('prepareContext', { projectId: state.project.id, task, workspaceId: workspaceId || null, disabled, references: referenceInputs })); setPanel('session'); layout.showInspector(); })}>Preview context ↗</button></div>
            <div className="launch-options"><label className="inline-label">Workspace<select value={workspaceId} onChange={e => setWorkspaceId(e.target.value)} aria-label="Workspace">
              <option value="">Current checkout · {state.project.branch ?? 'detached HEAD'}</option>
              {workspaces?.workspaces.filter(w => w.state === 'ready').map(w => <option key={w.id} value={w.id!}>{w.kind === 'managed' ? copy.separateCopy : 'Existing worktree'} · {w.branch ?? 'detached'}</option>)}
              {state.project.roots?.map(root => <option key={root.id} value={`root:${root.id}`}>Folder · {root.name}</option>)}
            </select></label><button className="text-button" onClick={() => setWorkspaceDialog(true)}>Workspaces…</button>
              <label className="inline-check" title={tip.readOnly}><input type="checkbox" checked={research} onChange={e => { setResearch(e.target.checked); if (e.target.checked) setPlan(false); }} /> {copy.readOnly}</label>
              <label className="inline-check" title={tip.plan}><input type="checkbox" checked={plan} onChange={e => { setPlan(e.target.checked); if (e.target.checked) setResearch(false); }} /> {copy.plan}</label></div>
            <p className="provider-line">{bootstrap?.agents.map(a => <span key={a.provider} title={a.available ? `${a.path ?? ''}\nResume: ${a.capabilities?.exactResume}\nObserved: status ${a.capabilities?.status.join(', ')}; commands ${a.capabilities?.commands}${a.capabilities?.modes ? `\nModes: ${a.capabilities.modes}` : ''}` : 'Not found on PATH'}><ProviderMark provider={a.provider} size={16} />{PROVIDER_NAMES[a.provider]} {a.available ? `${a.version ?? ''}${a.state === 'login-required' ? ' · login required' : ''}` : a.state === 'unsupported' ? '· unsupported version' : a.state === 'not-cursor' ? '· not the Cursor CLI' : '· not found'}</span>)}</p>
            <CursorStatus agent={cursorAgent} checking={checkingProvider} note={providerNote} onInstall={() => void installCursor()} onLogin={() => void loginCursor()} onCheck={() => void checkCursor()} />
            {bootstrap?.agents.some(a => !a.available && a.provider !== 'cursor') && <p className="hint">{bootstrap.agents.filter(a => !a.available && a.provider !== 'cursor').map(a => PROVIDER_NAMES[a.provider]).join(', ')} not found on PATH. Install the native CLI, then reopen Journal.</p>}
          </section>
        </NewSessionView>
        : <section className="session-view" aria-label="Session">
          <SessionHeader session={session} state={stateFor(session, now, connected)} connected={connected} busy={busy} canStart={canStart} now={now} mac={bootstrap?.platform === 'darwin'}
            projectBranch={session.projectId === state.project.id ? state.project.branch : session.branch ?? null} agentVersion={bootstrap?.agents.find(a => a.provider === session.provider)?.version ?? null}
            onInterrupt={() => void sessionAction('interrupt')} onStop={() => void sessionAction('stop')} onContinue={() => void start(session.provider, session)}
            onArchiveToggle={() => void (session.archived ? sessionActions.unarchive(session) : sessionActions.archive(session))}
            onEndOrphan={() => void sessionAction('terminateOrphan')} onEndSurvivors={() => void sessionAction('terminateSurvivors')} onMenu={position => void sessionMenu(session, position)} />
          <AttentionBanner session={session} />
          {projectBranchChanged && <p className="hint session-hint">The checkout is now on {state.project.branch ?? 'a detached HEAD'}; this session started on {session.branch ?? 'a detached HEAD'}.</p>}
          {session.status === 'orphaned' && <p className="hint session-hint">{session.identityVerified === false ? `A process with this session's PID (${(session as { pid?: number }).pid ?? 'unknown'}) is still running, but Journal cannot verify it is the original agent, so it will not signal it. Continuing stays blocked until it ends; check it outside Journal.` : 'The runtime that owned this terminal stopped while its process kept running. Journal cannot reattach to it. End it here, or leave it running; continuing this conversation stays blocked while it runs.'}</p>}
          {session.status === 'interrupted' && <p className="hint session-hint">This session's runtime stopped unexpectedly. Whether its first message reached the agent is uncertain, and nothing was resent.{resumable(session) ? ' Continue reopens the same conversation.' : ''}</p>}
          {!!session.survivors?.length && <p className="hint session-hint">Child processes outlived the agent: {session.survivors.map(s => `${s.pid} ${s.command}`).join('; ')}</p>}
          <div className="terminal-panel"><TerminalPane key={session.id} sessionId={session.id} live={isLive(session) && connected} appearance={appearance} onError={setError} /></div>
          {!isLive(session) && session.status !== 'orphaned' && !session.nativeIdConfirmed && <div className="resume-id"><label>Native session ID<input value={resumeValue} onChange={e => setResumeDraft({ sessionId: session.id, value: e.target.value })} placeholder="Exact UUID from the native CLI" /></label><button disabled={busy} onClick={() => void run(async () => { const next = await api<Session>('confirmNativeId', { id: session.id, nativeId: resumeValue }); merge([next]); })}>Confirm conversation ID</button></div>}
          <StatusBar receipt={sessionReceipt} changes={sessionChanges.changes} update={update} onShowSent={showSent} onError={failed} />
        </section>}
    </main>
    {/* === End region B: main column === */}

    {manageId && <ManageProjectDialog projectId={manageId} onClose={() => setManageId(null)} onChanged={() => { void reloadProjects().catch(failed); if (state?.project.id === manageId) void refresh().catch(failed); }}
      onRemoved={() => { const removed = manageId; setManageId(null); removedProject(removed); }} />}
    {renameTarget?.kind === 'project' && <RenameDialog title={`Rename ${renameTarget.project.name}`} label="Display name" value={renameTarget.project.displayName} fallback={renameTarget.project.folderName ?? renameTarget.project.name}
      note="Only Journal's label changes. The folder on disk keeps its name." onClose={() => setRenameTarget(null)}
      onSave={async name => { await api('renameProject', { id: renameTarget.project.id, name }); await reloadProjects(); if (state?.project.id === renameTarget.project.id) await refresh(); }} />}
    {renameTarget?.kind === 'session' && <RenameDialog title="Rename session" label="Session name" value={renameTarget.session.displayName} fallback={renameTarget.session.title}
      note="Only Journal's label changes. The native Claude, Codex or Cursor session ID and continuing the same conversation are unaffected." onClose={() => setRenameTarget(null)}
      onSave={async name => { merge([await api<Session>('renameSession', { id: renameTarget.session.id, name })]); }} />}
    {processView && <ProcessDialog id={processView.id} title={processView.title} command={processView.command} appearance={appearance} onClose={() => setProcessView(null)} onExit={() => {}} />}
    {settingsOpen && <SettingsDialog appearance={appearance} onAppearance={setAppearance} update={update} project={state?.project ?? null} onClose={() => setSettingsOpen(false)} onDataChanged={() => { setKnowledgeVersion(v => v + 1); void refresh().catch(() => {}); }} />}
    {state && workspaceDialog && <WorkspaceDialog project={state.project} onClose={() => setWorkspaceDialog(false)} onChanged={() => void refresh().catch(failed)} />}
    {state && evidenceSource && <KnowledgeForm project={state.project} initialSource={evidenceSource} onClose={() => setEvidenceSource(null)} onSaved={() => { setEvidenceSource(null); setPanel('memory'); setKnowledgeVersion(v => v + 1); }} />}
    {state && form && <KnowledgeForm project={state.project} memory={form.memory} supersedes={form.supersedes} initialCategory={form.initialCategory} draft={form.draft} onClose={() => setForm(null)} onSaved={() => { setForm(null); setPanel('memory'); setKnowledgeVersion(v => v + 1); }} />}
  </ResizableWorkspace>;
  // === End region C ===
}
