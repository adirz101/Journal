import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Session, type TimelineEvent } from './types';
import { count, deliveryState } from './copy';

interface Command { toolUseId: string; command: string; cwd: string | null; test: boolean; at: string; status: string; exitCode: number | null; durationMs: number | null; endedAt: string | null; }

const describe = (event: TimelineEvent) => {
  const b = event.body as Record<string, any>;
  switch (event.kind) {
    case 'start': return `Session started on ${b.branch ?? 'detached HEAD'}`;
    case 'resume': return 'Continued the same conversation';
    case 'context': return `Context ${deliveryState(b.state)}: ${count(Number(b.claims ?? 0), 'note')}`;
    case 'prompt': return 'Prompt submitted';
    case 'permission': return `Waiting for approval${b.tool ? `: ${b.tool}` : ''}`;
    case 'turn-end': return 'Agent finished its turn';
    case 'command-start': return `$ ${b.command}`;
    case 'command-end': return `${b.status === 'succeeded' ? 'Exit 0' : b.exitCode !== null && b.exitCode !== undefined ? `Exit ${b.exitCode}` : b.status}${b.durationMs ? ` · ${(b.durationMs / 1000).toFixed(1)}s` : ''}`;
    case 'file': return `${b.tool ?? 'Edited'} ${b.path}`;
    case 'interrupt': return 'Interrupt sent (Ctrl+C)';
    case 'stop': return `Stopped${b.survivors ? ` · ${b.survivors} child process${b.survivors === 1 ? '' : 'es'} still running` : ''}`;
    case 'exit': return `Process exited${b.exitCode !== null && b.exitCode !== undefined ? ` with code ${b.exitCode}` : ''}${b.survivors ? ` · ${b.survivors} child process${b.survivors === 1 ? '' : 'es'} still running` : ''}`;
    case 'error': return `Error: ${b.message}`;
    case 'recovered': return `Recovered after the runtime stopped: ${b.status}`;
    case 'cleanup': return 'Process cleanup requested';
    case 'reference': return `${b.delivery === 'inserted' ? 'Typed' : 'Copied'} reference ${b.text ?? b.path}`;
    default: return event.kind;
  }
};

const ROW = 26;
// Fixed-height rows rendered for the visible window only.
function Timeline({ events }: { events: TimelineEvent[] }) {
  const box = useRef<HTMLDivElement>(null); const [top, setTop] = useState(0); const [height, setHeight] = useState(320);
  const stick = useRef(true);
  useEffect(() => {
    const node = box.current; if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.clientHeight)); observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => { const node = box.current; if (node && stick.current) node.scrollTop = node.scrollHeight; }, [events.length]);
  const first = Math.max(0, Math.floor(top / ROW) - 5); const last = Math.min(events.length, Math.ceil((top + height) / ROW) + 5);
  return <div className="timeline" ref={box} role="list" aria-label="Session timeline" tabIndex={0}
    onScroll={event => { const node = event.currentTarget; setTop(node.scrollTop); stick.current = node.scrollTop + node.clientHeight >= node.scrollHeight - ROW; }}>
    <div style={{ height: events.length * ROW, position: 'relative' }}>
      {events.slice(first, last).map((event, index) => <div role="listitem" key={event.id ?? `${event.at}-${first + index}`} className={`timeline-row kind-${event.kind}`} style={{ top: (first + index) * ROW }}>
        <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span title={describe(event)}>{describe(event)}</span>
      </div>)}
    </div>
  </div>;
}

export function ActivityPanel({ session, live }: { session: Session; live: TimelineEvent[] }) {
  const [stored, setStored] = useState<TimelineEvent[]>([]); const [error, setError] = useState('');
  useEffect(() => { let cancelled = false; setStored([]); void api<TimelineEvent[]>('sessionEvents', { id: session.id }).then(e => { if (!cancelled) setStored(e); }).catch(e => setError(String(e.message ?? e))); return () => { cancelled = true; }; }, [session.id]);
  const events = useMemo(() => {
    const latest = stored.at(-1)?.at ?? '';
    return [...stored, ...live.filter(e => e.sessionId === session.id && e.at > latest)];
  }, [stored, live, session.id]);
  const commands = useMemo(() => {
    const map = new Map<string, Command>();
    for (const event of events) {
      const b = event.body as Record<string, any>;
      if (event.kind === 'command-start') map.set(b.toolUseId, { toolUseId: b.toolUseId, command: b.command, cwd: b.cwd ?? null, test: !!b.test, at: event.at, status: b.background ? 'background' : 'running', exitCode: null, durationMs: null, endedAt: null });
      if (event.kind === 'command-end' && map.has(b.toolUseId)) Object.assign(map.get(b.toolUseId)!, { status: b.status, exitCode: b.exitCode, durationMs: b.durationMs, endedAt: event.at });
    }
    return [...map.values()].reverse();
  }, [events]);
  const tests = commands.filter(c => c.test);
  const observable = session.provider === 'claude';
  return <div className="panel-content activity-content">
    <div className="section-heading"><div><span className="eyebrow">OBSERVED ACTIVITY</span><h2>Commands and timeline</h2></div></div>
    <p className="muted panel-intro">{observable ? 'Commands and exit codes come from Claude Code hooks. Running commands without a reported exit are shown as running or unknown.' : `${session.provider === 'cursor' ? 'Cursor' : 'Codex'} does not expose command events to Journal in this mode, so commands and test results are unknown. The timeline shows what Journal itself observed.`}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {observable && <section aria-label="Tests" className="test-summary">
      <span className="eyebrow">TEST COMMANDS</span>
      {tests.length ? <p>{tests.filter(t => t.status === 'succeeded').length} exited 0 · {tests.filter(t => t.status === 'failed').length} failed · {tests.filter(t => !['succeeded', 'failed'].includes(t.status)).length} running or unknown</p> : <p className="muted">No test commands observed.</p>}
      <small>Exit status only, from Claude Code hooks. Journal does not parse test reports or infer results from agent text, and does not store command output.</small>
    </section>}
    {observable && <section aria-label="Commands"><span className="eyebrow">COMMANDS</span>
      {commands.length ? <ul className="command-list">{commands.slice(0, 100).map(c => <li key={c.toolUseId}>
        <code title={`${c.command}\nin ${c.cwd ?? 'unknown directory'} · started ${new Date(c.at).toLocaleTimeString()}${c.endedAt ? ` · ended ${new Date(c.endedAt).toLocaleTimeString()}` : ''} · output not stored`}>{c.cwd && c.cwd !== '.' ? `${c.cwd} $ ` : ''}{c.command}</code>
        <span className={`command-status ${c.status}`}>{c.status === 'succeeded' ? 'exit 0' : c.exitCode !== null ? `exit ${c.exitCode}` : c.status}{c.durationMs !== null ? ` · ${(c.durationMs / 1000).toFixed(1)}s` : ''}{c.test ? ' · test' : ''}</span>
      </li>)}</ul> : <p className="muted">No commands observed yet.</p>}
    </section>}
    <section aria-label="Timeline" className="timeline-section"><span className="eyebrow">TIMELINE · {events.length}</span><Timeline events={events} /></section>
  </div>;
}
