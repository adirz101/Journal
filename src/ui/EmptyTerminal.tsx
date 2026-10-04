import { firstRun } from './copy';

// The empty terminal art before a session (board 12, placement 6). Phase 7 keeps it in
// its own component so Phase 4's composer can mount it unchanged.
export function EmptyTerminal({ mark, keys }: { mark: string; keys: string | null }) {
  return <div className="terminal-empty"><img className="terminal-brand-mark" src={mark} alt="" width={44} height={44} /><h2>{firstRun.emptyTerminalTitle}</h2><p>{firstRun.emptyTerminalBody(keys)}</p></div>;
}
