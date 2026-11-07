import assert from 'node:assert/strict';
import fs from 'node:fs';
import readline from 'node:readline';

const scenario = process.env.MOCK_ACP_SCENARIO || 'allow';
const expectedPolicy = scenario === 'fallback' ? 'plan-only' : scenario === 'manual' ? 'parent-rein' : 'auto-edit';
let initialized = false;
let sessionId = null;
let promptId = null;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      assert.equal(initialized, false);
      assert.deepEqual(message.params, {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: 'reins', version: '0.1.0' },
      });
      initialized = true;
      send({ id: message.id, result: { protocolVersion: 1 } });
      return;
    }

    assert.equal(initialized, true);
    if (message.method === 'session/load') {
      assert.equal(message.params.sessionId, 'dsh_previous');
      assert.deepEqual(message.params.mcpServers, []);
      if (scenario === 'fallback') {
        send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
      } else {
        sessionId = message.params.sessionId;
        send({ id: message.id, result: { sessionId } });
      }
      return;
    }

    if (message.method === 'session/new') {
      assert.deepEqual(message.params.mcpServers, []);
      assert.equal(typeof message.params.cwd, 'string');
      assert.deepEqual(message.params._meta, {
        ephemeral: scenario === 'fallback',
        reinPolicy: expectedPolicy,
      });
      sessionId = scenario === 'fallback' ? 'dsh_replacement' : 'dsh_session_1';
      send({ id: message.id, result: { sessionId } });
      return;
    }

    if (message.method === 'session/prompt') {
      assert.equal(message.params.sessionId, sessionId);
      assert.equal(message.params.prompt.length, 1);
      assert.equal(message.params.prompt[0].type, 'text');
      promptId = message.id;
      if (scenario === 'cancel') {
        send({ method: 'session/update', params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'waiting' } },
        } });
        return;
      }
      send({ method: 'session/update', params: {
        sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      } });
      send({ method: 'session/update', params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
      } });
      send({ method: 'session/update', params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call', toolCallId: 'tool_1', title: 'Read file',
          content: { type: 'text', text: 'tool details' },
        },
      } });
      send({ id: 900, method: 'session/request_permission', params: {
        sessionId,
        toolCall: { title: 'Read file' },
        options: [
          { optionId: 'deny', kind: 'disallow_once' },
          { optionId: 'allow', kind: 'allow_once' },
        ],
      } });
      return;
    }

    if (message.method === 'session/cancel') {
      assert.equal(message.params.sessionId, sessionId);
      assert.equal(scenario, 'cancel');
      fs.writeFileSync(process.env.MOCK_ACP_CANCEL_FILE, 'received', 'utf8');
      send({ id: promptId, result: { stopReason: 'cancelled' } });
      return;
    }

    if (message.id === 900) {
      assert.deepEqual(message.result, {
        outcome: scenario === 'fallback'
          ? { outcome: 'cancelled' }
          : { outcome: 'selected', optionId: 'allow' },
      });
      send({ method: 'session/update', params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
      } });
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }

    throw new Error(`Unexpected ACP message: ${line}`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  }
});
