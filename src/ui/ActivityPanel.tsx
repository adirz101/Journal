import { useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineEvent } from './types';
import { count, deliveryState, shell } from './copy';

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
export function Timeline({ events }: { events: TimelineEvent[] }) {
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

// Commands Claude ran, newest first, with their exits (Claude hooks).
export function commandsFrom(events: TimelineEvent[]) {
  const map = new Map<string, Command>();
  for (const event of events) {
    const b = event.body as Record<string, any>;
    if (event.kind === 'command-start') map.set(b.toolUseId, { toolUseId: b.toolUseId, command: b.command, cwd: b.cwd ?? null, test: !!b.test, at: event.at, status: b.background ? 'background' : 'running', exitCode: null, durationMs: null, endedAt: null });
    if (event.kind === 'command-end' && map.has(b.toolUseId)) Object.assign(map.get(b.toolUseId)!, { status: b.status, exitCode: b.exitCode, durationMs: b.durationMs, endedAt: event.at });
  }
  return [...map.values()].reverse();
}

const exitChip = (c: Command) => `${c.status === 'succeeded' ? 'exit 0' : c.exitCode !== null ? `exit ${c.exitCode}` : c.status}${c.durationMs !== null ? ` · ${(c.durationMs / 1000).toFixed(1)} s` : ''}`;
const MAX_ROWS = 30;

// "What it did" (Session tab): Claude's commands, edits and approval prompts,
// newest last, at most 30; the full timeline and test summary on request.
// observable false (Codex, Cursor): only Journal's own timeline, on request.
export function ActivitySummary({ events, observable = true }: { events: TimelineEvent[]; observable?: boolean }) {
  const [full, setFull] = useState(false);
  const commands = useMemo(() => commandsFrom(events), [events]);
  const byId = useMemo(() => new Map(commands.map(c => [c.toolUseId, c])), [commands]);
  const rows = useMemo(() => events.filter(e => e.kind === 'command-start' || e.kind === 'file' || e.kind === 'permission').slice(-MAX_ROWS), [events]);
  const tests = commands.filter(c => c.test);
  return <>
    {observable && (rows.length ? <ul className="did-list" aria-label="What it did">{rows.map((event, index) => {
      const b = event.body as Record<string, any>; const command = event.kind === 'command-start' ? byId.get(b.toolUseId) : undefined;
      return <li key={event.id ?? `${event.at}-${index}`}>
        <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        <span className={`chip kind-${event.kind}`}>{event.kind === 'command-start' ? 'command' : event.kind === 'file' ? 'edit' : 'approval'}</span>
        <code title={command ? `${command.command}\nin ${command.cwd ?? 'unknown directory'} · output not stored` : undefined}>{event.kind === 'command-start' ? b.command : event.kind === 'file' ? b.path : b.command ?? b.path ?? b.tool ?? 'permission'}</code>
        {command && command.status !== 'running' && <span className={`chip command-status ${command.status}`}>{exitChip(command)}</span>}
      </li>;
    })}</ul> : <p className="muted">No commands or edits observed yet.</p>)}
    <button className="text-button" aria-expanded={full} onClick={() => setFull(!full)}>{full ? 'Hide full timeline' : shell.showTimeline}</button>
    {full && <>
      {observable && <section aria-label="Tests" className="test-summary"><span className="eyebrow">Test commands</span>
        {tests.length ? <p>{tests.filter(t => t.status === 'succeeded').length} exited 0 · {tests.filter(t => t.status === 'failed').length} failed · {tests.filter(t => !['succeeded', 'failed'].includes(t.status)).length} running or unknown</p> : <p className="muted">No test commands observed.</p>}
        <small>Exit status only, from Claude Code hooks. Journal does not parse test reports or infer results from agent text, and does not store command output.</small></section>}
      <section aria-label="Timeline" className="timeline-section"><span className="eyebrow">Timeline · {events.length}</span><Timeline events={events} /></section>
    </>}
  </>;
}
