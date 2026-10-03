import { api } from './types';

export type MenuItem = { id: string; label: string; enabled?: boolean } | { separator: true };

// Opens the native context menu (Electron positions it, handles Escape,
// outside clicks, keyboard and theme) and returns the chosen item ID.
// position: where to open (from the triggering element for keyboard opens); defaults to the pointer.
export async function showMenu(items: (MenuItem | false | null | undefined)[], position?: { x: number; y: number }): Promise<string | null> {
  // Drop leading, trailing and doubled separators left by state-dependent items.
  const clean: MenuItem[] = [];
  for (const item of items.filter(Boolean) as MenuItem[]) if (!('separator' in item) || (clean.length && !('separator' in clean[clean.length - 1]))) clean.push(item);
  while (clean.length && 'separator' in clean[clean.length - 1]) clean.pop();
  return await api<string | null>('contextMenu', { items: clean, ...(position ? { x: Math.round(position.x), y: Math.round(position.y) } : {}) });
}

// Pointer opens use the pointer; keyboard opens (menu key, Shift+F10, buttons)
// report no pointer position, so the menu opens at the element instead.
export function menuPosition(event: { clientX: number; clientY: number; currentTarget: EventTarget | null; detail?: number }) {
  if (event.clientX || event.clientY) return undefined;
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  return rect ? { x: rect.left + 8, y: rect.bottom } : undefined;
}
