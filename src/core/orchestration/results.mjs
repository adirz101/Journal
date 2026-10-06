// A successful unrelated command cannot certify the configured test suite. Other
// project runners remain unknown until their exact required command is registered.
export function testEvidenceState(checks, hasConfiguredTest) {
  if (!hasConfiguredTest) return 'unknown';
  const check = checks.filter(item => ['["npm","test"]', '["npm","run","test"]'].includes(JSON.stringify(item.command))).at(-1);
  if (!check) return 'not-run';
  if (check.provenance !== 'isolated-verification' || !check.isolation || check.state !== 'finished' || !Number.isInteger(check.exit)) return 'unknown';
  return check.exit === 0 ? 'passed' : 'failed';
}
