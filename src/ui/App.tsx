import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TerminalPane } from './TerminalPane';
import { KnowledgeForm } from './KnowledgeForm';
import { KnowledgePanel } from './KnowledgePanel';
import { ResizableWorkspace } from './ResizableWorkspace';
import { SessionList, needsAttention, resumable, stateLabel } from './SessionList';
import { ChangesPanel } from './ChangesPanel';
import { ActivityPanel } from './ActivityPanel';
import { WorkspaceDialog } from './WorkspaceDialog';
import { ContextPanel } from './ContextPanel';
import { DataDialog } from './DataDialog';
import journalMarkWhite from '../../assets/branding/journal-mark-white.png';
import journalMarkDark from '../../assets/branding/journal-mark.png';
import journalWordmark from '../../assets/branding/journal-wordmark.png';
import { storedAppearance, type Appearance } from './theme';
import { api, isLive, type Bootstrap, type Memory, type Project, type ProjectState, type Provider, type Receipt, type Session, type StatusDraft, type TimelineEvent, type WorkspaceList } from './types';

const MAX_SESSIONS = 4;
type Panel = 'knowledge' | 'context' | 'changes' | 'activity';

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
  const [panel, setPanel] = useState<Panel>('knowledge');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [form, setForm] = useState<{ memory?: Memory; supersedes?: Memory; initialCategory?: string; draft?: StatusDraft } | null>(null);
  const [knowledgeVersion, setKnowledgeVersion] = useState(0);
  const [runtime, setRuntime] = useState<{ state: string; warning?: string | null }>({ state: 'connecting' });
  const [liveEvents, setLiveEvents] = useState<TimelineEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const [workspaces, setWorkspaces] = useState<WorkspaceList | null>(null); const [workspaceId, setWorkspaceId] = useState<string>(''); const [research, setResearch] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState(false); const [disabled, setDisabled] = useState<string[]>([]); const [dataDialog, setDataDialog] = useState(false);
  const [resumeDraft, setResumeDraft] = useState<{ sessionId: string; value: string } | null>(null);
  const session = selectedId ? sessions[selectedId] ?? null : null;
  // A confirmation draft belongs to one launch, never to another conversation.
  const resumeValue = resumeDraft?.sessionId === session?.id ? resumeDraft?.value ?? '' : session?.nativeId ?? '';
  const taskRef = useRef<HTMLTextAreaElement>(null); const projectRef = useRef<Project | null>(null);
  projectRef.current = state?.project ?? null;
  const connected = runtime.state === 'connected';
  const failed = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  // Older snapshots (for example a slow store read) never replace newer runtime state.
  const merge = useCallback((items: Session[]) => setSessions(current => {
    const next = { ...current };
    for (const item of items) { const known = next[item.id]; if (!known || (item.version ?? 0) >= (known.version ?? 0)) next[item.id] = { ...known, ...item }; }
    return next;
  }), []);
  useEffect(() => { void api('setAppearance', { appearance }).catch(failed); }, [appearance, failed]);
  // Relative times only; no animation.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
  const refresh = useCallback(async (id?: string) => {
    const projectId = id ?? projectRef.current?.id; if (!projectId) return;
    const next = await api<ProjectState>('project', { projectId }); setState(next); merge(next.sessions);
    const list = await api<WorkspaceList>('workspaces', { projectId }).catch(() => null); setWorkspaces(list);
    setWorkspaceId(current => list?.workspaces.some(w => w.id === current && w.state === 'ready') ? current : '');
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
  const reloadSessions = useCallback(async () => {
    const result = await api<{ live: Session[]; active: Session[] }>('sessions'); merge([...result.active, ...result.live]);
  }, [merge]);
  useEffect(() => {
    void api<Bootstrap>('bootstrap').then(async data => {
      setBootstrap(data); setProjects(data.projects); setRuntime(data.runtime); merge([...data.active, ...data.live]);
      const remembered = (() => { try { return localStorage.getItem('journal-project'); } catch { return null; } })();
      const selected = data.projects.find(p => p.id === (data.live.find(isLive)?.projectId ?? remembered));
      if (selected) {
        const next = await refresh(selected.id);
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
      if (event.type !== 'status') return;
      merge([event.session]);
    });
  }, [refresh, reloadSessions, merge, failed]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (error) { failed(error); } finally { setBusy(false); } }
  async function chooseProject(project: Project) {
    await run(async () => { const next = await refresh(project.id); try { localStorage.setItem('journal-project', project.id); } catch { /* optional */ }
      const live = Object.values(sessions).find(s => isLive(s) && s.projectId === project.id);
      setSelectedId(live?.id ?? null); setReceipt(next?.receipts[0] ?? null); setTask(''); });
  }
  async function openProject() {
    await run(async () => { const project = await api<Project | null>('openProject'); if (!project) return; setProjects(items => [project, ...items.filter(p => p.id !== project.id)]); await refresh(project.id); try { localStorage.setItem('journal-project', project.id); } catch { /* optional */ } setSelectedId(null); setReceipt(null); });
  }
  const ordered = useMemo(() => Object.values(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [sessions]);
  const liveCount = ordered.filter(isLive).length;
  const canStart = connected && liveCount < MAX_SESSIONS;
  async function selectSession(next: Session) {
    await run(async () => {
      if (next.projectId !== state?.project.id) await refresh(next.projectId);
      setSelectedId(next.id); setReceipt(await api<Receipt>('getReceipt', { id: next.receiptId }));
    });
  }
  function newSession() { setSelectedId(null); setPanel(current => current === 'changes' || current === 'activity' ? 'knowledge' : current); requestAnimationFrame(() => taskRef.current?.focus()); }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      // Switch active sessions: ⌘1–4 on macOS, Alt+1–4 elsewhere (Ctrl+digit stays with the terminal).
      const switching = bootstrap?.platform === 'darwin' ? event.metaKey && !event.altKey : event.altKey && !event.ctrlKey && !event.metaKey;
      if (switching && /^[1-4]$/.test(event.key)) {
        const target = ordered.filter(s => isLive(s) || s.status === 'orphaned')[Number(event.key) - 1];
        if (target) { event.preventDefault(); void selectSession(target); }
        return;
      }
      if (!mod) return;
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openProject(); }
      if (event.key.toLowerCase() === 'n' && !event.shiftKey) { event.preventDefault(); newSession(); }
      if (event.shiftKey && event.key.toLowerCase() === 'k' && projectRef.current) { event.preventDefault(); setForm({}); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  });
  async function start(provider: Provider, resumeFrom?: Session) {
    const projectId = resumeFrom?.projectId ?? state?.project.id; if (!projectId) return;
    // Take the task now so text typed while this start finishes is never cleared.
    const submitted = resumeFrom ? '' : task; if (!resumeFrom) setTask('');
    await run(async () => {
      try {
        const result = await api<{ session: Session; receipt: Receipt }>('start', { projectId, provider, task: submitted, resumeId: resumeFrom?.id, ...(resumeFrom ? {} : { workspaceId: workspaceId || null, research, disabled }) });
        merge([result.session]); setSelectedId(result.session.id); setReceipt(result.receipt); setDisabled([]); setPanel('context'); await refresh(projectId);
      } catch (error) { if (submitted) setTask(current => current || submitted); throw error; }
    });
  }
  const sessionAction = (action: string, extra: object = {}) => session && run(async () => { await api(action, { id: session.id, ...extra }); });
  async function closeSession() {
    if (!session) return;
    await run(async () => { const closed = await api<Session>('archiveSession', { id: session.id }); merge([closed]); setSelectedId(null); });
  }
  async function proposeUpdate(scope: 'checkout' | 'branch') {
    if (!state) return;
    await run(async () => { setForm({ draft: await api<StatusDraft>('proposeStatusUpdate', { projectId: state.project.id, scope }) }); });
  }
  const available = (provider: Provider) => bootstrap?.agents.some(a => a.provider === provider && a.available);
  const label = session ? stateLabel(session, connected) : '';
  const projectBranchChanged = session && state && !session.workspaceId && session.projectId === state.project.id && isLive(session) && session.branch !== undefined && session.branch !== state.project.branch;

  return <ResizableWorkspace hasKnowledge={!!state}>
    <aside className="sidebar" id="project-sidebar">
      <div className="brand"><img className="brand-icon" src={journalMark} alt="" width={32} height={32} /><div>Journal<small>PROJECT MEMORY</small></div><span className="local-tag">LOCAL</span></div>
      <button className="open-project" onClick={() => void openProject()} disabled={busy}><span>＋</span> Open project <kbd>{bootstrap?.platform === 'darwin' ? '⌘' : 'Ctrl'} O</kbd></button>
      <div className="nav-caption">PROJECTS <span>{projects.length}</span></div>
      <nav aria-label="Projects">{projects.map(project => <button key={project.id} className={`project-link ${state?.project.id === project.id ? 'selected' : ''}`} onClick={() => void chooseProject(project)}><svg className="folder-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 11h18" /></svg><span>{project.name}</span>{ordered.some(s => s.projectId === project.id && needsAttention(s)) && <span className="attention" aria-label="needs attention">●</span>}</button>)}</nav>
      <SessionList sessions={ordered} projects={projects} selectedId={selectedId} currentProjectId={state?.project.id ?? null} connected={connected} now={now} onSelect={next => void selectSession(next)} onNew={newSession} canStart={!!state && canStart} />
      <div className="sidebar-footer"><button className="theme-toggle" aria-label={`Switch to ${appearance === 'dark' ? 'light' : 'dark'} mode`} onClick={() => setAppearance(value => value === 'dark' ? 'light' : 'dark')}><span aria-hidden="true">{appearance === 'dark' ? '☀' : '◐'}</span> {appearance === 'dark' ? 'Light mode' : 'Dark mode'}</button><button className="theme-toggle" onClick={() => setDataDialog(true)}><span aria-hidden="true">⛁</span> Data and backups</button><span className={`status-dot ${connected ? 'running' : 'waiting'}`} /> {connected ? 'Runtime connected' : runtime.state === 'connecting' ? 'Starting runtime…' : 'Runtime disconnected'}<small>No terminal transcripts saved</small></div>
    </aside>

    <main className="workspace">
      <header className="workspace-heading"><div><span className="eyebrow">WORKSPACE</span><h1>{state?.project.name ?? 'Welcome to Journal'}</h1></div>{state && <span className="branch-badge">⑂ {state.project.branch ?? 'detached HEAD'} <span>{state.project.head?.slice(0, 7)}</span></span>}</header>
      {runtime.state === 'disconnected' && <div className="error-banner" role="status"><span>The Journal runtime is not connected. Reconnecting… Running sessions are shown as disconnected until their state is known; nothing is resent.</span></div>}
      {runtime.warning && <div className="error-banner" role="status"><span>{runtime.warning}</span></div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {!state ? <section className="welcome"><img className="welcome-wordmark" src={journalWordmark} alt="Journal" width={280} height={84} /><span className="eyebrow">A CONTINUOUS THREAD</span><h2>Your project, remembered.</h2><p>Work with Claude Code and Codex in their native terminals.<br />Carry the decisions and lessons into the next session.</p><button className="primary" onClick={() => void openProject()} disabled={busy}>Open project</button><div className="welcome-steps"><span>01 <strong>Open a checkout</strong></span><span>02 <strong>Work in a terminal</strong></span><span>03 <strong>Keep what matters</strong></span></div></section>
        : <>
          <section className="launch-bar" aria-label="Start an agent terminal"><label htmlFor="initial-task">Initial task <span className="optional">optional · used to select relevant knowledge</span></label><textarea ref={taskRef} id="initial-task" value={task} onChange={e => setTask(e.target.value)} maxLength={4000} rows={2} placeholder="What are you working on? Mention a module or path to include knowledge scoped to it." />
            <div className="launch-actions"><div><button className="primary" disabled={busy || !canStart || !available('claude')} onClick={() => void start('claude')}>Start Claude</button><button disabled={busy || !canStart || !available('codex')} onClick={() => void start('codex')}>Start Codex</button>{liveCount >= MAX_SESSIONS && <span className="hint inline">{MAX_SESSIONS} sessions are running. Stop one to start another.</span>}</div><button className="text-button" disabled={busy} onClick={() => void run(async () => { setReceipt(await api<Receipt>('prepareContext', { projectId: state.project.id, task, workspaceId: workspaceId || null, disabled })); setPanel('context'); })}>Preview context ↗</button></div>
            <div className="launch-options"><label className="inline-label">Workspace<select value={workspaceId} onChange={e => setWorkspaceId(e.target.value)} aria-label="Workspace">
              <option value="">Current checkout · {state.project.branch ?? 'detached HEAD'}</option>
              {workspaces?.workspaces.filter(w => w.state === 'ready').map(w => <option key={w.id} value={w.id!}>{w.kind === 'managed' ? 'Worktree' : 'Imported'} · {w.branch ?? 'detached'}</option>)}
            </select></label><button className="text-button" onClick={() => setWorkspaceDialog(true)}>Workspaces…</button>
              <label className="inline-check"><input type="checkbox" checked={research} onChange={e => setResearch(e.target.checked)} /> Research (starts in Claude plan mode or the Codex read-only sandbox; can be changed in the session)</label></div>
            <p className="provider-line">{bootstrap?.agents.map(a => <span key={a.provider} title={a.available ? `${a.path ?? ''}\nResume: ${a.capabilities?.exactResume}\nObserved: status ${a.capabilities?.status.join(', ')}; commands ${a.capabilities?.commands}` : 'Not found on PATH'}>{a.provider === 'claude' ? 'Claude Code' : 'Codex'} {a.available ? a.version ?? '' : '· not found'}</span>)}</p>
            {bootstrap?.agents.some(a => !a.available) && <p className="hint">{bootstrap.agents.filter(a => !a.available).map(a => a.provider).join(', ')} not found on PATH. Install the native CLI, then reopen Journal.</p>}
          </section>
          <section className="terminal-panel"><div className="terminal-heading"><div><span className={`status-dot ${session?.status ?? ''}`} /><strong>{session ? session.provider === 'claude' ? 'Claude Code' : 'Codex' : 'Terminal'}</strong><span className="terminal-label">{session ? `${label}${session.branch ? ` · ${projectBranchChanged ? 'started on ' : ''}⑂ ${session.branch}` : ''}${session.workspaceId ? ' · worktree' : ''}${session.research ? ' · research' : ''}` : 'Ready to start'}</span>{session && <span className="terminal-title" title={session.title}>{session.title}</span>}</div>
            {session && <div className="terminal-actions">
              {isLive(session) && connected && <><button onClick={() => void sessionAction('interrupt')}>Interrupt <kbd>^C</kbd></button><button onClick={() => void sessionAction('stop')} disabled={session.status === 'stopping'}>Stop terminal</button></>}
              {resumable(session) && <button disabled={busy || !canStart} onClick={() => void start(session.provider, session)}>Resume</button>}
              {session.status === 'orphaned' && session.identityVerified !== false && <button onClick={() => void sessionAction('terminateOrphan')}>End orphaned process</button>}
              {!!session.survivors?.length && <button onClick={() => void sessionAction('terminateSurvivors')}>End {session.survivors.length} leftover process{session.survivors.length === 1 ? '' : 'es'}</button>}
              {!isLive(session) && session.status !== 'orphaned' && <button onClick={() => void closeSession()}>Close</button>}
              {!isLive(session) && session.status !== 'orphaned' && <button onClick={() => void run(async () => { const purged = await api('purgeSession', { id: session.id }); if (purged) { setSessions(current => { const next = { ...current }; delete next[session.id]; return next; }); setSelectedId(null); await refresh(); } })}>Delete history</button>}
            </div>}</div>
            {projectBranchChanged && <p className="hint session-hint">The checkout is now on {state.project.branch ?? 'a detached HEAD'}; this session started on {session.branch ?? 'a detached HEAD'}.</p>}
            {session?.status === 'orphaned' && <p className="hint session-hint">{session.identityVerified === false ? `A process with this session's PID (${(session as { pid?: number }).pid ?? 'unknown'}) is still running, but Journal cannot verify it is the original agent, so it will not signal it. Resume stays blocked until it ends; check it outside Journal.` : 'The runtime that owned this terminal stopped while its process kept running. Journal cannot reattach to it. End it here, or leave it running; resuming this conversation stays blocked while it runs.'}</p>}
            {session?.status === 'interrupted' && <p className="hint session-hint">This session's runtime stopped unexpectedly. Its prompt delivery is marked uncertain and nothing was resent.{resumable(session) ? ' Resume reopens the exact native conversation.' : ''}</p>}
            {!!session?.survivors?.length && <p className="hint session-hint">Child processes outlived the agent: {session.survivors.map(s => `${s.pid} ${s.command}`).join('; ')}</p>}
            {session ? <TerminalPane key={session.id} sessionId={session.id} live={isLive(session) && connected} appearance={appearance} onError={setError} /> : <div className="terminal-empty"><img className="terminal-brand-mark" src={journalMark} alt="" width={50} height={50} /><h2>A familiar place to work.</h2><p>Start an agent above. Your native login, settings,<br />and tool approvals stay with the CLI.</p></div>}
            {session && !isLive(session) && session.status !== 'orphaned' && !session.nativeIdConfirmed && <div className="resume-id"><label>Native session ID<input value={resumeValue} onChange={e => setResumeDraft({ sessionId: session.id, value: e.target.value })} placeholder="Exact UUID from the native CLI" /></label><button disabled={busy} onClick={() => void run(async () => { const next = await api<Session>('confirmNativeId', { id: session.id, nativeId: resumeValue }); merge([next]); })}>Confirm resume ID</button></div>}
            <footer className="terminal-footer"><span>{state.project.root}</span><span>Native permissions · volatile output</span></footer>
          </section>
        </>}
    </main>

    {state && <aside className="knowledge-panel" id="knowledge-sidebar"><div className="panel-tabs" role="tablist" aria-label="Project information">
      <button role="tab" aria-selected={panel === 'knowledge'} onClick={() => setPanel('knowledge')}><span className="panel-tab-label">Knowledge</span></button>
      <button role="tab" aria-selected={panel === 'context'} onClick={() => setPanel('context')}><span className="panel-tab-label">Context</span></button>
      <button role="tab" aria-selected={panel === 'changes'} disabled={!session} onClick={() => setPanel('changes')}><span className="panel-tab-label">Changes</span></button>
      <button role="tab" aria-selected={panel === 'activity'} disabled={!session} onClick={() => setPanel('activity')}><span className="panel-tab-label">Activity</span></button></div>
      {panel === 'knowledge' && <KnowledgePanel project={state.project} version={knowledgeVersion} busy={busy} onEdit={setForm} onPropose={scope => void proposeUpdate(scope)} onChanged={() => setKnowledgeVersion(v => v + 1)} onError={failed} />}
      {panel === 'changes' && session && <ChangesPanel session={session} fileEvents={liveEvents.filter(e => e.sessionId === session.id && e.kind === 'file').length} />}
      {panel === 'activity' && session && <ActivityPanel session={session} live={liveEvents} />}
      {(panel === 'context' || (!session && (panel === 'changes' || panel === 'activity'))) && <ContextPanel receipt={receipt} session={session} bootstrap={bootstrap} history={state.receipts} disabled={disabled}
        onToggle={id => { const next = disabled.includes(id) ? disabled.filter(x => x !== id) : [...disabled, id]; setDisabled(next); if (receipt?.state === 'prepared') void api<Receipt>('prepareContext', { projectId: state.project.id, task: receipt.query, workspaceId: workspaceId || null, disabled: next }).then(setReceipt).catch(failed); }}
        onSelectReceipt={setReceipt} onChanged={() => setKnowledgeVersion(v => v + 1)} onError={failed} />}
    </aside>}
    {dataDialog && <DataDialog project={state?.project ?? null} onClose={() => setDataDialog(false)} onChanged={() => { setKnowledgeVersion(v => v + 1); void refresh().catch(() => {}); }} />}
    {state && workspaceDialog && <WorkspaceDialog project={state.project} onClose={() => setWorkspaceDialog(false)} onChanged={() => void refresh().catch(failed)} />}
    {state && form && <KnowledgeForm project={state.project} memory={form.memory} supersedes={form.supersedes} initialCategory={form.initialCategory} draft={form.draft} onClose={() => setForm(null)} onSaved={() => { setForm(null); setPanel('knowledge'); setKnowledgeVersion(v => v + 1); }} />}
  </ResizableWorkspace>;
}
