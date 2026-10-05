// The environment for Git commands Journal runs against a folder it chose
// itself (git -C <folder>). Variables that redirect Git to another repository,
// work tree, index or object store are removed, so a Journal started from a Git
// hook or an editor's terminal (which may set GIT_DIR or GIT_INDEX_FILE) never
// lists or reads a different repository. These are Git's local repository
// variables (`git rev-parse --local-env-vars`) apart from the configuration
// ones, which hold the user's settings rather than a repository location.
export const REPO_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE', 'GIT_REPLACE_REF_BASE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_PREFIX']);

export function gitEnv(extra = {}, base = process.env) {
  const env = { ...base };
  // Windows environment names are case-insensitive.
  for (const name of Object.keys(env)) if (REPO_ENV.has(name.toUpperCase())) delete env[name];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', ...extra };
}
