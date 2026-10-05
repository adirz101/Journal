import type { ReactNode } from 'react';

// The inspector's Memory tab: the project memory panel, with the open
// suggestions App fetches once for the window.
export function MemoryTab({ children }: { children: ReactNode }) {
  return <div className="memory-tab">{children}</div>;
}
