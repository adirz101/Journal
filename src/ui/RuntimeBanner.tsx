import { useEffect, useState } from 'react';
import { states } from './copy';

// Runtime disconnected (board 9, panel 1): one honest sentence and Reconnect now. The
// sidebar rows already say "Disconnected · state unknown". After a click the button waits
// for the next runtime event, or 5 s, whichever comes first. runtime: App's runtime state
// object, replaced on every runtime event. warning: why the runtime couldn't be started.
// App mounts it inside a status region that stays mounted (.runtime-live), so it is announced
// when it appears. While waiting, the button stays focusable (aria-disabled), so a keyboard
// press does not drop focus to the page.
export function RuntimeBanner({ runtime, onReconnect }: { runtime: { state: string; warning?: string | null }; onReconnect(): Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => { setPending(false); }, [runtime]);
  useEffect(() => { if (!pending) return; const timer = setTimeout(() => setPending(false), 5000); return () => clearTimeout(timer); }, [pending]);
  return <div className="runtime-banner" data-expanded={expanded}>
    <p className="runtime-banner-title"><svg className="runtime-banner-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>{states.lostTitle}</p>
    {expanded && runtime.warning && <p className="runtime-banner-warning">{runtime.warning}</p>}
    {expanded && <p className="runtime-banner-body">{states.lostBody}</p>}
    <div className="runtime-banner-actions">
      <button type="button" className="primary" aria-disabled={pending || undefined} onClick={() => { if (pending) return; setPending(true); void onReconnect().catch(() => setPending(false)); }}>{pending ? states.reconnecting : states.reconnectNow}</button>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide connection details' : 'Show connection details'}</button>
    </div>
  </div>;
}
