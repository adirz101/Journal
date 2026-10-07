import { useRef, type ReactNode } from 'react';
import type { TeamRun, RunMessage } from './TeamPanel';
import type { TeamAction } from './TeamControls';
import { conversationEntries, messageDeliveryLabel } from '../core/story/team-conversation.mjs';
export interface RunEvent { id: number; at: string; kind: string; body: Record<string, unknown> }
interface Props {
  run: TeamRun; events: RunEvent[]; draft: string; onDraft(value: string, expected?: string): void;
  act: TeamAction; teamAct: TeamAction; busy: boolean; onTerminal(): void;
  results: ReactNode;
}
export function TeamConversation({ run, events, draft, onDraft, act, teamAct, busy, onTerminal, results }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const entries = conversationEntries(events, run.messages);
  const waiting = run.messages.filter(message => message.sender === 'desktop' && message.recipient === 'coordinator' && ['held', 'uncertain'].includes(message.state));
  const send = () => {
    const text = draft;
    if (text.trim()) void act('sendMessage', { runId: run.id, recipient: 'coordinator', kind: 'instruction', text }).then(sent => { if (sent) onDraft('', text); input.current?.focus(); });
  };
  const recovery = (message: RunMessage) => <div className="team-delivery-actions">
    {message.heldReason && <p>Waiting: {message.heldReason.replaceAll('_', ' ').toLowerCase()}</p>}
    {['queued', 'held'].includes(message.state) && <button disabled={busy} onClick={() => void act('cancelMessage', { messageId: message.id })}>Cancel message</button>}
    {message.state === 'uncertain' && <><p>Delivery is uncertain. Nothing was resent. Check and clear the recipient input in its native terminal before continuing.</p><button onClick={onTerminal}>Open coordinator terminal</button>{!message.inputResolved ? <button disabled={busy} onClick={() => void teamAct('resolveMessageInput', { messageId: message.id })}>Input checked and cleared</button> : <button disabled={busy} onClick={() => void act('resendMessage', { messageId: message.id })}>Resend this message</button>}</>}
  </div>;
  return <div className="team-conversation">
    <p className="team-conversation-note">Your instructions and published coordinator updates. <button onClick={onTerminal}>Open full native conversation</button><button onClick={() => input.current?.focus()}>Write a message</button></p>
    <details className="team-original"><summary>Original request</summary><p>{run.goal}</p></details>
    {!entries.some(entry => entry.source === 'coordinator') && <p className="team-empty">The coordinator has not published an update yet. Its full conversation remains in the native terminal.</p>}
    <ol className="team-conversation-log" aria-label="Run conversation">
      {entries.map(entry => <li key={entry.id} className={entry.source === 'user' ? 'team-user-message' : 'team-coordinator-message'}>
        <div className="team-row"><strong>{entry.source === 'user' ? 'You' : 'Coordinator update'}</strong>{entry.at && <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString()}</time>}</div>
        <p>{entry.text}</p>
        {entry.message && <><small>{entry.message.recipient !== 'coordinator' ? 'To worker · ' : ''}{messageDeliveryLabel(entry.message.state)}</small>{recovery(entry.message)}</>}
      </li>)}
    </ol>
    {!!waiting.length && <p className="team-attention" role="status">{waiting.length} instruction{waiting.length === 1 ? '' : 's'} need delivery attention. Review the message above or open the native terminal.</p>}
    {results}
    <form className="team-message team-conversation-composer" onSubmit={event => { event.preventDefault(); send(); }}>
      <label htmlFor="team-coordinator-message">Message to coordinator</label><textarea id="team-coordinator-message" ref={input} value={draft} onChange={event => onDraft(event.target.value)} maxLength={8000} rows={3} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!busy && run.state !== 'finished') send(); } }} />
      <button disabled={busy || !draft.trim() || run.state === 'finished'}>Send message</button>
    </form>
  </div>;
}
