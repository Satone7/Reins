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
import { parseSimpleYaml, TargetRegistry } from '../src/hub/registry.js';
import { TaskManager } from '../src/hub/task-manager.js';
import { ReinsMcpServer } from '../src/mcp/index.js';

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
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  }
});
