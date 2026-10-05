import { useEffect, useState } from 'react';
import { api, type Proposal } from './types';

const NONE: Proposal[] = [];

// Open suggestions for the current project, fetched once for the whole window
// (the sidebar and the Memory tab share them). App bumps version on the
// `proposals` event and after any memory change; a project switch refetches.
// A reply for another project, or one superseded by a newer request, is dropped.
export function useProposals(projectId: string | null, version: number, onError: (error: unknown) => void): Proposal[] {
  const [loaded, setLoaded] = useState<{ projectId: string; items: Proposal[] } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let current = true;
    void api<Proposal[]>('proposals', { projectId }).then(items => { if (current) setLoaded({ projectId, items }); }, error => { if (current) onError(error); });
    return () => { current = false; };
  }, [projectId, version, onError]);
  return loaded && loaded.projectId === projectId ? loaded.items : NONE;
}
