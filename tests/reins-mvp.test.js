/**
 * Reins H2H Protocol v0.2 & Codex MVP Test Suite
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPresetPrompt,
  buildResumeCommandHint,
  createInitialTaskSnapshot,
  formatDiagnosticSummary,
  H2H_PROTOCOL_ID,
  mapReinPolicyToCodex,
  normalizeSnapshotEnvelope,
  REASONING_EFFORTS,
  resolveReinPolicy,
  resolveSessionMode,
  truncateUtf8Bytes,
} from '../src/protocol/schema.js';
import { parseCliArgs } from '../src/cli/index.js';
import { advanceTraceOrThrow } from '../src/hub/loop-guard.js';
import { normalizeTargetConfig, parseSimpleYaml, TargetRegistry } from '../src/hub/registry.js';
import { TaskManager } from '../src/hub/task-manager.js';
import { ReinsMcpServer } from '../src/mcp/index.js';
import { AntigravityDriver } from '../src/drivers/antigravity-driver.js';
import { DshDriver } from '../src/drivers/dsh-driver.js';
import { ClaudeCodeDriver } from '../src/drivers/claude-code-driver.js';
import {
  CodexAppServerDriver,
  deriveCodexThreadTitle,
  normalizeCodexPath,
  resolveGitWorktreeRoot,
  syncCodexDesktopCatalog,
} from '../src/drivers/codex-app-server.js';
import { DatabaseSync } from 'node:sqlite';
import { JsonRpcStdioTransport } from '../src/transports/local.js';
import {
  buildPosixCommandLine,
  buildSshArgs,
  createJsonRpcTransport,
  quotePosixShellArg,
  SshStdioTransport,
} from '../src/transports/ssh.js';

test('SSH shell quoting preserves empty values, quotes, and metacharacters', () => {
  assert.equal(quotePosixShellArg(''), "''");
  assert.equal(quotePosixShellArg('plain text'), "'plain text'");
  assert.equal(quotePosixShellArg("a'b;$(echo unsafe)"), "'a'\"'\"'b;$(echo unsafe)'");
});

test('SSH arguments include connection settings and destination', () => {
  assert.deepEqual(
    buildSshArgs({ host: 'example.org', user: 'agent', port: 2222, identityFile: '/key file', connectTimeoutSec: 15 }, 'echo ready'),
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-p', '2222', '-i', '/key file', 'agent@example.org', 'echo ready'],
  );
  assert.deepEqual(
    buildSshArgs({ sshHost: 'faex1' }, 'pwd'),
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'faex1', 'pwd'],
  );
  assert.throws(() => buildSshArgs({ host: '-oProxyCommand=bad' }, 'pwd'), /valid host/);
});

test('SSH command line quotes cwd and arguments and exports valid variables', () => {
  assert.equal(
    buildPosixCommandLine('codex', ['app-server', "a'b;$(touch bad)"], '/work/my repo', {
      REINS_TRACE: "hop'1",
      REINS_EMPTY: '',
      OTHER_SECRET: 'local-only',
    }),
    "cd '/work/my repo' && export REINS_TRACE='hop'\"'\"'1' REINS_EMPTY='' OTHER_SECRET='local-only' && 'codex' 'app-server' 'a'\"'\"'b;$(touch bad)'",
  );
  assert.equal(buildPosixCommandLine('codex', ['--help']), "'codex' '--help'");
  assert.equal(
    buildPosixCommandLine('dsh', [], undefined, { PATH: '/bin', NARB_DISABLE_NATIVE_CACHE: '1' }, { closeStdin: true }),
    "export PATH='/bin' NARB_DISABLE_NATIVE_CACHE='1' && 'dsh' < /dev/null",
  );
  assert.throws(
    () => buildPosixCommandLine('codex', [], undefined, { 'REINS_BAD;echo': 'x' }),
    /Invalid remote environment variable name/,
  );
});

test('JSON-RPC transport factory selects SSH or local subprocess', () => {
  const options = { command: 'codex', args: ['app-server', '--stdio'], cwd: '/remote/repo' };
  const remote = createJsonRpcTransport({ ...options, transportConfig: { kind: 'ssh', host: 'faex1' } });
  assert.ok(remote instanceof SshStdioTransport);
  assert.equal(remote.command, 'ssh');
  assert.equal(remote.args.at(-1), "cd '/remote/repo' && 'codex' 'app-server' '--stdio'");

  const local = createJsonRpcTransport({ ...options, transportConfig: { type: 'local' } });
  assert.ok(local instanceof JsonRpcStdioTransport);
  assert.equal(local.command, 'codex');
});

test('Antigravity driver handles persistent, resumed, and ephemeral turns', async () => {
  const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-agy-test-'));
  const traceKeys = ['REINS_TRACE_ID', 'REINS_HOP_COUNT', 'REINS_MAX_HOPS', 'REINS_CALL_CHAIN'];
  const inheritedTrace = Object.fromEntries(traceKeys.map((key) => [key, process.env[key]]));
  for (const key of traceKeys) delete process.env[key];

  try {
    const mockScript = `
      const args = process.argv.slice(1);
      const conversationIndex = args.indexOf('--conversation');
      const sessionId = conversationIndex >= 0 ? args[conversationIndex + 1] : 'agy_native_001';
      const result = { text: JSON.stringify({ args }) };
      if (!args.includes('--ephemeral')) result.sessionId = sessionId;
      process.stdout.write(JSON.stringify(result));
    `;
    const registry = new TargetRegistry({
      configOverride: {
        hub: { maxHops: 4, defaultTimeoutSec: 10 },
        targets: {
          'mock-agy': {
            kind: 'antigravity',
            driver: 'agy-cli',
            transport: { type: 'local' },
            command: process.execPath,
            args: ['-e', mockScript, '--'],
            defaultCwd: process.cwd(),
            defaultPolicy: 'auto-edit',
            defaultSessionMode: 'persistent',
          },
        },
      },
    });
    const manager = new TaskManager({ registry, stateDir: tempStateDir });
    assert.ok(manager.getDriver(registry.getTargetOrThrow('mock-agy')) instanceof AntigravityDriver);

    const first = await manager.delegate({ targetId: 'mock-agy', prompt: 'First turn', sessionMode: 'persistent' });
    assert.equal(first.status, 'completed');
    assert.equal(first.stopReason, 'end_turn');
    assert.equal(first.sessionId, 'agy_native_001');
    assert.equal(first.resumeCommandHint, 'agy --conversation agy_native_001');
    assert.equal(first.metrics.turnCount, 1);
    assert.ok(first.metrics.durationMs >= 0);
    assert.deepEqual(first.transcript.messages.map((event) => event.role), ['user', 'assistant']);
    const firstArgs = JSON.parse(first.output).args;
    assert.equal(firstArgs[firstArgs.indexOf('--prompt') + 1], 'First turn');
    assert.ok(firstArgs.includes('--allow-write'));
    assert.ok(firstArgs.includes('--allow-exec'));
    assert.ok(!firstArgs.includes('--conversation'));

    const second = await manager.steer(first.taskId, { action: 'reply', message: 'Second turn' });
    assert.equal(second.status, 'completed');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.metrics.turnCount, 2);
    assert.deepEqual(second.transcript.messages.map((event) => event.role), ['user', 'assistant', 'user', 'assistant']);
    const secondArgs = JSON.parse(second.output).args;
    assert.equal(secondArgs[secondArgs.indexOf('--prompt') + 1], 'Second turn');
    assert.equal(secondArgs[secondArgs.indexOf('--conversation') + 1], 'agy_native_001');

    const ephemeral = await manager.delegate({
      targetId: 'mock-agy',
      prompt: 'Inspect only',
      sessionMode: 'ephemeral',
      reinPolicy: 'plan-only',
    });
    assert.equal(ephemeral.status, 'completed');
    assert.match(ephemeral.sessionId, /^agy_[0-9a-f-]+$/);
    assert.equal(ephemeral.resumeCommandHint, null);
    const ephemeralArgs = JSON.parse(ephemeral.output).args;
    assert.ok(ephemeralArgs.includes('--ephemeral'));
    assert.ok(ephemeralArgs.includes('--read-only'));
    assert.ok(!ephemeralArgs.includes('--allow-write'));
    await assert.rejects(
      manager.steer(ephemeral.taskId, { action: 'reply', message: 'Again' }),
      /ephemeral mode/,
    );
  } finally {
    for (const key of traceKeys) {
      if (inheritedTrace[key] === undefined) delete process.env[key];
      else process.env[key] = inheritedTrace[key];
    }
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  }
});

test('Antigravity driver reports process failures and aborts active turns', async () => {
  const failedDriver = new AntigravityDriver({
    driver: 'agy-cli',
    command: process.execPath,
    args: ['-e', 'process.stderr.write("bridge failed"); process.exit(7)', '--'],
  });
  const failedSnapshot = createInitialTaskSnapshot({
    taskId: 'agy-failed', targetId: 'mock-agy', kind: 'antigravity', sessionMode: 'persistent',
  });
  await failedDriver.runTurn(failedSnapshot, { prompt: 'Fail' });
  assert.equal(failedSnapshot.status, 'failed');
  assert.equal(failedSnapshot.stopReason, 'error');
  assert.match(failedSnapshot.error, /bridge failed/);

  const slowDriver = new AntigravityDriver({
    driver: 'agy-cli',
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.stdout.write("late"), 10000)', '--'],
  });
  const slowSnapshot = createInitialTaskSnapshot({
    taskId: 'agy-aborted', targetId: 'mock-agy', kind: 'antigravity', sessionMode: 'persistent',
  });
  const turn = slowDriver.runTurn(slowSnapshot, { prompt: 'Wait' });
  assert.deepEqual(await slowDriver.steerLive(slowSnapshot.taskId, { action: 'interrupt' }), { handledLive: true });
  await turn;
  assert.equal(slowSnapshot.status, 'aborted');
  assert.equal(slowSnapshot.stopReason, 'aborted');
});

test('Antigravity agentapi reads transcript and preserves persistent conversations', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-agentapi-'));
  try {
    const logPath = path.join(home, 'calls.jsonl');
    const driver = new AntigravityDriver({
      driver: 'agentapi',
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-agentapi.mjs')],
      antigravityHome: home,
      env: { MOCK_AGENTAPI_HOME: home, MOCK_AGENTAPI_LOG: logPath },
    });
    const snapshot = createInitialTaskSnapshot({
      taskId: 'agy-agentapi', targetId: 'mock-agy', kind: 'antigravity',
      sessionMode: 'persistent', reinPolicy: 'auto-edit', model: 'flash_lite', cwd: process.cwd(),
    });
    await driver.runTurn(snapshot, { prompt: 'First message' });
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.sessionId, 'agy_mock_123');
    assert.equal(snapshot.output, 'AGY_TEST_OK');
    assert.equal(snapshot.commentary, 'checked');
    assert.deepEqual(snapshot.metrics.tokens, { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 });
    assert.equal(snapshot.resumeCommandHint, 'agy --conversation agy_mock_123');
    assert.ok(fs.existsSync(path.join(home, 'conversations', 'agy_mock_123.pb')));

    await driver.runTurn(snapshot, { prompt: 'Second message' });
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.output, 'AGY_SECOND_OK');
    assert.equal(snapshot.metrics.turnCount, 2);
    const calls = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(calls[0].slice(0, 3), ['new-conversation', '--model=flash_lite', '--title=Reins H2H Task']);
    assert.deepEqual(calls[1].slice(0, 2), ['send-message', 'agy_mock_123']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Antigravity agentapi removes ephemeral files and reports planner errors', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-agentapi-ephemeral-'));
  try {
    const config = {
      driver: 'agentapi', command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-agentapi.mjs')],
      antigravityHome: home,
      env: { MOCK_AGENTAPI_HOME: home },
    };
    const ephemeral = createInitialTaskSnapshot({
      taskId: 'agy-ephemeral', targetId: 'mock-agy', kind: 'antigravity',
      sessionMode: 'ephemeral', cwd: process.cwd(),
    });
    await new AntigravityDriver(config).runTurn(ephemeral, { prompt: 'One shot' });
    assert.equal(ephemeral.status, 'completed');
    assert.equal(ephemeral.resumeCommandHint, undefined);
    assert.ok(!fs.existsSync(path.join(home, 'brain', ephemeral.sessionId)));
    assert.ok(!fs.existsSync(path.join(home, 'conversations', `${ephemeral.sessionId}.pb`)));
    assert.ok(!fs.existsSync(path.join(home, 'annotations', `${ephemeral.sessionId}.pbtxt`)));

    const failed = createInitialTaskSnapshot({
      taskId: 'agy-error', targetId: 'mock-agy', kind: 'antigravity',
      sessionMode: 'ephemeral', cwd: process.cwd(),
    });
    await new AntigravityDriver({
      ...config, env: { MOCK_AGENTAPI_HOME: home, MOCK_AGENTAPI_ERROR: '1' },
    }).runTurn(failed, { prompt: 'Fail' });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Planner failed/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('DSH ACP driver handshakes, streams updates, and selects permission', async () => {
  const driver = new DshDriver({
    driver: 'acp',
    command: process.execPath,
    args: [path.resolve('tests/fixtures/mock-acp.mjs')],
    transport: { type: 'local' },
    env: { MOCK_ACP_SCENARIO: 'allow' },
  });
  const snapshot = createInitialTaskSnapshot({
    taskId: 'dsh-auto', targetId: 'mock-dsh', kind: 'dsh',
    sessionMode: 'persistent', reinPolicy: 'auto-edit', cwd: process.cwd(),
  });
  await driver.runTurn(snapshot, { prompt: 'Inspect the repository' });
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.stopReason, 'end_turn');
  assert.equal(snapshot.sessionId, 'dsh_session_1');
  assert.equal(snapshot.resumeCommandHint, 'dsh --session dsh_session_1');
  assert.equal(snapshot.output, 'Hello world');
  assert.equal(snapshot.commentary, 'thinking');
  assert.equal(snapshot.metrics.turnCount, 1);
  assert.ok(snapshot.metrics.durationMs >= 0);
  assert.deepEqual(snapshot.transcript.messages.map((event) => event.role), ['user', 'tool', 'assistant']);
  assert.equal(snapshot.transcript.messages[1].toolCall.toolCallId, 'tool_1');
});

test('DSH ACP driver pauses for approval and resumes the prompt', async () => {
  const driver = new DshDriver({
    driver: 'acp-stdio',
    command: process.execPath,
    args: [path.resolve('tests/fixtures/mock-acp.mjs')],
    env: { MOCK_ACP_SCENARIO: 'manual' },
  });
  const snapshot = createInitialTaskSnapshot({
    taskId: 'dsh-manual', targetId: 'mock-dsh', kind: 'dsh',
    sessionMode: 'persistent', reinPolicy: 'parent-rein', cwd: process.cwd(),
  });
  let resolveAttention;
  const attention = new Promise((resolve) => { resolveAttention = resolve; });
  const turn = driver.runTurn(snapshot, { prompt: 'Read a file' }, (updated) => {
    if (updated.status === 'attention_required') resolveAttention();
  });
  try {
    await attention;
    assert.equal(snapshot.attention.method, 'session/request_permission');
    assert.equal(snapshot.status, 'attention_required');
    assert.deepEqual(await driver.steerLive(snapshot.taskId, { action: 'approve' }), { handledLive: true });
    await turn;
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.attention, undefined);
    assert.equal(snapshot.output, 'Hello world');
  } finally {
    await driver.abort(snapshot.taskId);
  }
});

test('DSH ACP driver replaces unsupported sessions and cancels plan-only permissions', async () => {
  const driver = new DshDriver({
    driver: 'dsh-sdk',
    command: process.execPath,
    args: [path.resolve('tests/fixtures/mock-acp.mjs')],
    env: { MOCK_ACP_SCENARIO: 'fallback' },
  });
  const snapshot = createInitialTaskSnapshot({
    taskId: 'dsh-fallback', targetId: 'mock-dsh', kind: 'dsh',
    sessionId: 'dsh_previous', sessionMode: 'ephemeral', reinPolicy: 'plan-only', cwd: process.cwd(),
  });
  await driver.runTurn(snapshot, { prompt: 'Review only' });
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.sessionId, 'dsh_replacement');
  assert.equal(snapshot.resumeCommandHint, undefined);
  assert.equal(snapshot.output, 'Hello world');
});

test('DSH ACP driver sends session/cancel when interrupted', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-dsh-cancel-'));
  const cancelFile = path.join(tempDir, 'cancelled.txt');
  const driver = new DshDriver({
    driver: 'acp',
    command: process.execPath,
    args: [path.resolve('tests/fixtures/mock-acp.mjs')],
    env: { MOCK_ACP_SCENARIO: 'cancel', MOCK_ACP_CANCEL_FILE: cancelFile },
  });
  const snapshot = createInitialTaskSnapshot({
    taskId: 'dsh-cancel', targetId: 'mock-dsh', kind: 'dsh',
    sessionMode: 'persistent', reinPolicy: 'auto-edit', cwd: process.cwd(),
  });
  let resolveWaiting;
  const waiting = new Promise((resolve) => { resolveWaiting = resolve; });
  const turn = driver.runTurn(snapshot, { prompt: 'Wait' }, (updated) => {
    if (updated.output === 'waiting') resolveWaiting();
  });
  try {
    await waiting;
    assert.deepEqual(await driver.steerLive(snapshot.taskId, { action: 'interrupt' }), { handledLive: true });
    await turn;
    assert.equal(fs.readFileSync(cancelFile, 'utf8'), 'received');
    assert.equal(snapshot.status, 'aborted');
    assert.equal(snapshot.stopReason, 'aborted');
  } finally {
    await driver.abort(snapshot.taskId);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('DSH headless parses JSONL events, session flags, and errors', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-dsh-headless-'));
  try {
    const logPath = path.join(tempDir, 'calls.jsonl');
    const config = {
      driver: 'dsh-headless', command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-dsh-headless.mjs')],
      env: { MOCK_DSH_LOG: logPath },
    };
    const snapshot = createInitialTaskSnapshot({
      taskId: 'dsh-headless', targetId: 'mock-dsh', kind: 'dsh',
      sessionId: 'dsh_previous', sessionMode: 'ephemeral', cwd: process.cwd(),
    });
    await new DshDriver(config).runTurn(snapshot, { prompt: 'Headless test' });
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.sessionId, 'dsh_mock_headless');
    assert.equal(snapshot.resumeCommandHint, undefined);
    assert.equal(snapshot.output, 'DSH_TEST_OK');
    assert.equal(snapshot.commentary, 'checking');
    assert.deepEqual(snapshot.metrics.tokens, { inputTokens: 7, outputTokens: 4, cacheReadTokens: 1 });
    const args = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.deepEqual(args.slice(-6), ['--profile', 'headless', '--json', '--session-id', 'dsh_previous', 'Headless test']);

    const failed = createInitialTaskSnapshot({
      taskId: 'dsh-headless-failed', targetId: 'mock-dsh', kind: 'dsh',
      sessionMode: 'persistent', cwd: process.cwd(),
    });
    await new DshDriver({ ...config, env: { MOCK_DSH_ERROR: '1' } }).runTurn(failed, { prompt: 'Fail' });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Headless failed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('TaskManager registers DSH driver modes and kind fallback', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-dsh-registry-'));
  try {
    const manager = new TaskManager({ stateDir });
    for (const driverName of ['acp', 'acp-stdio', 'dsh-sdk', 'custom']) {
      assert.ok(manager.getDriver({
        id: `dsh-${driverName}`,
        kind: 'dsh',
        driver: driverName,
      }) instanceof DshDriver);
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Claude Code print mode parses stream-json and resumes persistent sessions', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-claude-print-'));
  try {
    const logPath = path.join(tempDir, 'claude.jsonl');
    const driver = new ClaudeCodeDriver({
      driver: 'claude-print',
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-claude.mjs')],
      env: { MOCK_CLAUDE_LOG: logPath },
    });
    const snapshot = createInitialTaskSnapshot({
      taskId: 'claude-print', targetId: 'mock-claude', kind: 'claude-code',
      sessionId: 'claude_previous', sessionMode: 'persistent', reinPolicy: 'free-rein', cwd: process.cwd(),
    });
    await driver.runTurn(snapshot, { prompt: 'Review the code' });
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.stopReason, 'end_turn');
    assert.equal(snapshot.sessionId, 'claude_previous');
    assert.equal(snapshot.resumeCommandHint, 'claude --resume claude_previous');
    assert.equal(snapshot.output, 'Final reply');
    assert.equal(snapshot.metrics.costUsd, 0.012);
    assert.equal(snapshot.metrics.durationMs, 123);
    assert.equal(snapshot.metrics.turnCount, 1);
    assert.deepEqual(snapshot.transcript.messages.map((event) => event.role), ['user', 'tool', 'assistant']);
    const args = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(args[args.indexOf('-p') + 1], 'Review the code');
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(args.includes('--verbose'));
    assert.equal(args[args.indexOf('--resume') + 1], 'claude_previous');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.ok(!args.includes('--no-session-persistence'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude Code maps ReinPolicy flags and keeps ephemeral tmux tasks one-shot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-claude-policy-'));
  try {
    const logPath = path.join(tempDir, 'claude.jsonl');
    const driver = new ClaudeCodeDriver({
      driver: 'claude-tmux',
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-claude.mjs')],
      tmuxCommand: 'missing-tmux-command',
      env: { MOCK_CLAUDE_LOG: logPath },
    });
    const modes = [
      ['auto-edit', 'acceptEdits'],
      ['plan-only', 'plan'],
      ['parent-rein', 'default'],
      ['tight-rein', 'default'],
    ];
    for (const [reinPolicy, expectedMode] of modes) {
      const snapshot = createInitialTaskSnapshot({
        taskId: `claude-${reinPolicy}`, targetId: 'mock-claude', kind: 'claude-code',
        sessionMode: 'ephemeral', reinPolicy, cwd: process.cwd(),
      });
      await driver.runTurn(snapshot, { prompt: 'One-shot review' });
      assert.equal(snapshot.status, 'completed');
      assert.equal(snapshot.resumeCommandHint, undefined);
      assert.equal(snapshot.tmuxSession, undefined);
      const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
      const args = JSON.parse(lines.at(-1));
      assert.ok(args.includes('--no-session-persistence'));
      assert.equal(args[args.indexOf('--permission-mode') + 1], expectedMode);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude Code persistent tmux mode creates a resumable session and sends keys', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-claude-tmux-'));
  try {
    const tmuxLog = path.join(tempDir, 'tmux.jsonl');
    const driver = new ClaudeCodeDriver({
      driver: 'claude-tmux',
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-claude.mjs')],
      tmuxCommand: process.execPath,
      tmuxArgs: [path.resolve('tests/fixtures/mock-tmux.mjs')],
      tmuxPrefix: 'reins-test',
      env: {
        MOCK_TMUX_LOG: tmuxLog,
        MOCK_TMUX_SESSION: path.join(tempDir, 'session'),
      },
    });
    const snapshot = createInitialTaskSnapshot({
      taskId: 'claude-tmux', targetId: 'mock-claude', kind: 'claude-code',
      sessionMode: 'persistent', reinPolicy: 'parent-rein', cwd: process.cwd(),
    });
    await driver.runTurn(snapshot, { prompt: 'Persistent work' });
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.sessionId, 'claude_mock_12345678');
    assert.match(snapshot.tmuxSession, /^reins-test-/);
    assert.equal(snapshot.resumeCommandHint, `tmux attach -t ${snapshot.tmuxSession}`);
    assert.deepEqual(await driver.steerLive(snapshot.taskId, { action: 'approve' }), { handledLive: true });
    assert.deepEqual(await driver.steerLive(snapshot.taskId, { action: 'reject' }), { handledLive: true });
    assert.deepEqual(await driver.steerLive(snapshot.taskId, { action: 'reply', message: 'Next' }), { handledLive: false });
    assert.equal(await driver.abort(snapshot.taskId), true);
    const calls = fs.readFileSync(tmuxLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(calls[0][0], 'has-session');
    assert.equal(calls[1][0], 'new-session');
    assert.match(calls[1].at(-1), /'--resume' 'claude_mock_12345678'/);
    assert.deepEqual(calls.slice(2).map((call) => call.slice(-2)), [
      ['y', 'Enter'], ['n', 'Enter'], [`=${snapshot.tmuxSession}`, 'C-c'],
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude Code tmux replies resume through TaskManager after restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-claude-steer-'));
  const traceKeys = ['REINS_TRACE_ID', 'REINS_HOP_COUNT', 'REINS_MAX_HOPS', 'REINS_CALL_CHAIN'];
  const inheritedTrace = Object.fromEntries(traceKeys.map((key) => [key, process.env[key]]));
  for (const key of traceKeys) delete process.env[key];
  try {
    const claudeLog = path.join(tempDir, 'claude.jsonl');
    const tmuxLog = path.join(tempDir, 'tmux.jsonl');
    const target = normalizeTargetConfig('mock-claude', {
      kind: 'claude-code',
      driver: { mode: 'claude-tmux', tmuxPrefix: 'reins-restart' },
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-claude.mjs')],
      tmuxCommand: process.execPath,
      tmuxArgs: [path.resolve('tests/fixtures/mock-tmux.mjs')],
      transport: { type: 'local' },
      defaultCwd: process.cwd(),
      defaultPolicy: 'auto-edit',
      defaultSessionMode: 'persistent',
      env: {
        MOCK_CLAUDE_LOG: claudeLog,
        MOCK_TMUX_LOG: tmuxLog,
        MOCK_TMUX_SESSION: path.join(tempDir, 'session'),
      },
    });
    assert.equal(target.tmuxPrefix, 'reins-restart');
    assert.equal(target.tmuxSession, undefined);
    const registry = new TargetRegistry({
      configOverride: { hub: { maxHops: 4, defaultTimeoutSec: 10 }, targets: { 'mock-claude': target } },
    });
    const manager = new TaskManager({ registry, stateDir: tempDir });
    const first = await manager.delegate({ targetId: 'mock-claude', prompt: 'First turn' });
    assert.equal(first.status, 'completed');

    const restartedManager = new TaskManager({ registry, stateDir: tempDir });
    const second = await restartedManager.steer(first.taskId, { action: 'reply', message: 'Second turn' });
    assert.equal(second.status, 'completed');
    assert.equal(second.metrics.turnCount, 2);
    assert.equal(second.metrics.costUsd, 0.024);
    assert.equal(second.tmuxSession, first.tmuxSession);
    const claudeCalls = fs.readFileSync(claudeLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(claudeCalls.length, 2);
    assert.equal(claudeCalls[1][claudeCalls[1].indexOf('--resume') + 1], first.sessionId);
    assert.equal(claudeCalls[1][claudeCalls[1].indexOf('-p') + 1], 'Second turn');
    const tmuxCalls = fs.readFileSync(tmuxLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(tmuxCalls.filter((call) => call[0] === 'new-session').length, 1);

    const interrupted = await restartedManager.steer(first.taskId, { action: 'interrupt' });
    assert.equal(interrupted.status, 'aborted');
    assert.equal(interrupted.stopReason, 'aborted');
    const finalTmuxCalls = fs.readFileSync(tmuxLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(finalTmuxCalls.at(-1).slice(-2), [`=${first.tmuxSession}`, 'C-c']);
  } finally {
    for (const key of traceKeys) {
      if (inheritedTrace[key] === undefined) delete process.env[key];
      else process.env[key] = inheritedTrace[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('TaskManager registers Claude Code driver modes and kind fallback', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-claude-registry-'));
  try {
    const manager = new TaskManager({ stateDir });
    for (const driverName of ['claude-tmux', 'claude-print', 'claude-cli', 'custom']) {
      assert.ok(manager.getDriver({
        id: `claude-${driverName}`,
        kind: 'claude-code',
        driver: driverName,
      }) instanceof ClaudeCodeDriver);
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('H2H Schema: sessionMode and reinPolicy heuristics', () => {
  // Default task delegates to persistent
  assert.equal(resolveSessionMode({ preset: 'task' }), 'persistent');
  // Review and adversarial-review default to ephemeral so they do not clutter user sessions
  assert.equal(resolveSessionMode({ preset: 'review' }), 'ephemeral');
  assert.equal(resolveSessionMode({ preset: 'adversarial-review' }), 'ephemeral');
  // Explicit override wins over preset default
  assert.equal(
    resolveSessionMode({ requestedMode: 'persistent', preset: 'review' }),
    'persistent',
  );

  // ReinPolicy resolution
  assert.equal(resolveReinPolicy({ preset: 'review' }), 'plan-only');
  assert.equal(resolveReinPolicy({ preset: 'task', targetDefaultPolicy: 'auto-edit' }), 'auto-edit');
  assert.deepEqual(mapReinPolicyToCodex('free-rein'), {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  assert.deepEqual(mapReinPolicyToCodex('plan-only'), {
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
});

test('H2H Schema: resumeCommandHint and preset prompt framing', () => {
  assert.equal(
    buildResumeCommandHint({
      kind: 'codex',
      sessionId: 'thr_123',
      sessionMode: 'persistent',
      transportType: 'local',
    }),
    'codex resume thr_123',
  );

  assert.equal(
    buildResumeCommandHint({
      kind: 'codex',
      sessionId: 'thr_123',
      sessionMode: 'ephemeral',
      transportType: 'local',
    }),
    undefined,
  );

  assert.equal(
    buildResumeCommandHint({
      kind: 'claude-code',
      sessionId: 'ses_abc',
      sessionMode: 'persistent',
      transportType: 'ssh',
      sshHost: 'faex1',
      tmuxSession: 'reins-claude',
    }),
    'ssh -t faex1 "tmux attach -t reins-claude"',
  );

  const reviewFramed = applyPresetPrompt('Check auth.js', 'review');
  assert.match(reviewFramed, /Code Review \(Read-Only\)/);
  assert.match(reviewFramed, /Check auth\.js/);
});

test('Loop Guard: enforces maxHops and prevents circular target delegation', () => {
  const step1 = advanceTraceOrThrow({
    targetId: 'local-codex',
    env: {},
    configuredMaxHops: 2,
  });
  assert.equal(step1.trace.hopCount, 1);
  assert.deepEqual(step1.trace.callChain, ['local-codex']);

  // Direct circular delegation back to local-codex is rejected
  assert.throws(
    () =>
      advanceTraceOrThrow({
        targetId: 'local-codex',
        requestTrace: step1.trace,
        configuredMaxHops: 2,
      }),
    /circular delegation/,
  );

  // Delegation to a second target succeeds at hop 2
  const step2 = advanceTraceOrThrow({
    targetId: 'faex1-dsh',
    requestTrace: step1.trace,
    configuredMaxHops: 2,
  });
  assert.equal(step2.trace.hopCount, 2);

  // Hop 3 exceeds maxHops (2)
  assert.throws(
    () =>
      advanceTraceOrThrow({
        targetId: 'faex1-claude',
        requestTrace: step2.trace,
        configuredMaxHops: 2,
      }),
    /exceeds maxHops/,
  );
});

test('TargetRegistry: parses YAML config and lists targets', () => {
  const sampleYaml = `
version: "0.2.0"
hub:
  port: 19420
  maxHops: 4
targets:
  local-codex:
    kind: codex
    driver: codex-app-server
    defaultSessionMode: persistent
    defaultPolicy: auto-edit
`;
  const parsed = parseSimpleYaml(sampleYaml);
  assert.equal(parsed.version, '0.2.0');
  assert.equal(parsed.hub.port, 19420);
  assert.equal(parsed.targets['local-codex'].kind, 'codex');

  const registry = new TargetRegistry();
  const targets = registry.listTargets();
  assert.ok(targets.some((t) => t.id === 'local-codex' && t.kind === 'codex'));
});

test('TaskManager & ReinsMcpServer: end-to-end lifecycle with mock driver', async () => {
  const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-test-'));
  const traceKeys = ['REINS_TRACE_ID', 'REINS_HOP_COUNT', 'REINS_MAX_HOPS', 'REINS_CALL_CHAIN'];
  const inheritedTrace = Object.fromEntries(traceKeys.map((key) => [key, process.env[key]]));
  for (const key of traceKeys) delete process.env[key];

  try {
    const mockDriver = {
      async runTurn(snapshot, { prompt }, onUpdate) {
        snapshot.status = 'running';
        snapshot.sessionId = snapshot.sessionId || 'thr_mock_001';
        snapshot.resumeCommandHint =
          snapshot.sessionMode === 'persistent'
            ? `codex resume ${snapshot.sessionId}`
            : undefined;
        onUpdate(snapshot);

        snapshot.status = 'completed';
        snapshot.stopReason = 'end_turn';
        snapshot.output = `Echo(${snapshot.sessionMode}): ${prompt}`;
        snapshot.metrics.turnCount += 1;
        onUpdate(snapshot);
        return snapshot;
      },
      async steerLive() {
        return { handledLive: false };
      },
      async abort() {
        return true;
      },
    };

    const taskManager = new TaskManager({
      stateDir: tempStateDir,
      driverOverrides: {
        'codex-app-server': mockDriver,
      },
    });

    const mcp = new ReinsMcpServer({ taskManager });

    // 1. tools/list
    const listRes = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    assert.equal(listRes.result.tools.length, 5);

    // 2. Delegate in persistent mode
    const delRes = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'reins_delegate',
        arguments: {
          targetId: 'local-codex',
          prompt: 'Hello persistent world',
          sessionMode: 'persistent',
        },
      },
    });
    const snap1 = JSON.parse(delRes.result.content[0].text);
    assert.equal(snap1.status, 'completed');
    assert.equal(snap1.sessionMode, 'persistent');
    assert.equal(snap1.sessionId, 'thr_mock_001');
    assert.equal(snap1.resumeCommandHint, 'codex resume thr_mock_001');
    assert.match(snap1.output, /Hello persistent world/);

    // 3. Steer reply (multi-turn continuation on persistent session)
    const steerRes = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'reins_steer',
        arguments: {
          taskId: snap1.taskId,
          action: 'reply',
          message: 'Follow-up turn 2',
        },
      },
    });
    const snap2 = JSON.parse(steerRes.result.content[0].text);
    assert.equal(snap2.status, 'completed');
    assert.equal(snap2.metrics.turnCount, 2);
    assert.match(snap2.output, /Follow-up turn 2/);

    // 4. Delegate in ephemeral mode
    const ephRes = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'reins_delegate',
        arguments: {
          targetId: 'local-codex',
          prompt: 'Quick export check',
          sessionMode: 'ephemeral',
        },
      },
    });
    const snapEph = JSON.parse(ephRes.result.content[0].text);
    assert.equal(snapEph.sessionMode, 'ephemeral');
    assert.equal(snapEph.resumeCommandHint, null);
  } finally {
    for (const key of traceKeys) {
      if (inheritedTrace[key] === undefined) delete process.env[key];
      else process.env[key] = inheritedTrace[key];
    }
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  }
});

test('Codex Desktop catalog sync normalizes Windows extended paths and registers persistent threads', async () => {
  assert.equal(
    normalizeCodexPath('\\\\?\\C:\\Users\\ariab\\Desktop\\workspace\\reins'),
    'C:\\Users\\ariab\\Desktop\\workspace\\reins',
  );
  assert.equal(
    deriveCodexThreadTitle('[Reins H2H Preset: coding]\n# Implement Antigravity Driver\nDetails'),
    '[Reins] Implement Antigravity Driver',
  );

  const tempCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-codex-home-'));
  try {
    const stateDbPath = path.join(tempCodexHome, 'state_5.sqlite');
    const sqliteDir = path.join(tempCodexHome, 'sqlite');
    fs.mkdirSync(sqliteDir, { recursive: true });
    const catalogDbPath = path.join(sqliteDir, 'codex.db');
    const rolloutPath = path.join(tempCodexHome, 'rollout-test.jsonl');
    fs.writeFileSync(
      rolloutPath,
      '{"type":"session_meta","payload":{"id":"thr_sync_1","originator":"reins"}}\n',
      'utf8',
    );

    const stateDb = new DatabaseSync(stateDbPath);
    stateDb.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE project_roots (
        project_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (project_id, position)
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT,
        name TEXT,
        git_branch TEXT,
        thread_source TEXT,
        originator TEXT,
        project_id TEXT
      );
    `);
    const workspaceRoot = path.resolve(tempCodexHome, 'workspace-proj');
    stateDb
      .prepare(`INSERT INTO projects (id, name, position, created_at_ms, updated_at_ms) VALUES (?, ?, 0, 1000, 1000)`)
      .run('proj_server_1', 'workspace-proj');
    stateDb
      .prepare(`INSERT INTO project_roots (project_id, position, path) VALUES (?, 0, ?)`)
      .run('proj_server_1', workspaceRoot);
    stateDb
      .prepare(
        `INSERT INTO threads (
           id, rollout_path, created_at, updated_at, source, model_provider,
           cwd, title, name, git_branch, thread_source, originator, project_id
         ) VALUES (?, ?, 1700000000, 1700000010, 'vscode', 'custom', ?, '', NULL, 'main', 'unknown', 'reins', NULL)`,
      )
      .run('thr_sync_1', `\\\\?\\${rolloutPath}`, `\\\\?\\${workspaceRoot}`);
    stateDb.close();

    const catalogDb = new DatabaseSync(catalogDbPath);
    catalogDb.exec(`
      CREATE TABLE local_thread_catalog (
        host_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        display_title TEXT NOT NULL,
        source_created_at INTEGER NOT NULL,
        source_updated_at INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_detail TEXT,
        model_provider TEXT NOT NULL,
        git_branch TEXT,
        observation_sequence INTEGER NOT NULL DEFAULT 0,
        missing_candidate INTEGER NOT NULL DEFAULT 0,
        thread_source TEXT,
        source_recency_at INTEGER NOT NULL DEFAULT 0,
        pending_observed_title INTEGER NOT NULL DEFAULT 0,
        project_id TEXT,
        PRIMARY KEY (host_id, thread_id)
      );
      CREATE TABLE local_thread_catalog_sync_state (
        host_id TEXT PRIMARY KEY,
        watermark_updated_at INTEGER,
        last_full_reconciled_at INTEGER,
        initial_build_complete INTEGER NOT NULL DEFAULT 1,
        observation_sequence INTEGER NOT NULL DEFAULT 5
      );
      INSERT INTO local_thread_catalog_sync_state (host_id, observation_sequence) VALUES ('local', 5);
      CREATE TABLE local_thread_catalog_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        catalog_revision INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO local_thread_catalog_metadata (id, schema_version, catalog_revision) VALUES (1, 1, 10);
    `);
    catalogDb.close();

    const res = await syncCodexDesktopCatalog({
      threadId: 'thr_sync_1',
      cwd: workspaceRoot,
      title: '[Reins] Test Catalog Sync',
      codexHome: tempCodexHome,
      notifyRunningDesktop: false,
    });
    assert.equal(res.syncedStateDb, true);
    assert.equal(res.syncedCatalogDb, true);

    const checkStateDb = new DatabaseSync(stateDbPath);
    const tRow = checkStateDb.prepare(`SELECT * FROM threads WHERE id = 'thr_sync_1'`).get();
    checkStateDb.close();
    assert.equal(tRow.originator, 'Codex Desktop');
    assert.equal(tRow.thread_source, 'user');
    assert.equal(tRow.cwd, workspaceRoot);
    assert.equal(tRow.project_id, 'proj_server_1');
    assert.equal(tRow.title, '[Reins] Test Catalog Sync');
    assert.equal(tRow.name, '[Reins] Test Catalog Sync');

    const checkCatalogDb = new DatabaseSync(catalogDbPath);
    const cRow = checkCatalogDb
      .prepare(`SELECT * FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = 'thr_sync_1'`)
      .get();
    checkCatalogDb.close();
    assert.equal(cRow.display_title, '[Reins] Test Catalog Sync');
    assert.equal(cRow.cwd, workspaceRoot);
    assert.equal(cRow.source_kind, 'vscode');
    assert.equal(cRow.thread_source, 'user');
    assert.equal(cRow.project_id, 'proj_server_1');
    assert.equal(cRow.observation_sequence, 6);

    const patchedRollout = fs.readFileSync(rolloutPath, 'utf8');
    assert.match(patchedRollout, /"originator":"Codex Desktop"/);
  } finally {
    fs.rmSync(tempCodexHome, { recursive: true, force: true });
  }
});

test('Model catalog and reasoning effort selection propagate across CLI, MCP, and TaskManager', async () => {
  assert.ok(REASONING_EFFORTS.includes('low'));
  assert.ok(REASONING_EFFORTS.includes('ultra'));

  const parsedCli = parseCliArgs([
    'delegate',
    'local-codex',
    '--model',
    'gpt-6.1-sol',
    '--effort',
    'high',
    '-p',
    'Build feature',
  ]);
  assert.equal(parsedCli.positionals[0], 'delegate');
  assert.equal(parsedCli.positionals[1], 'local-codex');
  assert.equal(parsedCli.flags.model, 'gpt-6.1-sol');
  assert.equal(parsedCli.flags.effort, 'high');

  const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-models-test-'));
  const traceKeys = ['REINS_TRACE_ID', 'REINS_HOP_COUNT', 'REINS_MAX_HOPS', 'REINS_CALL_CHAIN'];
  const inheritedTrace = Object.fromEntries(traceKeys.map((key) => [key, process.env[key]]));
  for (const key of traceKeys) delete process.env[key];

  try {
    const mockDriver = {
      async listModels() {
        return {
          targetId: 'local-codex',
          kind: 'codex',
          currentConfig: { model: 'gpt-6-sol', effort: 'high', provider: 'custom' },
          models: [
            {
              id: 'gpt-6.1-sol',
              model: 'gpt-6.1-sol',
              displayName: 'GPT-6.1-Sol',
              isDefault: true,
              defaultEffort: 'low',
              supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            },
          ],
        };
      },
      async runTurn(snapshot, { prompt }, onUpdate) {
        snapshot.status = 'completed';
        snapshot.stopReason = 'end_turn';
        snapshot.sessionId = snapshot.sessionId || 'thr_effort_1';
        snapshot.output = `model=${snapshot.model} effort=${snapshot.effort} prompt=${prompt}`;
        snapshot.metrics.turnCount += 1;
        onUpdate(snapshot);
        return snapshot;
      },
      async steerLive() {
        return { handledLive: false };
      },
      async abort() {
        return true;
      },
    };

    const taskManager = new TaskManager({
      stateDir: tempStateDir,
      driverOverrides: {
        'codex-app-server': mockDriver,
      },
    });
    const mcp = new ReinsMcpServer({ taskManager });

    const targetsRes = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'reins_targets',
        arguments: { targetId: 'local-codex', includeModels: true },
      },
    });
    const targetsPayload = JSON.parse(targetsRes.result.content[0].text);
    assert.equal(targetsPayload.modelCatalog.currentConfig.model, 'gpt-6-sol');
    assert.equal(targetsPayload.modelCatalog.currentConfig.effort, 'high');
    assert.equal(targetsPayload.modelCatalog.models[0].id, 'gpt-6.1-sol');

    const delRes = await mcp.handleMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'reins_delegate',
        arguments: {
          targetId: 'local-codex',
          prompt: 'Verify effort',
          sessionMode: 'persistent',
          model: 'gpt-6.1-sol',
          effort: 'xhigh',
        },
      },
    });
    const snap = JSON.parse(delRes.result.content[0].text);
    assert.equal(snap.model, 'gpt-6.1-sol');
    assert.equal(snap.effort, 'xhigh');
    assert.match(snap.diagnostic, /model=gpt-6\.1-sol/);
    assert.match(snap.diagnostic, /effort=xhigh/);
    assert.match(snap.output, /model=gpt-6\.1-sol effort=xhigh/);
  } finally {
    for (const key of traceKeys) {
      if (inheritedTrace[key] === undefined) delete process.env[key];
      else process.env[key] = inheritedTrace[key];
    }
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  }
});

test('H2H Protocol v0.1 conformance invariants: project onboarding, UNC paths, UTF-8 byte cap, and H2H_* headers', async () => {
  assert.equal(H2H_PROTOCOL_ID, 'h2h/v0.1');

  // 1. UNC-safe Windows path canonicalization ([H2H-PROJ-05])
  assert.equal(
    normalizeCodexPath('\\\\?\\UNC\\server\\share\\repo'),
    '\\\\server\\share\\repo',
  );
  assert.equal(
    normalizeCodexPath('\\\\?\\C:\\Users\\ariab\\Desktop\\workspace\\h2h-protocol'),
    'C:\\Users\\ariab\\Desktop\\workspace\\h2h-protocol',
  );

  // 2. Git worktree root resolution from subdirectory ([H2H-PROJ-04])
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'h2h-git-root-'));
  try {
    fs.mkdirSync(path.join(tempRepo, '.git'), { recursive: true });
    const subDir = path.join(tempRepo, 'spec', 'en');
    fs.mkdirSync(subDir, { recursive: true });
    assert.equal(
      resolveGitWorktreeRoot(subDir).toLowerCase(),
      normalizeCodexPath(tempRepo).toLowerCase(),
    );
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  }

  // 3. UTF-8 byte-accurate truncation <= 4096 bytes ([H2H-SNAP-03])
  const cjkError = '错误诊断信息'.repeat(1000); // 18,000 UTF-8 bytes (6,000 chars)
  const snapWithCjk = createInitialTaskSnapshot({
    taskId: 'tsk_utf8_test',
    targetId: 'local-codex',
    kind: 'codex',
    sessionMode: 'ephemeral',
    reinPolicy: 'auto-edit',
    preset: 'task',
    cwd: process.cwd(),
  });
  snapWithCjk.status = 'failed';
  snapWithCjk.stopReason = 'error';
  snapWithCjk.error = cjkError;
  normalizeSnapshotEnvelope(snapWithCjk);
  assert.ok(Buffer.byteLength(snapWithCjk.diagnostic, 'utf8') <= 4096);
  assert.ok(Buffer.byteLength(truncateUtf8Bytes(cjkError, 512), 'utf8') <= 512);

  // 4. H2H_* + REINS_* dual Loop Guard propagation and monotonic maxHops ([H2H-LOOP-01..03])
  const hop1 = advanceTraceOrThrow({
    targetId: 'local-codex',
    env: {
      H2H_TRACE_ID: 'trc_h2h_01',
      H2H_HOP_COUNT: '1',
      H2H_MAX_HOPS: '2',
      H2H_CALL_CHAIN: 'local-agy',
    },
    configuredMaxHops: 5,
  });
  assert.equal(hop1.trace.traceId, 'trc_h2h_01');
  assert.equal(hop1.trace.hopCount, 2);
  assert.equal(hop1.trace.maxHops, 2);
  assert.deepEqual(hop1.trace.callChain, ['local-agy', 'local-codex']);
  assert.equal(hop1.envVars.H2H_TRACE_ID, 'trc_h2h_01');
  assert.equal(hop1.envVars.H2H_HOP_COUNT, '2');
  assert.equal(hop1.envVars.H2H_MAX_HOPS, '2');
  assert.equal(hop1.envVars.H2H_CALL_CHAIN, 'local-agy,local-codex');

  // 5. Pending Codex snapshot preserves null project.root so subdirectory cwd resolves to Git root
  const pendingCodexSnap = createInitialTaskSnapshot({
    taskId: 'tsk_pending_root',
    targetId: 'local-codex',
    kind: 'codex',
    sessionMode: 'persistent',
    reinPolicy: 'auto-edit',
    preset: 'task',
    cwd: 'C:\\Users\\ariab\\Desktop\\workspace\\h2h-protocol\\spec\\en',
  });
  normalizeSnapshotEnvelope(pendingCodexSnap);
  assert.equal(pendingCodexSnap.project.root, null);
  assert.equal(pendingCodexSnap.projectSelector, undefined);

  // 6. Strict auto-edit approval confinement ([H2H-POL-02])
  const codexDriver = new CodexAppServerDriver({ id: 'local-codex', kind: 'codex' });
  const mockRuntime = {
    effectiveProjectRoot: 'C:\\Users\\ariab\\Desktop\\workspace\\h2h-protocol',
    snapshot: pendingCodexSnap,
  };
  assert.equal(
    codexDriver._isWithinWorkspaceForAutoEdit(
      mockRuntime,
      'item/commandExecution/requestApproval',
      { command: 'rm -rf /tmp/outside', cwd: 'C:\\Users\\ariab\\Desktop\\workspace\\h2h-protocol' },
    ),
    false,
  );
  assert.equal(
    codexDriver._isWithinWorkspaceForAutoEdit(
      mockRuntime,
      'item/fileChange/requestApproval',
      {},
    ),
    false,
  );
  assert.equal(
    codexDriver._isWithinWorkspaceForAutoEdit(
      mockRuntime,
      'item/fileChange/requestApproval',
      { changes: [{ path: 'README.md' }] },
    ),
    true,
  );
  assert.equal(
    codexDriver._isWithinWorkspaceForAutoEdit(
      mockRuntime,
      'item/fileChange/requestApproval',
      { changes: [{ path: '..\\outside.txt' }] },
    ),
    false,
  );

  // 7. Foreground wait returns immediately on attention_required and steer(approve) completes ([H2H-PRIM-03])
  const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-attn-test-'));
  const traceKeys = [
    'H2H_TRACE_ID',
    'H2H_HOP_COUNT',
    'H2H_MAX_HOPS',
    'H2H_CALL_CHAIN',
    'REINS_TRACE_ID',
    'REINS_HOP_COUNT',
    'REINS_MAX_HOPS',
    'REINS_CALL_CHAIN',
  ];
  const savedEnv = Object.fromEntries(traceKeys.map((k) => [k, process.env[k]]));
  for (const k of traceKeys) delete process.env[k];
  try {
    let resumeGate = null;
    const gateDriver = {
      async runTurn(snapshot, _opts, onUpdate) {
        snapshot.sessionId = 'thr_attn_01';
        snapshot.project = {
          id: 'proj_attn_01',
          root: snapshot.cwd,
          binding: 'bound',
          mechanism: 'native-id',
        };
        snapshot.status = 'attention_required';
        snapshot.stopReason = 'attention-required';
        snapshot.attention = {
          requestId: 'req_1',
          method: 'item/commandExecution/requestApproval',
          summary: 'Approve command',
          createdAt: new Date().toISOString(),
        };
        onUpdate(snapshot);
        const approved = await new Promise((resolve) => {
          resumeGate = resolve;
        });
        snapshot.attention = undefined;
        snapshot.status = 'completed';
        snapshot.stopReason = 'end_turn';
        snapshot.output = approved ? 'Approved and completed' : 'Declined';
        onUpdate(snapshot);
        return snapshot;
      },
      async steerLive(_taskId, { action, snapshot }) {
        if (resumeGate && (action === 'approve' || action === 'reject')) {
          resumeGate(action === 'approve');
          await new Promise((r) => setTimeout(r, 20));
          return { handledLive: true, snapshot };
        }
        return { handledLive: false };
      },
      async abort(_taskId, snapshot, { terminateSession = false } = {}) {
        if (terminateSession && snapshot) {
          snapshot.resumeCommandHint = null;
          snapshot.sessionTerminated = true;
        }
        return true;
      },
    };

    const tm = new TaskManager({
      stateDir: tempStateDir,
      driverOverrides: { 'codex-app-server': gateDriver },
    });

    const pausedSnap = await tm.delegate({
      targetId: 'local-codex',
      prompt: 'Run privileged tool',
      reinPolicy: 'parent-rein',
      wait: true,
    });
    assert.equal(pausedSnap.status, 'attention_required');
    assert.equal(pausedSnap.stopReason, 'attention-required');

    const completedSnap = await tm.steer(pausedSnap.taskId, {
      action: 'approve',
      wait: true,
    });
    assert.equal(completedSnap.status, 'completed');
    assert.equal(completedSnap.output, 'Approved and completed');

    const killedSnap = await tm.abort(pausedSnap.taskId, { terminateSession: true });
    assert.equal(killedSnap.status, 'aborted');
    assert.equal(killedSnap.resumeCommandHint, null);
    assert.equal(killedSnap.sessionTerminated, true);

    // 8. Cross-manager abort --kill waits for controlAckId when turn/interrupt finishes before delayed thread/archive failure
    const targetCfg = { id: 'probe', kind: 'codex', driver: 'codex-app-server' };
    const mockRegistry = { getTargetOrThrow: () => targetCfg, config: { hub: {} } };
    const ownerDriver = new CodexAppServerDriver(targetCfg);
    const peerDriver = new CodexAppServerDriver(targetCfg);
    peerDriver._archiveSessionViaNewTransport = async () => {
      throw new Error('unexpected fallback');
    };
    let archiveSettled = false;
    let releaseTurn;
    ownerDriver.runTurn = async (s, _opts, onUpdate) => {
      s.status = 'attention_required';
      s.stopReason = 'attention-required';
      s.attention = { requestId: 'req_ack_1' };
      const turn = new Promise((resolve) => {
        releaseTurn = () => resolve(s);
      });
      ownerDriver.activeSessions.set(s.taskId, {
        snapshot: s,
        threadId: s.sessionId,
        activeTurnId: 'turn_ack_1',
        transport: {
          request: async (method) => {
            if (method === 'turn/interrupt') {
              s.status = 'aborted';
              s.stopReason = 'aborted';
              onUpdate(s);
              return {};
            }
            if (method === 'thread/archive') {
              await new Promise((r) => setTimeout(r, 120));
              archiveSettled = true;
              throw new Error('mock archive denied');
            }
            return {};
          },
          close: async () => releaseTurn?.(),
        },
      });
      onUpdate(s);
      await turn;
      ownerDriver.activeSessions.delete(s.taskId);
      return s;
    };

    const ownerTm = new TaskManager({
      registry: mockRegistry,
      stateDir: tempStateDir,
      driverOverrides: { probe: ownerDriver },
    });
    const peerTm = new TaskManager({
      registry: mockRegistry,
      stateDir: tempStateDir,
      driverOverrides: { probe: peerDriver },
    });

    const ackSnap = createInitialTaskSnapshot({
      taskId: 'tsk_archive_ack_probe',
      targetId: 'probe',
      kind: 'codex',
      sessionMode: 'persistent',
      reinPolicy: 'parent-rein',
      preset: 'task',
      cwd: process.cwd(),
      sessionId: 'thr_native_ack',
    });
    ackSnap.status = 'completed';
    ackSnap.stopReason = 'end_turn';
    ackSnap.project = {
      id: 'proj_ack_A',
      root: process.cwd(),
      binding: 'bound',
      mechanism: 'native-id',
    };
    ownerTm.saveSnapshot(ackSnap);
    await ownerTm.steer(ackSnap.taskId, { action: 'reply', message: 'resume', wait: true });

    await assert.rejects(
      peerTm.abort(ackSnap.taskId, { terminateSession: true }),
      /mock archive denied/,
    );
    assert.equal(archiveSettled, true);
    assert.equal(peerTm.getTask(ackSnap.taskId)?.sessionTerminated ?? false, false);
  } finally {
    for (const k of traceKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  }
});
