export function migrateOrchestration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, state TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id,state);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, state TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tasks_run ON tasks(run_id,state);
    CREATE TABLE IF NOT EXISTS dependencies(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'integrated', PRIMARY KEY(task_id,depends_on));
    CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, state TEXT NOT NULL, presence TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id,state);
    CREATE INDEX IF NOT EXISTS attempts_run ON attempts(run_id,state);
    CREATE INDEX IF NOT EXISTS attempts_queue ON attempts(state,json_extract(body,'$.admission.queuedAt')) WHERE state='queued';
    CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, attempt_id TEXT REFERENCES attempts(id) ON DELETE CASCADE, status TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS results_attempt ON results(attempt_id);
    CREATE TABLE IF NOT EXISTS orchestration_operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,caller_id TEXT NOT NULL,request_id TEXT NOT NULL,phase TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(caller_id,request_id));
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,recipient TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient,state);
    CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,state TEXT NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id,state);
    CREATE TABLE IF NOT EXISTS run_events(id INTEGER PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,at TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id,id);
    CREATE TABLE IF NOT EXISTS capacity_samples(at TEXT NOT NULL,body TEXT NOT NULL);
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO results VALUES(?,?,?,?,?)');
  for (const row of db.prepare("SELECT body FROM workspaces WHERE json_extract(body,'$.kind')='isolated'").all()) {
    const env = JSON.parse(row.body);
    for (const result of env.results ?? (env.result ? [env.result] : [])) {
      const id = result.resultId ?? result.sha;
      const applied = env.integration?.phase === 'done' && env.integration.result === result.sha;
      const body = { ...result, id, environmentId: env.id, attemptId: null, resultCommit: result.sha, treeOid: result.tree,
        resultRef: `refs/journal/env/${env.id}/${result.resultId ? `results/${result.resultId}` : 'result'}`,
        integrations: applied ? [env.integration] : [], checks: [], testsVerified: 'not-run' };
      insert.run(id, env.id, null, applied ? 'applied' : env.result?.sha === result.sha ? 'current' : 'superseded', JSON.stringify(body));
    }
  }
}
