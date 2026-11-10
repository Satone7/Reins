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
import {
  buildAtomicDiscoverySnapshot,
  discoverLocalHarnesses,
  discoverSshHosts,
  inspectExistingConfig,
  syncLocalHarnessSkills,
} from '../src/cli/init.js';
import { advanceTraceOrThrow } from '../src/hub/loop-guard.js';
import { normalizeTargetConfig, parseSimpleYaml, TargetRegistry } from '../src/hub/registry.js';
import { TaskManager } from '../src/hub/task-manager.js';
import { ReinsMcpServer } from '../src/mcp/index.js';
import { AntigravityDriver } from '../src/drivers/antigravity-driver.js';
import { DshDriver } from '../src/drivers/dsh-driver.js';
import {
  ClaudeCodeDriver,
  claudePaneLooksBusy,
  claudePaneLooksReady,
  createClaudeTranscriptState,
  detectClaudeAttention,
  foldClaudeTranscriptLine,
  projectSlug,
  sanitizeClaudeArgs,
} from '../src/drivers/claude-code-driver.js';
import {
  CodexAppServerDriver,
  deriveCodexThreadTitle,
  normalizeCodexPath,
  resolveGitWorktreeRoot,
} from '../src/drivers/codex-app-server.js';
import { JsonRpcStdioTransport } from '../src/transports/local.js';
import {
  buildPosixCommandLine,
  buildSshArgs,
  createJsonRpcTransport,
  quotePosixShellArg,
  runStreamingProcess,
  SshStdioTransport,
} from '../src/transports/ssh.js';

// Decouple unit tests from any developer-local `~/.reins/config.yaml`
process.env.REINS_IGNORE_USER_CONFIG = '1';

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
    buildSshArgs({ sshHost: 'reins-ssh-node' }, 'pwd'),
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'reins-ssh-node', 'pwd'],
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
  const remote = createJsonRpcTransport({ ...options, transportConfig: { kind: 'ssh', host: 'reins-ssh-node' } });
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

test('Claude Code interactive tmux mode folds JSONL transcripts, strips forbidden -p flags, and resumes sessions', async () => {
  assert.equal(projectSlug('/home/ubuntu/work/app'), '-home-ubuntu-work-app');
  assert.deepEqual(
    sanitizeClaudeArgs(['-p', '--print', '--output-format', 'stream-json', '--no-session-persistence', '--verbose']),
    ['--verbose'],
  );
  assert.equal(claudePaneLooksReady(['Claude Code v2.1.302', '❯ ', '  ⏸ manual mode on']), true);
  assert.equal(claudePaneLooksBusy(['✻ Thinking… (esc to interrupt)']), true);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-claude-interactive-'));
  try {
    const logPath = path.join(tempDir, 'claude.jsonl');
    const tmuxLog = path.join(tempDir, 'tmux.jsonl');
    const claudeDir = path.join(tempDir, '.claude');
    const driver = new ClaudeCodeDriver({
      driver: 'claude-tmux',
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-claude.mjs'), '-p', '--output-format', 'stream-json', '--verbose'],
      tmuxCommand: process.execPath,
      tmuxArgs: [path.resolve('tests/fixtures/mock-tmux.mjs')],
      pollIntervalMs: 15,
      pasteDelayMs: 5,
      env: {
        CLAUDE_CONFIG_DIR: claudeDir,
        MOCK_CLAUDE_LOG: logPath,
        MOCK_TMUX_LOG: tmuxLog,
      },
    });
    const snapshot = createInitialTaskSnapshot({
      taskId: 'claude-interactive',
      targetId: 'mock-claude',
      kind: 'claude-code',
      sessionId: 'claude_previous',
      sessionMode: 'persistent',
      reinPolicy: 'free-rein',
      cwd: tempDir,
    });
    await driver.runTurn(snapshot, { prompt: 'Review the code' });
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.stopReason, 'end_turn');
    assert.equal(snapshot.sessionId, 'claude_previous');
    assert.match(snapshot.tmuxSession, /^reins-cc-/);
    assert.equal(snapshot.resumeCommandHint, `tmux attach -t ${snapshot.tmuxSession}`);
    assert.equal(snapshot.output, 'Final reply');
    assert.equal(snapshot.commentary, 'Analyzing repository context');
    assert.equal(snapshot.metrics.costUsd, 0.012);
    assert.equal(snapshot.metrics.durationMs, 123);
    assert.equal(snapshot.metrics.turnCount, 1);
    assert.deepEqual(snapshot.metrics.tokens, { inputTokens: 10, outputTokens: 6, cacheReadTokens: 1 });
    assert.deepEqual(snapshot.transcript.messages.map((event) => event.role), ['user', 'tool', 'assistant']);

    const args = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.ok(!args.includes('-p'), 'Claude Code args must never include -p');
    assert.ok(!args.includes('--print'), 'Claude Code args must never include --print');
    assert.ok(!args.includes('--output-format'), 'Claude Code args must never include --output-format');
    assert.ok(args.includes('--verbose'));
    assert.equal(args[args.indexOf('--resume') + 1], 'claude_previous');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude Code maps ReinPolicy flags and cleans up ephemeral tmux sessions and transcripts', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-claude-policy-'));
  try {
    const logPath = path.join(tempDir, 'claude.jsonl');
    const tmuxLog = path.join(tempDir, 'tmux.jsonl');
    const claudeDir = path.join(tempDir, '.claude');
    const driver = new ClaudeCodeDriver({
      driver: 'claude-tmux',
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-claude.mjs')],
      tmuxCommand: process.execPath,
      tmuxArgs: [path.resolve('tests/fixtures/mock-tmux.mjs')],
      pollIntervalMs: 15,
      pasteDelayMs: 5,
      env: {
        CLAUDE_CONFIG_DIR: claudeDir,
        MOCK_CLAUDE_LOG: logPath,
        MOCK_TMUX_LOG: tmuxLog,
      },
    });
    const modes = [
      ['auto-edit', 'acceptEdits'],
      ['plan-only', 'plan'],
      ['parent-rein', 'default'],
      ['tight-rein', 'default'],
    ];
    for (const [reinPolicy, expectedMode] of modes) {
      const snapshot = createInitialTaskSnapshot({
        taskId: `claude-${reinPolicy}`,
        targetId: 'mock-claude',
        kind: 'claude-code',
        sessionMode: 'ephemeral',
        reinPolicy,
        cwd: tempDir,
      });
      await driver.runTurn(snapshot, { prompt: 'One-shot review' });
      assert.equal(snapshot.status, 'completed');
      assert.equal(snapshot.resumeCommandHint, undefined);
      assert.equal(snapshot.tmuxSession, undefined);
      const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
      const args = JSON.parse(lines.at(-1));
      assert.ok(!args.includes('-p'));
      assert.ok(args.includes('--session-id'));
      assert.equal(args[args.indexOf('--permission-mode') + 1], expectedMode);
      const transcriptFile = path.join(claudeDir, 'projects', projectSlug(tempDir), `${snapshot.sessionId}.jsonl`);
      assert.equal(fs.existsSync(transcriptFile), false, 'Ephemeral transcript file must be cleaned up');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude Code interactive permission dialog pauses in attention_required and steers via Enter/Escape', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-claude-tmux-'));
  try {
    const tmuxLog = path.join(tempDir, 'tmux.jsonl');
    const claudeDir = path.join(tempDir, '.claude');
    const driver = new ClaudeCodeDriver({
      driver: 'claude-tmux',
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-claude.mjs')],
      tmuxCommand: process.execPath,
      tmuxArgs: [path.resolve('tests/fixtures/mock-tmux.mjs')],
      tmuxPrefix: 'reins-test',
      pollIntervalMs: 15,
      pasteDelayMs: 5,
      env: {
        CLAUDE_CONFIG_DIR: claudeDir,
        MOCK_TMUX_LOG: tmuxLog,
        MOCK_CLAUDE_SCENARIO: 'permission',
      },
    });
    const snapshot = createInitialTaskSnapshot({
      taskId: 'claude-tmux',
      targetId: 'mock-claude',
      kind: 'claude-code',
      sessionId: 'claude_mock_12345678',
      sessionMode: 'persistent',
      reinPolicy: 'parent-rein',
      cwd: tempDir,
    });

    let resolveAttention;
    const attentionPromise = new Promise((resolve) => {
      resolveAttention = resolve;
    });
    const turnPromise = driver.runTurn(snapshot, { prompt: 'Persistent work' }, (updated) => {
      if (updated.status === 'attention_required') resolveAttention(updated);
    });

    await attentionPromise;
    assert.equal(snapshot.status, 'attention_required');
    assert.equal(snapshot.attention.kind, 'permission');
    assert.deepEqual(
      await driver.steerLive(snapshot.taskId, { action: 'approve', snapshot }),
      { handledLive: true, snapshot },
    );
    await turnPromise;

    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.output, 'Approved final reply');
    assert.equal(snapshot.sessionId, 'claude_mock_12345678');
    assert.match(snapshot.tmuxSession, /^reins-test-/);
    assert.equal(snapshot.resumeCommandHint, `tmux attach -t ${snapshot.tmuxSession}`);
    assert.deepEqual(
      await driver.steerLive(snapshot.taskId, { action: 'reject', snapshot }),
      { handledLive: true, snapshot },
    );
    assert.deepEqual(
      await driver.steerLive(snapshot.taskId, { action: 'reply', message: 'Next', snapshot }),
      { handledLive: false },
    );
    assert.equal(await driver.abort(snapshot.taskId, snapshot), true);
    assert.equal(await driver.abort(snapshot.taskId, snapshot, { terminateSession: true }), true);
    assert.equal(snapshot.sessionTerminated, true);

    const calls = fs.readFileSync(tmuxLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(calls[0][0], 'has-session');
    assert.equal(calls[1][0], 'new-session');
    assert.match(calls[1].at(-1), /'--resume' 'claude_mock_12345678'/);
    assert.ok(calls.some((c) => c[0] === 'paste-buffer' && c.includes('-p')));
    assert.deepEqual(calls.slice(-3).map((call) => [call[0], ...call.slice(-2)]), [
      ['send-keys', `=${snapshot.tmuxSession || 'reins-test-claudemo'}`, 'Escape'],
      ['send-keys', `=${snapshot.tmuxSession || 'reins-test-claudemo'}`, 'Escape'],
      ['kill-session', '-t', `=${snapshot.tmuxSession || 'reins-test-claudemo'}`],
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Claude Code tmux replies reuse active tmux session and resume through TaskManager after restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-claude-steer-'));
  const traceKeys = ['REINS_TRACE_ID', 'REINS_HOP_COUNT', 'REINS_MAX_HOPS', 'REINS_CALL_CHAIN'];
  const inheritedTrace = Object.fromEntries(traceKeys.map((key) => [key, process.env[key]]));
  for (const key of traceKeys) delete process.env[key];
  try {
    const claudeLog = path.join(tempDir, 'claude.jsonl');
    const tmuxLog = path.join(tempDir, 'tmux.jsonl');
    const claudeDir = path.join(tempDir, '.claude');
    const target = normalizeTargetConfig('mock-claude', {
      kind: 'claude-code',
      driver: { mode: 'claude-tmux', tmuxPrefix: 'reins-restart' },
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mock-claude.mjs')],
      tmuxCommand: process.execPath,
      tmuxArgs: [path.resolve('tests/fixtures/mock-tmux.mjs')],
      pollIntervalMs: 15,
      pasteDelayMs: 5,
      transport: { type: 'local' },
      defaultCwd: tempDir,
      defaultPolicy: 'auto-edit',
      defaultSessionMode: 'persistent',
      env: {
        CLAUDE_CONFIG_DIR: claudeDir,
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
    const tmuxCalls = fs.readFileSync(tmuxLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(tmuxCalls.filter((call) => call[0] === 'new-session').length, 1);
    assert.equal(tmuxCalls.filter((call) => call[0] === 'paste-buffer').length, 2);

    const interrupted = await restartedManager.steer(first.taskId, { action: 'interrupt' });
    assert.equal(interrupted.status, 'aborted');
    assert.equal(interrupted.stopReason, 'aborted');
    const finalTmuxCalls = fs.readFileSync(tmuxLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(finalTmuxCalls.at(-1).slice(-2), [`=${first.tmuxSession}`, 'Escape']);
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
    for (const driverName of ['claude-tmux', 'claude-cli', 'custom']) {
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
      sshHost: 'reins-ssh-node',
      tmuxSession: 'reins-claude',
    }),
    'ssh -t reins-ssh-node "tmux attach -t reins-claude"',
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
    targetId: 'remote-dsh',
    requestTrace: step1.trace,
    configuredMaxHops: 2,
  });
  assert.equal(step2.trace.hopCount, 2);

  // Hop 3 exceeds maxHops (2)
  assert.throws(
    () =>
      advanceTraceOrThrow({
        targetId: 'remote-claude',
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
    rules: |
      1. First rule with colon: keep English
      2. Timezone: America/Los_Angeles
`;
  const parsed = parseSimpleYaml(sampleYaml);
  assert.equal(parsed.version, '0.2.0');
  assert.equal(parsed.hub.port, 19420);
  assert.equal(parsed.targets['local-codex'].kind, 'codex');
  assert.match(parsed.targets['local-codex'].rules, /First rule with colon: keep English/);
  assert.match(parsed.targets['local-codex'].rules, /America\/Los_Angeles/);

  const registry = new TargetRegistry({ ignoreUserConfig: true });
  const targets = registry.listTargets();
  assert.ok(targets.some((t) => t.id === 'local-codex' && t.kind === 'codex'));
  const remoteClaude = targets.find((t) => t.id === 'remote-claude');
  assert.ok(remoteClaude, 'Expected generic remote-claude example target to be registered');
  assert.equal(remoteClaude.kind, 'claude-code');
  assert.equal(remoteClaude.transport.host, 'dev-node.example.com');
  assert.equal(remoteClaude.defaultCwd, '/workspace/project');
  assert.match(remoteClaude.rules, /Language & Documentation/);
  assert.match(remoteClaude.rules, /America\/Los_Angeles/);

  const testRegistry = new TargetRegistry({
    configPath: path.resolve('config/reins.test.yaml'),
    ignoreUserConfig: true,
  });
  const testTargets = testRegistry.listTargets();
  for (const targetId of ['test-local-dsh', 'test-local-acp', 'test-ssh-dsh', 'test-ssh-claude']) {
    const found = testTargets.find((t) => t.id === targetId);
    assert.ok(found, `Expected ${targetId} in config/reins.test.yaml`);
    assert.equal(found.model, 'deepseek-flash');
  }

  // Global hub.rules merges with target-specific rules
  const globalRuleRegistry = new TargetRegistry({
    configOverride: {
      hub: {
        rules: 'Global Rule: Prefer flagship models and high reasoning effort.',
      },
      targets: {
        'custom-node': {
          kind: 'claude-code',
          driver: 'claude-print',
          defaultModel: 'opus',
          defaultEffort: 'high',
          rules: 'Target Rule: Use English.',
        },
      },
    },
  });
  const customNode = globalRuleRegistry.listTargets().find((t) => t.id === 'custom-node');
  assert.equal(customNode.model, 'opus');
  assert.equal(customNode.effort, 'high');
  assert.match(customNode.rules, /Global Rule: Prefer flagship models/);
  assert.match(customNode.rules, /Target Rule: Use English/);
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

test('Atomic streaming runner and Codex path/title helpers work without private SQLite mutation', async () => {
  assert.equal(
    normalizeCodexPath('\\\\?\\C:\\workspace\\reins'),
    'C:\\workspace\\reins',
  );
  assert.equal(
    deriveCodexThreadTitle('[Reins H2H Preset: coding]\n# Implement Antigravity Driver\nDetails'),
    '[Reins] Implement Antigravity Driver',
  );

  const lines = [];
  const res = await runStreamingProcess({
    command: process.execPath,
    args: ['-e', 'console.log("line1"); console.error("err1"); process.exit(2);'],
    onLine: (l) => lines.push(l),
  });
  assert.deepEqual(lines, ['line1']);
  assert.equal(res.exitCode, 2);
  assert.match(res.stderr, /err1/);
  assert.match(res.commandLine, /node/i);

  // Verify _ensureCodexProject gracefully falls back when a Codex version does not implement project/list (-32601)
  const driver = new CodexAppServerDriver({ id: 'local-codex', kind: 'codex' });
  const mockTransport = {
    request: async () => {
      const err = new Error('JSON-RPC error (project/list): Method not found');
      err.code = -32601;
      throw err;
    },
  };
  const fallback = await driver._ensureCodexProject(mockTransport, '/workspace/demo', false);
  assert.equal(fallback.projectId, null);
  assert.equal(fallback.rpcSupported, false);
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
    normalizeCodexPath('\\\\?\\C:\\workspace\\h2h-protocol'),
    'C:\\workspace\\h2h-protocol',
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
    cwd: 'C:\\workspace\\h2h-protocol\\spec\\en',
  });
  normalizeSnapshotEnvelope(pendingCodexSnap);
  assert.equal(pendingCodexSnap.project.root, null);
  assert.equal(pendingCodexSnap.projectSelector, undefined);

  // 6. Strict auto-edit approval confinement ([H2H-POL-02])
  const codexDriver = new CodexAppServerDriver({ id: 'local-codex', kind: 'codex' });
  const mockRuntime = {
    effectiveProjectRoot: 'C:\\workspace\\h2h-protocol',
    snapshot: pendingCodexSnap,
  };
  assert.equal(
    codexDriver._isWithinWorkspaceForAutoEdit(
      mockRuntime,
      'item/commandExecution/requestApproval',
      { command: 'rm -rf /tmp/outside', cwd: 'C:\\workspace\\h2h-protocol' },
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

test('reins atomic discovery: discovers local harnesses, SSH hosts, and existing config state', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-init-discover-'));
  try {
    fs.mkdirSync(path.join(tempHome, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(tempHome, '.dsh'), { recursive: true });
    const sshDir = path.join(tempHome, '.ssh');
    fs.mkdirSync(sshDir, { recursive: true });
    const sshConfigPath = path.join(sshDir, 'config');
    fs.writeFileSync(
      sshConfigPath,
      [
        'Host *',
        '  ServerAliveInterval 60',
        'Host faex1',
        '  HostName 192.168.1.50',
        '  User pren',
        '  Port 22',
        'Host lisa-vps-br',
        '  HostName 203.0.113.10',
        '  User broca',
      ].join('\n'),
      'utf8',
    );

    const discovered = discoverLocalHarnesses({
      cwd: '/workspace/demo',
      homedir: tempHome,
      platform: 'linux',
      env: {},
      findBinary: (bin) => {
        if (bin === 'codex') return '/usr/local/bin/codex';
        if (bin === 'npx') return '/usr/local/bin/npx';
        return null;
      },
    });

    assert.equal(discovered.length, 4);
    const codex = discovered.find((d) => d.id === 'local-codex');
    const agy = discovered.find((d) => d.id === 'local-agy');
    const dsh = discovered.find((d) => d.id === 'local-dsh');
    const claude = discovered.find((d) => d.id === 'local-claude');

    assert.equal(codex.detected, true);
    assert.equal(codex.binaryPath, '/usr/local/bin/codex');
    assert.equal(agy.detected, false);
    assert.equal(dsh.detected, true);
    assert.equal(claude.detected, false);

    const sshHosts = discoverSshHosts(sshConfigPath);
    assert.equal(sshHosts.length, 2);
    assert.equal(sshHosts[0].alias, 'faex1');
    assert.equal(sshHosts[0].user, 'pren');
    assert.equal(sshHosts[1].alias, 'lisa-vps-br');

    const missingConfigPath = path.join(tempHome, '.reins', 'config.yaml');
    const snapshot = buildAtomicDiscoverySnapshot({
      cwd: '/workspace/demo',
      homedir: tempHome,
      configPath: missingConfigPath,
      sshConfigPath,
    });
    assert.equal(snapshot.initialized, false);
    assert.equal(snapshot.configPath, missingConfigPath);
    assert.equal(snapshot.sshHosts.length, 2);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('reins registry & skill sync: detects uninitialized state, respects explicit targets subset, and syncs SKILL.md', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-agent-init-'));
  try {
    // 1. Uninitialized registry (when user config file does not exist yet)
    const missingUserConfig = path.join(tempDir, 'nonexistent-config.yaml');
    const uninitRegistry = new TargetRegistry({ configPath: missingUserConfig, ignoreUserConfig: true });
    assert.equal(uninitRegistry.initialized, false);

    // 2. When Agent writes ~/.reins/config.yaml with only selected targets, Registry registers ONLY those targets
    const configPath = path.join(tempDir, 'config.yaml');
    fs.writeFileSync(
      configPath,
      [
        'version: 2',
        'targets:',
        '  - id: local-codex',
        '    label: Local OpenAI Codex',
        '    harnessType: codex',
        '    transport:',
        '      kind: local',
        '    driver:',
        '      mode: codex-app-server',
        '      command: codex',
        '      args:',
        '        - app-server',
        '    workspace:',
        '      defaultWorkdir: /workspace/reins',
        '      allowedSyncModes:',
        '        - local',
        '    reinPolicy: auto-edit',
        '    rules: |-',
        '      ## Global Caller Preferences',
        '      - Strategy: Quality-First (Max Reasoning Effort)',
        '  - id: lisa-claude',
        '    label: Lisa VPS Claude Code',
        '    harnessType: claude-code',
        '    transport:',
        '      kind: ssh',
        '      sshHost: lisa-vps-br',
        '      connectTimeoutSec: 20',
        '    driver:',
        '      mode: claude-tmux',
        '      command: /usr/local/bin/claude',
        '      args: []',
        '    workspace:',
        '      defaultWorkdir: /home/broca/project',
        '      allowedSyncModes:',
        '        - remote-native',
        '        - context-only',
        '    reinPolicy: tight-rein',
        '    model: opus',
        '    effort: max',
      ].join('\n'),
      'utf8',
    );

    const existingInfo = inspectExistingConfig(configPath);
    assert.equal(existingInfo.exists, true);
    assert.deepEqual(
      existingInfo.localTargets.map((t) => t.id),
      ['local-codex'],
    );
    assert.deepEqual(
      existingInfo.remoteTargets.map((t) => t.id),
      ['lisa-claude'],
    );

    const loadedRegistry = new TargetRegistry({ configPath });
    assert.equal(loadedRegistry.initialized, true);
    const targets = loadedRegistry.listTargets();
    assert.deepEqual(
      targets.map((t) => t.id),
      ['local-codex', 'lisa-claude'],
    );
    const lisaTarget = targets.find((t) => t.id === 'lisa-claude');
    assert.equal(lisaTarget.kind, 'claude-code');
    assert.equal(lisaTarget.driver, 'claude-tmux');
    assert.equal(lisaTarget.transport.host, 'lisa-vps-br');
    assert.equal(lisaTarget.defaultCwd, '/home/broca/project');
    assert.equal(lisaTarget.defaultPolicy, 'tight-rein');
    assert.equal(lisaTarget.model, 'opus');
    assert.equal(lisaTarget.effort, 'max');

    // 3. Test `syncLocalHarnessSkills` syncing SKILL.md into selected harness skill folders
    const synced = syncLocalHarnessSkills(['codex', 'antigravity'], { homedir: tempDir });
    assert.equal(synced.length, 2);
    for (const skillFile of synced) {
      assert.ok(fs.existsSync(skillFile));
      const content = fs.readFileSync(skillFile, 'utf8');
      assert.match(content, /Agent-Hosted Initialization Flow/);
      assert.match(content, /\/reins init/);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
