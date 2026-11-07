import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.MOCK_DSH_LOG) {
  fs.appendFileSync(process.env.MOCK_DSH_LOG, `${JSON.stringify(args)}\n`, 'utf8');
}
function send(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
send({ type: 'session', sessionId: 'dsh_mock_headless' });
send({ type: 'thinking', text: 'checking' });
send({ type: 'text', text: 'Draft ' });
send({ type: 'text', text: 'answer' });
send({
  type: 'status', phase: 'step_end',
  usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 1 },
});
if (process.env.MOCK_DSH_ERROR === '1') {
  send({ type: 'status', phase: 'turn_end', reason: { kind: 'error', message: 'Headless failed' } });
} else {
  send({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
  send({ type: 'final', text: 'DSH_TEST_OK' });
}
