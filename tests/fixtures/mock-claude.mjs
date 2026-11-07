import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.MOCK_CLAUDE_LOG) {
  fs.appendFileSync(process.env.MOCK_CLAUDE_LOG, `${JSON.stringify(args)}\n`, 'utf8');
}

const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : 'claude_mock_12345678';
function send(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

send({ type: 'system', subtype: 'init', session_id: sessionId });
send({
  type: 'assistant',
  session_id: sessionId,
  message: {
    content: [
      { type: 'text', text: 'Draft reply' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: 'README.md' } },
    ],
  },
});
send({
  type: 'result',
  subtype: 'success',
  session_id: sessionId,
  result: 'Final reply',
  total_cost_usd: 0.012,
  duration_ms: 123,
});
