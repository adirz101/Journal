import claude from './claude.mjs';
import codex from './codex.mjs';
import cursor from './cursor.mjs';

// Provider adapters. Each one has:
// - events: the provider's hook events Journal registers, in a fixed order;
// - response: what the hook launcher prints for it ('' or '{}'), so it never decides anything;
// - bindsIdentity: whether a launch without a native ID binds the first parent event's ID;
// - strictIdentity: whether every parent event's ID is checked (otherwise only on a state change);
// - hookTimeoutSeconds: the per-hook timeout registered with the provider, which enforces it
//   (each adapter cites the provider's documentation or source);
// - register({ dir, session, command }): writes the launch's registration and returns
//   { settingsFile?, files }, or null when this provider is not observed (yet);
// - localTurnIds: bind reporting to observed parent prompts when the provider has no native turn key;
//   this does not qualify live capture, delivery, or continuation;
// - extract(payload): the hook payload reduced to an observation line (hook process);
// - normalize(line): the line in Journal's vocabulary (common.mjs KINDS), or null when it
//   cannot be classified (dropped).
export const ADAPTERS = Object.freeze({ claude, codex, cursor });
export const adapterFor = provider => Object.hasOwn(ADAPTERS, provider) ? ADAPTERS[provider] : null;
