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
  mapReinPolicyToCodex,
  resolveReinPolicy,
  resolveSessionMode,
} from '../src/protocol/schema.js';
import { advanceTraceOrThrow } from '../src/hub/loop-guard.js';
import { normalizeTargetConfig, parseSimpleYaml, TargetRegistry } from '../src/hub/registry.js';
import { TaskManager } from '../src/hub/task-manager.js';
import { ReinsMcpServer } from '../src/mcp/index.js';
import { AntigravityDriver } from '../src/drivers/antigravity-driver.js';
import { DshDriver } from '../src/drivers/dsh-driver.js';
import { ClaudeCodeDriver } from '../src/drivers/claude-code-driver.js';
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

test('SSH command line quotes cwd and arguments and exports REINS variables', () => {
  assert.equal(
    buildPosixCommandLine('codex', ['app-server', "a'b;$(touch bad)"], '/work/my repo', {
      REINS_TRACE: "hop'1",
      REINS_EMPTY: '',
      OTHER_SECRET: 'local-only',
    }),
    "cd '/work/my repo' && export REINS_TRACE='hop'\"'\"'1' REINS_EMPTY='' && 'codex' 'app-server' 'a'\"'\"'b;$(touch bad)'",
  );
  assert.equal(buildPosixCommandLine('codex', ['--help']), "'codex' '--help'");
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
    assert.equal(ephemeral.resumeCommandHint, undefined);
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
    assert.equal(snapEph.resumeCommandHint, undefined);
  } finally {
    for (const key of traceKeys) {
      if (inheritedTrace[key] === undefined) delete process.env[key];
      else process.env[key] = inheritedTrace[key];
    }
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  }
});
