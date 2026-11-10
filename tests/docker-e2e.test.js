/**
 * Reins Live E2E & Docker Verification Suite
 *
 * Uses the unified test LLM `deepseek-flash` configured via `DEEPSEEK_API_KEY`
 * in `.env` (see `.env.example`) and the standardized `config/reins.test.yaml`
 * target definitions (local + containerized SSH & Tmux).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFile, TargetRegistry } from '../src/hub/registry.js';
import { TaskManager } from '../src/hub/task-manager.js';

process.env.REINS_IGNORE_USER_CONFIG = '1';
loadEnvFile();

const TEST_MODEL = process.env.REINS_TEST_MODEL || 'deepseek-flash';
const AGENT_SCRIPT = path.resolve('tests/docker/deepseek-harness-agent.mjs');

function requireDeepSeekApiKey() {
  const key = (process.env.DEEPSEEK_API_KEY || '').trim();
  assert.ok(
    key,
    'DEEPSEEK_API_KEY is required for live E2E tests. Please copy `.env.example` to `.env` and set DEEPSEEK_API_KEY before running `npm run test:e2e` or `npm run test:docker`.',
  );
  return key;
}

test('Docker & Live E2E: .env loads DEEPSEEK_API_KEY and config/reins.test.yaml uses deepseek-flash', () => {
  requireDeepSeekApiKey();
  const registry = new TargetRegistry({
    configPath: path.resolve('config/reins.test.yaml'),
    ignoreUserConfig: true,
  });
  const targets = registry.listTargets().filter((t) => t.id.startsWith('test-'));
  assert.ok(targets.length >= 4);
  for (const target of targets) {
    assert.equal(
      target.model,
      TEST_MODEL,
      `Target ${target.id} must use unified test model ${TEST_MODEL}`,
    );
  }
});

test('Docker & Live E2E: local DSH headless & ACP targets complete live turns with deepseek-flash', async () => {
  requireDeepSeekApiKey();
  const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-e2e-local-'));
  try {
    const registry = new TargetRegistry({
      configOverride: {
        hub: { maxHops: 4, defaultTimeoutSec: 60 },
        targets: {
          'test-local-dsh': {
            kind: 'dsh',
            driver: 'dsh-headless',
            transport: { type: 'local' },
            command: process.execPath,
            args: [AGENT_SCRIPT],
            model: TEST_MODEL,
            defaultCwd: process.cwd(),
            defaultPolicy: 'auto-edit',
            defaultSessionMode: 'ephemeral',
          },
          'test-local-acp': {
            kind: 'dsh',
            driver: 'acp',
            transport: { type: 'local' },
            command: process.execPath,
            args: [AGENT_SCRIPT, '--profile', 'acp'],
            model: TEST_MODEL,
            defaultCwd: process.cwd(),
            defaultPolicy: 'auto-edit',
            defaultSessionMode: 'persistent',
          },
        },
      },
    });
    const manager = new TaskManager({ registry, stateDir: tempStateDir });

    const headlessSnap = await manager.delegate({
      targetId: 'test-local-dsh',
      prompt: 'Reply with the exact token REINS_FLASH_OK and nothing else.',
      sessionMode: 'ephemeral',
    });
    assert.equal(headlessSnap.status, 'completed', headlessSnap.error || headlessSnap.diagnostic);
    assert.equal(headlessSnap.model, TEST_MODEL);
    assert.match(headlessSnap.output, /REINS_FLASH_OK/i);

    const acpSnap = await manager.delegate({
      targetId: 'test-local-acp',
      prompt: 'Reply with the exact token REINS_ACP_OK and nothing else.',
      sessionMode: 'persistent',
    });
    assert.equal(acpSnap.status, 'completed', acpSnap.error || acpSnap.diagnostic);
    assert.equal(acpSnap.model, TEST_MODEL);
    assert.match(acpSnap.output, /REINS_ACP_OK/i);
  } finally {
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  }
});

test('Docker & Live E2E: Claude Code persistent multi-turn session & caller rules with deepseek-flash', async () => {
  requireDeepSeekApiKey();
  const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-e2e-claude-'));
  try {
    const registry = new TargetRegistry({
      configOverride: {
        hub: { maxHops: 4, defaultTimeoutSec: 60 },
        targets: {
          'test-local-claude': {
            kind: 'claude-code',
            driver: 'claude-tmux',
            transport: { type: 'local' },
            command: process.execPath,
            args: [AGENT_SCRIPT],
            tmuxCommand: process.execPath,
            tmuxArgs: [path.resolve('tests/fixtures/mock-tmux.mjs')],
            pollIntervalMs: 30,
            pasteDelayMs: 10,
            env: {
              CLAUDE_CONFIG_DIR: path.join(tempStateDir, '.claude'),
              MOCK_TMUX_SESSION: path.join(tempStateDir, 'session.json'),
            },
            model: TEST_MODEL,
            defaultCwd: process.cwd(),
            defaultPolicy: 'auto-edit',
            defaultSessionMode: 'persistent',
            rules: '1. Always use unified test model deepseek-flash.\n2. Keep responses concise.',
          },
        },
      },
    });
    const manager = new TaskManager({ registry, stateDir: tempStateDir });

    const turn1 = await manager.delegate({
      targetId: 'test-local-claude',
      prompt: 'Remember the verification token OMEGA_99 and reply with ACK_OMEGA_99.',
      sessionMode: 'persistent',
    });
    assert.equal(turn1.status, 'completed', turn1.error || turn1.diagnostic);
    assert.equal(turn1.model, TEST_MODEL);
    assert.match(turn1.targetRules, /deepseek-flash/);
    assert.match(turn1.output, /ACK_OMEGA_99/i);

    const turn2 = await manager.steer(turn1.taskId, {
      action: 'reply',
      message: 'What was the verification token I asked you to remember? Reply with the token only.',
    });
    assert.equal(turn2.status, 'completed', turn2.error || turn2.diagnostic);
    assert.equal(turn2.sessionId, turn1.sessionId);
    assert.equal(turn2.metrics.turnCount, 2);
    assert.match(turn2.output, /OMEGA_99/i);
  } finally {
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  }
});

test(
  'Docker & Live E2E: containerized SSH + Tmux targets (test-ssh-dsh & test-ssh-claude) complete live turns with deepseek-flash',
  { skip: process.env.REINS_DOCKER_TEST !== '1' ? 'Run via `npm run test:docker` to test containerized SSH + Tmux' : false },
  async () => {
    requireDeepSeekApiKey();
    const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-e2e-ssh-'));
    try {
      const registry = new TargetRegistry({
        configPath: path.resolve('config/reins.test.yaml'),
        ignoreUserConfig: true,
      });
      const manager = new TaskManager({ registry, stateDir: tempStateDir });

      // 1. Remote SSH DSH headless turn
      const sshDsh = await manager.delegate({
        targetId: 'test-ssh-dsh',
        prompt: 'Reply with the exact token REINS_SSH_DSH_OK and nothing else.',
        sessionMode: 'ephemeral',
      });
      assert.equal(sshDsh.status, 'completed');
      assert.equal(sshDsh.model, TEST_MODEL);
      assert.match(sshDsh.output, /REINS_SSH_DSH_OK/i);

      // 2. Remote SSH Claude Code persistent Tmux session + multi-turn steer resumption
      const sshClaude1 = await manager.delegate({
        targetId: 'test-ssh-claude',
        prompt: 'Remember the code word ALPHA_42 and reply with ACK_ALPHA_42.',
        sessionMode: 'persistent',
      });
      assert.equal(sshClaude1.status, 'completed');
      assert.equal(sshClaude1.model, TEST_MODEL);
      assert.match(sshClaude1.targetRules, /deepseek-flash/);
      assert.match(sshClaude1.output, /ACK_ALPHA_42/i);
      assert.ok(sshClaude1.tmuxSession, 'Expected remote tmuxSession to be created');

      const sshClaude2 = await manager.steer(sshClaude1.taskId, {
        action: 'reply',
        message: 'What was the code word I asked you to remember? Reply with the code word only.',
      });
      assert.equal(sshClaude2.status, 'completed');
      assert.equal(sshClaude2.sessionId, sshClaude1.sessionId);
      assert.equal(sshClaude2.metrics.turnCount, 2);
      assert.match(sshClaude2.output, /ALPHA_42/i);
    } finally {
      fs.rmSync(tempStateDir, { recursive: true, force: true });
    }
  },
);
