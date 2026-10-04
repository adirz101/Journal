import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TerminalPane } from './TerminalPane';
import { KnowledgeForm } from './KnowledgeForm';
import { KnowledgePanel } from './KnowledgePanel';
import { ResizableWorkspace } from './ResizableWorkspace';
import { SessionList, activeOrder, needsAttention, resumable, stateLabel } from './SessionList';
import { ChangesPanel } from './ChangesPanel';
import { ActivityPanel } from './ActivityPanel';
import { WorkspaceDialog } from './WorkspaceDialog';
import { ContextPanel } from './ContextPanel';
import { ExplorerPanel } from './ExplorerPanel';
import { CursorStatus } from './ProviderStatus';
import { ProcessDialog } from './ProcessDialog';
import { UpdateNotice, useUpdateState } from './UpdateNotice';
import { DataDialog } from './DataDialog';
import { ManageProjectDialog } from './ManageProjectDialog';
import { RenameDialog } from './RenameDialog';
import { menuPosition, showMenu } from './menu';
import { ProviderMark } from './ProviderMark';
import journalMarkWhite from '../../assets/branding/journal-mark-white.png';
import journalMarkDark from '../../assets/branding/journal-mark.png';
import journalWordmark from '../../assets/branding/journal-wordmark.png';
import { storedAppearance, type Appearance } from './theme';
import { copy, tip } from './copy';
import { keyLetter } from './keys';
import { api, isLive, PROVIDER_NAMES, type Bootstrap, type CommandId, type FileReference, type Memory, type Project, type ProjectState, type Provider, type Receipt, type Session, type StatusDraft, type TimelineEvent, type WorkspaceList } from './types';

const MAX_SESSIONS = 4;
type Panel = 'files' | 'memory' | 'context' | 'changes' | 'activity';
const storedCollapsed = () => { try { return localStorage.getItem('journal-panel-collapsed') === '1'; } catch { return false; } };

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
  const [panel, setPanel] = useState<Panel>('memory');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [form, setForm] = useState<{ memory?: Memory; supersedes?: Memory; initialCategory?: string; draft?: StatusDraft } | null>(null);
  const [knowledgeVersion, setKnowledgeVersion] = useState(0);
  const [runtime, setRuntime] = useState<{ state: string; warning?: string | null }>({ state: 'connecting' });
  const [liveEvents, setLiveEvents] = useState<TimelineEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const [workspaces, setWorkspaces] = useState<WorkspaceList | null>(null); const [workspaceId, setWorkspaceId] = useState<string>(''); const [research, setResearch] = useState(false); const [plan, setPlan] = useState(false);
  const [processView, setProcessView] = useState<{ id: string; title: string; command?: string; kind: 'install' | 'login' } | null>(null); const [providerNote, setProviderNote] = useState(''); const [checkingProvider, setCheckingProvider] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState(false); const [disabled, setDisabled] = useState<string[]>([]); const [dataDialog, setDataDialog] = useState(false); const [manageId, setManageId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ kind: 'project'; project: Project } | { kind: 'session'; session: Session } | null>(null);
  // Right panel: collapsible, wider while previewing a file; references chosen for the next task.
  const update = useUpdateState();
  const [collapsed, setCollapsed] = useState(storedCollapsed); const [previewing, setPreviewing] = useState(false); const [explorerFocus, setExplorerFocus] = useState(0);
  const [references, setReferences] = useState<FileReference[]>([]); const [evidenceSource, setEvidenceSource] = useState<{ kind: 'file'; path: string; startLine: number; endLine: number; rootId?: string } | null>(null);
  useEffect(() => { try { localStorage.setItem('journal-panel-collapsed', collapsed ? '1' : '0'); } catch { /* optional */ } }, [collapsed]);
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
  projectRef.current = state?.project ?? null;
  const connected = runtime.state === 'connected';
  const failed = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  // Older snapshots (for example a slow store read) never replace newer runtime state,
  // and a snapshot read before a removal never brings the removed session back.
  const merge = useCallback((items: Session[]) => setSessions(current => {
    const next = { ...current };
    for (const item of items) { if (item.removed || removedIds.current.has(item.id)) continue; const known = next[item.id]; if (!known || (item.version ?? 0) >= (known.version ?? 0)) next[item.id] = { ...known, ...item }; }
    return next;
  }), []);
  useEffect(() => { void api('setAppearance', { appearance }).catch(failed); }, [appearance, failed]);
  // Relative times only; no animation.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
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
      setBootstrap(data); setProjects(data.projects); setRuntime(data.runtime); merge([...data.active, ...data.live]);
      const remembered = (() => { try { return localStorage.getItem('journal-project'); } catch { return null; } })();
      const firstLive = activeOrder([...data.active, ...data.live]).find(isLive);
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
      if (event.type === 'timeline') { setLiveEvents(current => [...current.slice(-1999), event.event]); return; }
      if (event.type === 'proposals') { setKnowledgeVersion(v => v + 1); return; }
      if (event.type === 'providers') { setBootstrap(current => current ? { ...current, agents: event.agents } : current); return; }
      if (event.type !== 'status') return;
      // Main strips user-owned fields (names, pins, archive, removal) from runtime sessions.
      merge([event.session]);
    });
  }, [refresh, reloadSessions, merge, failed]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (error) { failed(error); } finally { setBusy(false); } }
  async function chooseProject(project: Project) {
    userChose.current = true;
    await run(async () => { const next = await refresh(project.id); try { localStorage.setItem('journal-project', project.id); } catch { /* optional */ }
      const live = activeOrder(Object.values(sessions)).find(s => isLive(s) && s.projectId === project.id);
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
  function newSession() { userChose.current = true; setSelectedId(null); setPanel(current => current === 'changes' || current === 'activity' ? 'memory' : current); requestAnimationFrame(() => taskRef.current?.focus()); }
  // App shortcuts arrive as commands from the main process (src/desktop/shortcuts.mjs),
  // so they also work while the terminal has focus. The ref keeps the handler current.
  const command = useRef<(id: CommandId) => void>(() => {});
  command.current = id => {
    // An open dialog owns the keyboard. Main stops claiming keys once it hears
    // about the dialog (setModalOpen); this covers a key pressed before that.
    if (document.querySelector('dialog[open]')) return;
    // Commands do only what the matching buttons allow at the moment.
    // Slots follow activeOrder (pinned first, then newest) until Phase 2 gives
    // sessions stable slots. Slot shortcuts are ignored while busy (clicks are
    // not) so two switches never overlap.
    const slot = /^slot-([1-4])$/.exec(id);
    if (slot) { const target = activeOrder(ordered)[Number(slot[1]) - 1]; if (!busy && target && target.id !== selectedId) void selectSession(target); return; }
    if (id === 'new-session') { if (state && canStart) newSession(); return; }
    if (id === 'open-project') { if (!busy) void openProject(); return; }
    if (!projectRef.current) return;
    if (id === 'add-note') setForm({});
    else if (id === 'toggle-inspector') setCollapsed(value => !value);
    else if (id === 'focus-terminal') { if (session) window.dispatchEvent(new CustomEvent('journal:focus-terminal', { detail: session.id })); }
    // Until the three-tab inspector (Phase 3): Session opens Context, Memory opens the Memory panel.
    else if (id === 'tab-session') { setCollapsed(false); setPanel('context'); }
    else if (id === 'tab-files') { setCollapsed(false); setPanel('files'); setExplorerFocus(n => n + 1); }
    else if (id === 'tab-memory') { setCollapsed(false); setPanel('memory'); }
  };
  useEffect(() => window.journal?.onEvent(event => { if (event.type === 'command') command.current(event.id); }), []);
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
        merge([result.session]); setSelectedId(result.session.id); setReceipt(result.receipt); setDisabled([]); if (!resumeFrom) setReferences([]); setPanel('context'); await refresh(projectId);
      } catch (error) { if (submitted) setTask(current => current || submitted); throw error; }
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
  // Project actions shared by the right-click menu and Manage Project.
  const removedProject = (id: string) => { setProjects(items => items.filter(p => p.id !== id)); if (state?.project.id === id) { setState(null); setSelectedId(null); setReceipt(null); } void reloadProjects().catch(failed); };
  async function projectMenu(target: Project, position?: { x: number; y: number }) {
    const choice = await showMenu([
      { id: 'open', label: 'Open' }, { id: 'rename', label: 'Rename…' }, { id: 'pin', label: target.pinned ? 'Unpin' : 'Pin' },
      { id: 'manage', label: 'Manage Project…' }, { id: 'addFolder', label: 'Add Folder…' },
      { separator: true }, { id: 'reveal', label: `Reveal in ${revealLabel}` }, { id: 'copyPath', label: 'Copy Path' },
      { separator: true }, { id: 'remove', label: 'Remove from Journal…' },
    ], position);
    if (choice === 'open') await chooseProject(target);
    else if (choice === 'rename') setRenameTarget({ kind: 'project', project: target });
    else if (choice === 'pin') await run(async () => { await api('setProjectPinned', { id: target.id, pinned: !target.pinned }); await reloadProjects(); });
    else if (choice === 'manage') setManageId(target.id);
    else if (choice === 'addFolder') await run(async () => { await api('addProjectFolder', { id: target.id }); await reloadProjects(); if (state?.project.id === target.id) await refresh(); });
    else if (choice === 'reveal') await run(async () => { await api('revealProject', { id: target.id }); });
    else if (choice === 'copyPath') await run(async () => { await api('copyProjectPath', { id: target.id }); });
    else if (choice === 'remove') await run(async () => { if (await api('removeProject', { id: target.id })) removedProject(target.id); });
  }
  async function proposeUpdate(scope: 'checkout' | 'branch') {
    if (!state) return;
    await run(async () => { setForm({ draft: await api<StatusDraft>('proposeStatusUpdate', { projectId: state.project.id, scope }) }); });
  }
  const available = (provider: Provider) => bootstrap?.agents.some(a => a.provider === provider && a.available && (a.state ?? 'ready') === 'ready');
  const cursorAgent = bootstrap?.agents.find(a => a.provider === 'cursor');
  async function checkCursor(after?: string) {
    setCheckingProvider(true);
    try {
      const next = await api<NonNullable<typeof cursorAgent>>('providerStatus', { provider: 'cursor', fresh: !!after });
      setBootstrap(current => current ? { ...current, agents: current.agents.map(a => a.provider === 'cursor' ? next : a) } : current);
      if (after === 'install') setProviderNote(next.available ? `Cursor CLI ${next.version} is installed${next.state === 'login-required' ? '. Sign in to continue.' : '.'}` : next.state === 'not-cursor' ? 'The installer finished, but the agent command Journal finds is not the Cursor CLI.' : 'The installer finished, but Journal cannot find the agent command yet. Check the installer output; if it asks you to update PATH, do so and restart Journal.');
      if (after === 'login') setProviderNote(next.auth === 'signed-in' ? 'Signed in to Cursor.' : next.auth === 'signed-out' ? 'Cursor still reports that you are not signed in.' : 'Journal could not confirm the sign-in. Try starting a Cursor session.');
    } catch (error) { failed(error); } finally { setCheckingProvider(false); }
  }
  async function installCursor() { if (checkingProvider) return; setProviderNote(''); setCheckingProvider(true); try { const result = await api<{ id: string; command: string } | null>('installCursor'); if (result) setProcessView({ id: result.id, command: result.command, title: 'Install Cursor CLI', kind: 'install' }); } catch (error) { failed(error); } finally { setCheckingProvider(false); } }
  async function loginCursor() { if (checkingProvider) return; setProviderNote(''); setCheckingProvider(true); try { const result = await api<{ id: string }>('cursorLogin'); setProcessView({ id: result.id, command: 'agent login', title: 'Sign in to Cursor', kind: 'login' }); } catch (error) { failed(error); } finally { setCheckingProvider(false); } }
  const label = session ? stateLabel(session, connected) : '';
  const projectBranchChanged = session && state && !session.workspaceId && session.projectId === state.project.id && isLive(session) && session.branch !== undefined && session.branch !== state.project.branch;

  const inspectorKeys = bootstrap?.shortcuts['toggle-inspector']?.label;
  return <ResizableWorkspace hasKnowledge={!!state} collapsed={collapsed} wide={previewing && panel === 'files'}>
    <aside className="sidebar" id="project-sidebar">
      <div className="brand"><img className="brand-icon" src={journalMark} alt="" width={32} height={32} /><div>Journal<small>PROJECT MEMORY</small></div><span className="local-tag">LOCAL</span></div>
      <button className="open-project" onClick={() => void openProject()} disabled={busy} aria-keyshortcuts={bootstrap?.shortcuts['open-project']?.aria}><span aria-hidden="true">＋</span> Open project {bootstrap?.shortcuts['open-project'] && <kbd aria-hidden="true">{bootstrap.shortcuts['open-project'].label}</kbd>}</button>
      <div className="nav-caption">PROJECTS <span>{projects.length}</span></div>
      <nav aria-label="Projects">{projects.map(project => <div key={project.id} className="project-row"><button className={`project-link ${state?.project.id === project.id ? 'selected' : ''}`} aria-current={state?.project.id === project.id ? 'true' : undefined} onClick={() => void chooseProject(project)} onContextMenu={event => { event.preventDefault(); void projectMenu(project, menuPosition(event)); }} title={project.root}><svg className="folder-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 11h18" /></svg><span className="project-name">{project.name}</span>{project.pinned && <span className="pin-mark"><span aria-hidden="true">⚲</span><span className="visually-hidden">pinned</span></span>}{ordered.some(s => s.projectId === project.id && needsAttention(s)) && <span className="attention" aria-label="needs attention">●</span>}</button><button className="project-manage" aria-label={`Manage ${project.name}`} onClick={() => setManageId(project.id)}>⋯</button></div>)}</nav>
      <SessionList sessions={ordered} projects={projects} selectedId={selectedId} currentProjectId={state?.project.id ?? null} connected={connected} now={now} onSelect={next => void selectSession(next)} onMenu={(next, position) => void sessionMenu(next, position)} onNew={newSession} newShortcut={bootstrap?.shortcuts['new-session']} canStart={!!state && canStart} />
      <div className="sidebar-footer">{!state && <UpdateNotice state={update} onError={failed} />}<button className="theme-toggle" aria-label={`Switch to ${appearance === 'dark' ? 'light' : 'dark'} mode`} onClick={() => setAppearance(value => value === 'dark' ? 'light' : 'dark')}><span aria-hidden="true">{appearance === 'dark' ? '☀' : '◐'}</span> {appearance === 'dark' ? 'Light mode' : 'Dark mode'}</button><button className="theme-toggle" onClick={() => setDataDialog(true)}><span aria-hidden="true">⛁</span> Data and backups</button><span className={`status-dot ${connected ? 'running' : 'waiting'}`} /> {connected ? 'Runtime connected' : runtime.state === 'connecting' ? 'Starting runtime…' : 'Runtime disconnected'}<small>No terminal transcripts saved</small></div>
    </aside>

    <main className="workspace">
      <header className="workspace-heading"><div><span className="eyebrow">WORKSPACE</span><h1>{state?.project.name ?? 'Welcome to Journal'}</h1></div>{state && <span className="branch-badge">⑂ {state.project.branch ?? 'detached HEAD'} <span>{state.project.head?.slice(0, 7)}</span></span>}</header>
      {runtime.state === 'disconnected' && <div className="error-banner" role="status"><span>The Journal runtime is not connected. Reconnecting… Running sessions are shown as disconnected until their state is known; nothing is resent.</span></div>}
      {runtime.warning && <div className="error-banner" role="status"><span>{runtime.warning}</span></div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {!state ? <section className="welcome"><img className="welcome-wordmark" src={journalWordmark} alt="Journal" width={280} height={84} /><span className="eyebrow">A CONTINUOUS THREAD</span><h2>Your project, remembered.</h2><p>Work with Claude Code and Codex in their native terminals.<br />Carry the decisions and lessons into the next session.</p><button className="primary" onClick={() => void openProject()} disabled={busy} aria-keyshortcuts={bootstrap?.shortcuts['open-project']?.aria}>Open project</button><div className="welcome-steps"><span>01 <strong>Open a checkout</strong></span><span>02 <strong>Work in a terminal</strong></span><span>03 <strong>Keep what matters</strong></span></div></section>
        : <>
          <section className="launch-bar" aria-label="Start an agent terminal"><label htmlFor="initial-task">Initial task <span className="optional">optional · picks relevant notes</span></label><textarea ref={taskRef} id="initial-task" value={task} onChange={e => setTask(e.target.value)} maxLength={4000} rows={2} placeholder="What are you working on? Mention a module or path to include notes about it." />
            {references.length > 0 && <ul className="reference-chips" aria-label="Files referenced for the next task">{references.map((ref, index) => <li key={`${ref.rootKey}:${ref.path}:${ref.startLine}`}>
              <span title={`${ref.rootLabel ?? ''} · ${ref.path}${ref.contentHash ? ` · sha256 ${ref.contentHash.slice(0, 12)}` : ''}`}>{ref.kind === 'folder' ? '▸ ' : ''}{ref.display ?? ref.path}{ref.startLine ? `:${ref.startLine}${ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}` : ''}</span>
              <button aria-label={`Remove ${ref.path} from the next task`} onClick={() => setReferences(current => current.filter((_, i) => i !== index))}>×</button></li>)}
              <li className="muted">Paths and lines only; the agent reads the files itself.</li></ul>}
            <div className="launch-actions"><div><button className="primary" disabled={busy || !canStart || !available('claude')} onClick={() => void start('claude')}>Start Claude</button><button disabled={busy || !canStart || !available('codex') || (plan && !research)} title={plan && !research ? 'Codex has no plan mode' : undefined} onClick={() => void start('codex')}>Start Codex</button><button disabled={busy || !canStart || !available('cursor') || ((research || plan) && !cursorAgent?.supports?.mode)} onClick={() => void start('cursor')}>Start Cursor</button>{liveCount >= MAX_SESSIONS && <span className="hint inline">{MAX_SESSIONS} sessions are running. Stop one to start another.</span>}</div><button className="text-button" disabled={busy} onClick={() => void run(async () => { setReceipt(await api<Receipt>('prepareContext', { projectId: state.project.id, task, workspaceId: workspaceId || null, disabled, references: referenceInputs })); setCollapsed(false); setPanel('context'); })}>Preview context ↗</button></div>
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
          <section className="terminal-panel"><div className="terminal-heading"><div><span className={`status-dot ${session?.status ?? ''}`} />{session && <ProviderMark provider={session.provider} size={18} />}<strong>{session ? PROVIDER_NAMES[session.provider] : 'Terminal'}</strong><span className="terminal-label">{session ? `${label}${session.branch ? ` · ${projectBranchChanged ? 'started on ' : ''}⑂ ${session.branch}` : ''}${session.workspaceId ? session.workspaceId.startsWith('root:') ? ' · folder' : ' · worktree' : ''}${session.research ? ' · read-only' : session.plan ? ' · plan' : ''}` : 'Ready to start'}</span>{session && <span className="terminal-title" title={session.displayName || session.title}>{session.displayName || session.title}</span>}</div>
            {session && <div className="terminal-actions">
              {isLive(session) && connected && <><button onClick={() => void sessionAction('interrupt')}>Interrupt <kbd>^C</kbd></button><button onClick={() => void sessionAction('stop')} disabled={session.status === 'stopping'}>{copy.stop}</button></>}
              {resumable(session) && <button title={tip.continue} disabled={busy || !canStart} onClick={() => void start(session.provider, session)}>{copy.continue}</button>}
              {session.status === 'orphaned' && session.identityVerified !== false && <button onClick={() => void sessionAction('terminateOrphan')}>End orphaned process</button>}
              {!!session.survivors?.length && <button onClick={() => void sessionAction('terminateSurvivors')}>End {session.survivors.length} leftover process{session.survivors.length === 1 ? '' : 'es'}</button>}
              <button onClick={() => void (session.archived ? sessionActions.unarchive(session) : sessionActions.archive(session))}>{session.archived ? 'Unarchive' : 'Archive'}</button>
              <button onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); void sessionMenu(session, { x: rect.left, y: rect.bottom }); }} aria-label="More session actions" aria-haspopup="menu">⋯</button>
            </div>}</div>
            {projectBranchChanged && <p className="hint session-hint">The checkout is now on {state.project.branch ?? 'a detached HEAD'}; this session started on {session.branch ?? 'a detached HEAD'}.</p>}
            {session?.status === 'orphaned' && <p className="hint session-hint">{session.identityVerified === false ? `A process with this session's PID (${(session as { pid?: number }).pid ?? 'unknown'}) is still running, but Journal cannot verify it is the original agent, so it will not signal it. Continuing stays blocked until it ends; check it outside Journal.` : 'The runtime that owned this terminal stopped while its process kept running. Journal cannot reattach to it. End it here, or leave it running; continuing this conversation stays blocked while it runs.'}</p>}
            {session?.status === 'interrupted' && <p className="hint session-hint">This session's runtime stopped unexpectedly. Whether its first message reached the agent is uncertain, and nothing was resent.{resumable(session) ? ' Continue reopens the same conversation.' : ''}</p>}
            {!!session?.survivors?.length && <p className="hint session-hint">Child processes outlived the agent: {session.survivors.map(s => `${s.pid} ${s.command}`).join('; ')}</p>}
            {session ? <TerminalPane key={session.id} sessionId={session.id} live={isLive(session) && connected} appearance={appearance} onError={setError} /> : <div className="terminal-empty"><img className="terminal-brand-mark" src={journalMark} alt="" width={50} height={50} /><h2>A familiar place to work.</h2><p>Start an agent above. Your native login, settings,<br />and tool approvals stay with the CLI.</p></div>}
            {session && !isLive(session) && session.status !== 'orphaned' && !session.nativeIdConfirmed && <div className="resume-id"><label>Native session ID<input value={resumeValue} onChange={e => setResumeDraft({ sessionId: session.id, value: e.target.value })} placeholder="Exact UUID from the native CLI" /></label><button disabled={busy} onClick={() => void run(async () => { const next = await api<Session>('confirmNativeId', { id: session.id, nativeId: resumeValue }); merge([next]); })}>Confirm conversation ID</button></div>}
            <footer className="terminal-footer"><span>{state.project.root}</span><span>Native permissions · volatile output</span><UpdateNotice compact state={update} onError={failed} /></footer>
          </section>
        </>}
    </main>

    {state && collapsed && <aside className="knowledge-panel panel-rail" id="knowledge-sidebar" aria-label="Side panel (collapsed)">
      <button className="rail-button" aria-label="Show side panel" title={`Show side panel${inspectorKeys ? ` (${inspectorKeys})` : ''}`} onClick={() => setCollapsed(false)}>‹</button>
      {(['files', 'memory', 'context', 'changes', 'activity'] as Panel[]).map(name => <button key={name} className="rail-button rail-tab" disabled={!session && (name === 'changes' || name === 'activity')} onClick={() => { setPanel(name); setCollapsed(false); }} aria-label={`Open ${name}`} title={name[0].toUpperCase() + name.slice(1)}>{name[0].toUpperCase()}</button>)}
    </aside>}
    {state && !collapsed && <aside className="knowledge-panel" id="knowledge-sidebar"><div className="panel-tabs" role="tablist" aria-label="Project information">
      <button role="tab" aria-selected={panel === 'files'} onClick={() => setPanel('files')}><span className="panel-tab-label">Files</span></button>
      <button role="tab" aria-selected={panel === 'memory'} title={tip.memoryTab} onClick={() => setPanel('memory')}><span className="panel-tab-label">{copy.memoryTab}</span></button>
      <button role="tab" aria-selected={panel === 'context'} onClick={() => setPanel('context')}><span className="panel-tab-label">Context</span></button>
      <button role="tab" aria-selected={panel === 'changes'} disabled={!session} onClick={() => setPanel('changes')}><span className="panel-tab-label">Changes</span></button>
      <button role="tab" aria-selected={panel === 'activity'} disabled={!session} onClick={() => setPanel('activity')}><span className="panel-tab-label">Activity</span></button>
      <button className="panel-collapse" aria-label="Hide side panel" title={`Hide side panel${inspectorKeys ? ` (${inspectorKeys})` : ''}`} onClick={() => setCollapsed(true)}>›</button></div>
      {panel === 'files' && <ExplorerPanel key={state.project.id} project={state.project} session={session} rootsVersion={workspaces?.workspaces.map(w => `${w.id}:${w.state}`).join(',') ?? ''} revealLabel={`Reveal in ${revealLabel}`} focusSignal={explorerFocus} onPreviewing={setPreviewing} onError={failed}
        onAddReference={async ref => {
          const projectId = state.project.id;
          const described = await api<FileReference>('describeReference', { projectId, workspaceId: workspaceId || null, rootKey: ref.rootKey, path: ref.path, startLine: ref.startLine, endLine: ref.endLine });
          if (projectRef.current?.id !== projectId) return; // switched projects meanwhile
          setReferences(current => current.some(r => r.rootKey === described.rootKey && r.path === described.path && r.startLine === described.startLine && r.endLine === described.endLine) ? current : [...current, described].slice(-20));
        }}
        onSaveEvidence={source => setEvidenceSource({ kind: 'file', path: source.path, startLine: source.startLine, endLine: source.endLine, ...(source.rootKey.startsWith('root:') ? { rootId: source.rootKey.slice(5) } : {}) })} />}
      {panel === 'memory' && <KnowledgePanel project={state.project} version={knowledgeVersion} busy={busy} onEdit={setForm} onPropose={scope => void proposeUpdate(scope)} onChanged={() => setKnowledgeVersion(v => v + 1)} onError={failed} />}
      {panel === 'changes' && session && <ChangesPanel session={session} fileEvents={liveEvents.filter(e => e.sessionId === session.id && e.kind === 'file').length} />}
      {panel === 'activity' && session && <ActivityPanel session={session} live={liveEvents} />}
      {(panel === 'context' || (!session && (panel === 'changes' || panel === 'activity'))) && <ContextPanel receipt={receipt} session={session} bootstrap={bootstrap} history={state.receipts} disabled={disabled} live={liveEvents}
        onToggle={id => { const next = disabled.includes(id) ? disabled.filter(x => x !== id) : [...disabled, id]; setDisabled(next); if (receipt?.state === 'prepared') void api<Receipt>('prepareContext', { projectId: state.project.id, task: receipt.query, workspaceId: workspaceId || null, disabled: next, references: referenceInputs }).then(setReceipt).catch(failed); }}
        onSelectReceipt={setReceipt} onChanged={() => setKnowledgeVersion(v => v + 1)} onError={failed} />}
    </aside>}
    {manageId && <ManageProjectDialog projectId={manageId} onClose={() => setManageId(null)} onChanged={() => { void reloadProjects().catch(failed); if (state?.project.id === manageId) void refresh().catch(failed); }}
      onRemoved={() => { const removed = manageId; setManageId(null); removedProject(removed); }} />}
    {renameTarget?.kind === 'project' && <RenameDialog title={`Rename ${renameTarget.project.name}`} label="Display name" value={renameTarget.project.displayName} fallback={renameTarget.project.folderName ?? renameTarget.project.name}
      note="Only Journal's label changes. The folder on disk keeps its name." onClose={() => setRenameTarget(null)}
      onSave={async name => { await api('renameProject', { id: renameTarget.project.id, name }); await reloadProjects(); if (state?.project.id === renameTarget.project.id) await refresh(); }} />}
    {renameTarget?.kind === 'session' && <RenameDialog title="Rename session" label="Session name" value={renameTarget.session.displayName} fallback={renameTarget.session.title}
      note="Only Journal's label changes. The native Claude, Codex or Cursor session ID and continuing the same conversation are unaffected." onClose={() => setRenameTarget(null)}
      onSave={async name => { merge([await api<Session>('renameSession', { id: renameTarget.session.id, name })]); }} />}
    {processView && <ProcessDialog id={processView.id} title={processView.title} command={processView.command} appearance={appearance} onClose={() => setProcessView(null)} onExit={() => void checkCursor(processView.kind)} />}
    {dataDialog && <DataDialog update={update} project={state?.project ?? null} onClose={() => setDataDialog(false)} onChanged={() => { setKnowledgeVersion(v => v + 1); void refresh().catch(() => {}); }} />}
    {state && workspaceDialog && <WorkspaceDialog project={state.project} onClose={() => setWorkspaceDialog(false)} onChanged={() => void refresh().catch(failed)} />}
    {state && evidenceSource && <KnowledgeForm project={state.project} initialSource={evidenceSource} onClose={() => setEvidenceSource(null)} onSaved={() => { setEvidenceSource(null); setPanel('memory'); setKnowledgeVersion(v => v + 1); }} />}
    {state && form && <KnowledgeForm project={state.project} memory={form.memory} supersedes={form.supersedes} initialCategory={form.initialCategory} draft={form.draft} onClose={() => setForm(null)} onSaved={() => { setForm(null); setPanel('memory'); setKnowledgeVersion(v => v + 1); }} />}
  </ResizableWorkspace>;
}
