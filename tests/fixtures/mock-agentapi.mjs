import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const home = process.env.MOCK_AGENTAPI_HOME;
const sessionId = args[0] === 'send-message' ? args[1] : 'agy_mock_123';
const transcript = path.join(home, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
fs.mkdirSync(path.dirname(transcript), { recursive: true });
if (process.env.MOCK_AGENTAPI_LOG) {
  fs.appendFileSync(process.env.MOCK_AGENTAPI_LOG, `${JSON.stringify(args)}\n`, 'utf8');
}
if (args[0] === 'new-conversation') {
  fs.mkdirSync(path.join(home, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(home, 'annotations'), { recursive: true });
  fs.writeFileSync(path.join(home, 'conversations', `${sessionId}.pb`), 'conversation');
  fs.writeFileSync(path.join(home, 'annotations', `${sessionId}.pbtxt`), 'annotation');
}
function step(value) {
  fs.appendFileSync(transcript, `${JSON.stringify(value)}\n`, 'utf8');
}
step({ step_index: 1, type: 'USER_INPUT', status: 'DONE', content: args.at(-1) });
if (process.env.MOCK_AGENTAPI_ERROR === '1') {
  step({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'ERROR', content: 'Planner failed' });
} else {
  step({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Using a tool', tool_calls: [{}] });
  step({
    step_index: 3,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: args[0] === 'send-message' ? 'AGY_SECOND_OK' : 'AGY_TEST_OK',
    thinking: 'checked',
    tool_calls: [],
    input_tokens: 11,
    output_tokens: 3,
    cache_read_tokens: 2,
  });
}
process.stdout.write(JSON.stringify({ response: { newConversation: { conversationId: sessionId } } }));
