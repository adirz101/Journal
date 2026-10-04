import { useCallback, useEffect, useRef, useState } from 'react';
import { createPreviewScheduler, type PreviewOutcome, type PreviewScheduler } from './previewScheduler';
import { api, type Receipt, type SelectionPreview } from './types';
import { composer } from './copy';

export interface PreviewInput {
  projectId: string; task: string; workspaceId: string | null; branch: string | null;
  disabled: string[]; references: object[];
  version: number;   // knowledge changes (a note remembered or forgotten) ask again
}
type Result = SelectionPreview | Receipt;

// The composer's live preview: a SQLite-only selection 250 ms after typing
// stops, then a full check (validating, storing nothing) after 1 s idle.
// The inputs are exactly what a start sends, so the preview matches the launch.
// Errors stay here (they never reach App's banner). onChecked hears every
// applied full check, so the inspector can follow a preview it shows.
export function useContextPreview(input: PreviewInput | null, onChecked?: (receipt: Receipt) => void) {
  const [result, setResult] = useState<Result | null>(null); const [error, setError] = useState<string | null>(null);
  const checked = useRef(onChecked); checked.current = onChecked;
  const scheduler = useRef<PreviewScheduler<PreviewInput, SelectionPreview, Receipt> | null>(null);
  if (!scheduler.current) scheduler.current = createPreviewScheduler<PreviewInput, SelectionPreview, Receipt>({
    debounceMs: 250, idleMs: 1000, timeoutMs: 20000, timeoutMessage: composer.previewTimedOut,
    request: (kind, { projectId, task, workspaceId, branch, disabled, references }) => kind === 'selection'
      ? api<SelectionPreview>('previewSelection', { projectId, task, workspaceId, branch, disabled, references })
      : api<Receipt>('prepareContext', { projectId, task, workspaceId, disabled, references }),
    onResult: (outcome: PreviewOutcome<Result>) => {
      // An error replaces the list: notes and underlines of an older task never sit beside it.
      if (outcome.error !== undefined) { setError(outcome.error); setResult(null); return; }
      setError(null); setResult(outcome.value);
      if (outcome.kind === 'full') checked.current?.(outcome.value as Receipt);
    },
  });
  useEffect(() => () => scheduler.current?.dispose(), []);
  // A project or workspace switch drops everything in flight and the old list.
  const scope = input ? `${input.projectId}\n${input.workspaceId ?? ''}` : '';
  const previous = useRef<{ scope: string; key: string; disabled: string } | null>(null);
  const key = input ? JSON.stringify([input.task, input.branch, input.references, input.version]) : '';
  const disabledKey = input ? input.disabled.join('\n') : '';
  useEffect(() => {
    const before = previous.current; previous.current = { scope, key, disabled: disabledKey };
    if (!input) { scheduler.current!.reset(); setResult(null); setError(null); return; }
    if (before && before.scope !== scope) { scheduler.current!.reset(); setResult(null); setError(null); }
    else if (before && before.key === key && before.disabled === disabledKey) return;
    // Leave out and restore ask at once; typing waits for a pause.
    const immediate = !!before && before.scope === scope && before.key === key && before.disabled !== disabledKey;
    scheduler.current!.update(input, { immediate });
  }, [scope, key, disabledKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Inspect all: the full check now.
  // The inputs can change while it runs (a note just remembered): then it checks the newest ones.
  const flush = useCallback(async (): Promise<Receipt | null> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const outcome = await scheduler.current?.flush();
      // No input (a reset or unmount meanwhile) or a failed check: nothing to inspect.
      if (!outcome || outcome.error !== undefined) return null;
      if (outcome.ticket === scheduler.current?.latest) return outcome.value as Receipt;
    }
    return null;
  }, []);
  return { result, error, flush };
}
