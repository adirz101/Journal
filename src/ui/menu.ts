import { api } from './types';

export type MenuItem = { id: string; label: string; enabled?: boolean } | { separator: true };

// Opens the native context menu (Electron positions it, handles Escape,
// outside clicks, keyboard and theme) and returns the chosen item ID.
export async function showMenu(items: (MenuItem | false | null | undefined)[]): Promise<string | null> {
  const list = items.filter(Boolean) as MenuItem[];
  // Drop leading, trailing and doubled separators left by state-dependent items.
  const clean = list.filter((item, index) => !('separator' in item) || (index > 0 && index < list.length - 1 && !('separator' in list[index - 1])));
  return await api<string | null>('contextMenu', { items: clean });
}
