// Only the documented Stop continuation shape may cross the hook stdout boundary.
export function continuationResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'decision,reason' || value.decision !== 'block' || typeof value.reason !== 'string' || !value.reason.trim() || Buffer.byteLength(value.reason) > 12000) return null;
  return { decision: 'block', reason: value.reason };
}
if (process.argv[2] === '--filter') {
  setTimeout(() => process.exit(0), 500).unref();
  let input = ''; let oversized = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { if (input.length + chunk.length > 16000) { oversized = true; input = ''; } else if (!oversized) input += chunk; });
  process.stdin.on('end', () => {
    try {
      if (oversized || process.argv[3] !== 'claude' || process.env.JOURNAL_CONTINUATION_ENABLED !== '1') return;
      const response = continuationResponse(JSON.parse(input)); if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch { /* Malformed output is neutral. */ }
  });
}
