/**
 * Antigravity CLI and SDK bridge driver for H2H turns.
 *
 * Thin, version-agnostic CLI runner that delegates via the configured `agy` (or custom)
 * command without polling internal `.system_generated/logs/transcript.jsonl` or mutating
 * private `.pb` / `.pbtxt` files.
 */

import { randomUUID } from 'node:crypto';
import {
  applyPresetPrompt,
  buildResumeCommandHint,
  formatDiagnosticSummary,
} from '../protocol/schema.js';
import { killProcessTree } from '../transports/local.js';
import { runStreamingProcess } from '../transports/ssh.js';

function parseTurnOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { output: '', sessionId: null };

  let records;
  try {
    const parsed = JSON.parse(trimmed);
    records = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    records = trimmed.split(/\r?\n/).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return line;
      }
    });
  }

  let sessionId = null;
  const text = [];
  for (const record of records) {
    if (typeof record === 'string') {
      const match = record.match(
        /^(?:session(?:[ _-]?id)?|conversation(?:[ _-]?id)?)\s*[:=]\s*(\S+)\s*$/i,
      );
      if (match) sessionId = match[1];
      else if (record.trim()) text.push(record);
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    sessionId =
      record.sessionId ||
      record.session_id ||
      record.conversationId ||
      record.conversation_id ||
      record.session?.id ||
      record.conversation?.id ||
      record.response?.newConversation?.conversationId ||
      sessionId;
    const message = record.output ?? record.response ?? record.text ?? record.message;
    if (typeof message === 'string' && message) text.push(message);
  }
  return { output: text.join('\n').trim(), sessionId };
}

export class AntigravityDriver {
  constructor(targetConfig = {}) {
    this.targetConfig = targetConfig;
    this.activeSessions = new Map();
  }

  async listModels() {
    return {
      targetId: this.targetConfig.id || 'local-agy',
      kind: 'antigravity',
      currentConfig: {
        model: this.targetConfig.model || 'flash_lite',
        effort: this.targetConfig.effort || null,
        provider: 'google',
      },
      models: [
        {
          id: 'flash_lite',
          model: 'flash_lite',
          displayName: 'Gemini Flash Lite',
          description: 'Low-latency, high-throughput model for fast tasks.',
          isDefault: this.targetConfig.model === 'flash_lite',
          defaultEffort: 'low',
          supportedEfforts: ['low', 'medium', 'high'],
          inputModalities: ['text', 'image'],
        },
        {
          id: 'flash',
          model: 'flash',
          displayName: 'Gemini Flash',
          description: 'Balanced speed and reasoning model.',
          isDefault: this.targetConfig.model === 'flash',
          defaultEffort: 'medium',
          supportedEfforts: ['low', 'medium', 'high'],
          inputModalities: ['text', 'image'],
        },
        {
          id: 'pro',
          model: 'pro',
          displayName: 'Gemini Pro',
          description: 'Deep reasoning model for complex engineering work.',
          isDefault: this.targetConfig.model === 'pro',
          defaultEffort: 'high',
          supportedEfforts: ['low', 'medium', 'high'],
          inputModalities: ['text', 'image'],
        },
        {
          id: 'inherit',
          model: 'inherit',
          displayName: 'Inherit Parent Model',
          description: 'Inherits the active model of the parent Antigravity workspace.',
          isDefault: !this.targetConfig.model || this.targetConfig.model === 'inherit',
          defaultEffort: null,
          supportedEfforts: [],
          inputModalities: ['text', 'image'],
        },
      ],
    };
  }

  async runTurn(snapshot, { prompt, envVars = {}, timeoutMs = 600000 }, onUpdate = () => {}) {
    const startedAt = Date.now();
    const transportConfig = this.targetConfig.transport;
    const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
    const driverMode =
      typeof this.targetConfig.driver === 'object'
        ? this.targetConfig.driver.mode
        : this.targetConfig.mode || this.targetConfig.driver;
    const isSdk = driverMode === 'antigravity-sdk';
    const configuredCommand = this.targetConfig.command || this.targetConfig.binaryPath;
    const command =
      configuredCommand && configuredCommand !== 'auto'
        ? configuredCommand
        : isSdk
          ? 'python'
          : 'agy';

    const baseArgs = Array.isArray(this.targetConfig.args) ? this.targetConfig.args : [];
    const framedPrompt = applyPresetPrompt(prompt, snapshot.preset);
    const args = [
      ...(isSdk && baseArgs.length === 0 ? ['-m', 'google.antigravity'] : baseArgs),
      '--prompt',
      framedPrompt,
    ];
    if (snapshot.sessionMode === 'ephemeral') args.push('--ephemeral');
    else if (snapshot.sessionId) args.push('--conversation', snapshot.sessionId);
    if (snapshot.reinPolicy === 'plan-only') args.push('--read-only');
    else if (snapshot.reinPolicy === 'free-rein' || snapshot.reinPolicy === 'auto-edit') {
      args.push('--allow-write', '--allow-exec');
    }

    const env = { ...(this.targetConfig.env || {}), ...envVars };
    const appendEvent = (event) => {
      snapshot.transcript.lastSeq += 1;
      snapshot.transcript.totalEvents += 1;
      snapshot.transcript.messages.push({
        seq: snapshot.transcript.lastSeq,
        timestamp: new Date().toISOString(),
        ...event,
      });
    };
    const emitUpdate = () => {
      snapshot.metrics.updatedAt = new Date().toISOString();
      snapshot.metrics.durationMs = Math.max(
        0,
        Date.now() - Date.parse(snapshot.metrics.startedAt || startedAt),
      );
      snapshot.diagnostic = formatDiagnosticSummary(snapshot);
      onUpdate(snapshot);
    };

    snapshot.status = 'running';
    snapshot.stopReason = undefined;
    snapshot.error = undefined;
    snapshot.output = '';
    snapshot.metrics.turnCount = (snapshot.metrics.turnCount || 0) + 1;
    appendEvent({ role: 'user', phase: 'input', text: framedPrompt });
    emitUpdate();

    const runtime = { child: null, aborted: false, snapshot, emitUpdate };
    this.activeSessions.set(snapshot.taskId, runtime);
    try {
      const result = await runStreamingProcess({
        command,
        args,
        harnessKind: 'antigravity',
        cwd: snapshot.cwd,
        env,
        transportConfig,
        timeoutMs,
        runtime,
      });

      if (runtime.aborted) {
        snapshot.status = 'aborted';
        snapshot.stopReason = 'aborted';
      } else if (result.timedOut || result.error || result.exitCode !== 0) {
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error = result.timedOut
          ? `Antigravity turn timed out after ${timeoutMs}ms.`
          : result.error?.message ||
            result.stderr?.trim() ||
            `Antigravity process (${result.commandLine}) exited with code=${result.exitCode} signal=${result.signal}.`;
      } else {
        const parsed = parseTurnOutput(result.stdout);
        snapshot.sessionId = snapshot.sessionId || parsed.sessionId || `agy_${randomUUID()}`;
        snapshot.output = parsed.output;
        snapshot.resumeCommandHint = buildResumeCommandHint({
          kind: 'antigravity',
          sessionId: snapshot.sessionId,
          sessionMode: snapshot.sessionMode,
          transportType: isSsh ? 'ssh' : 'local',
          sshHost: transportConfig?.host || transportConfig?.sshHost,
        });
        appendEvent({ role: 'assistant', phase: 'final_answer', text: snapshot.output });
        snapshot.status = 'completed';
        snapshot.stopReason = 'end_turn';
      }
      emitUpdate();
      return snapshot;
    } finally {
      this.activeSessions.delete(snapshot.taskId);
    }
  }

  async steerLive(taskId, { action, message }) {
    const runtime = this.activeSessions.get(taskId);
    if (!runtime) return { handledLive: false };
    if (action === 'interrupt') {
      await this.abort(taskId);
      return { handledLive: true };
    }
    if (action === 'reply') {
      if (!message || !String(message).trim()) {
        throw new Error('Steer action "reply" requires a non-empty message.');
      }
      throw new Error('An active Antigravity CLI turn cannot accept a live reply.');
    }
    return { handledLive: false };
  }

  async abort(taskId) {
    const runtime = this.activeSessions.get(taskId);
    if (!runtime) return false;
    runtime.aborted = true;
    runtime.snapshot.status = 'aborted';
    runtime.snapshot.stopReason = 'aborted';
    runtime.emitUpdate();
    if (runtime.child) await killProcessTree(runtime.child);
    return true;
  }
}
