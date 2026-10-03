import { realpathSync } from 'node:fs';

// Canonical paths for comparison. On Windows the native resolver expands 8.3
// short names (C:\Users\RUNNER~1 → C:\Users\runneradmin) and normalises case and
// separators, so a path typed or taken from the temp folder compares equal to
// the same folder as Git reports it. Elsewhere it matches realpathSync.
export const realPath = path => realpathSync.native(path);
