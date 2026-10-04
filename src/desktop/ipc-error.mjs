// What a failed desktop request returns across the preload bridge. Only a
// string code crosses, bounded, so an error object's other fields (or a
// non-string code such as a number or object) never reach the renderer.
export function settledError(error) {
  return { ok: false, error: error instanceof Error ? error.message : 'Operation failed', ...(typeof error?.code === 'string' ? { code: error.code.slice(0, 40) } : {}) };
}
