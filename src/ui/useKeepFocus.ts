import { useLayoutEffect, useRef } from 'react';

// Phase 7: keeps keyboard focus in a region when an update removes the focused control
// (for example Check again after the agent turns signed in, or Install… after an install).
// The focused element is read while rendering, before React changes the DOM; after the
// commit, if that element left the document, focus moves to fallback(root) or the root.
// A control that is only disabled (busy) is left alone.
export function useKeepFocus<T extends HTMLElement>(fallback: (root: T) => HTMLElement | null | undefined = () => null) {
  const ref = useRef<T>(null);
  const focused = useRef<Element | null>(null);
  const active = typeof document === 'undefined' ? null : document.activeElement;
  focused.current = ref.current && active && ref.current !== active && ref.current.contains(active) ? active : null;
  useLayoutEffect(() => {
    const root = ref.current; const was = focused.current;
    if (!root || !was || was.isConnected) return;
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected) return;
    (fallback(root) ?? root).focus();
  });
  return ref;
}

// The first control a keyboard user can still press inside root, if any.
export const firstEnabled = (root: HTMLElement) => root.querySelector<HTMLElement>('button:not(:disabled):not([aria-disabled="true"])');
