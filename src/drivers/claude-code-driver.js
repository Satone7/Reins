/**
 * Claude Code stream-json driver with optional persistent tmux handoff.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import {
  applyPresetPrompt,
  buildResumeCommandHint,
  formatDiagnosticSummary,
} from '../protocol/schema.js';
import { killProcessTree, resolveExecutable } from '../transports/local.js';
import { buildPosixCommandLine, buildSshArgs } from '../transports/ssh.js';

const PERMISSION_MODES = {
  'free-rein': 'bypassPermissions',
  'auto-edit': 'acceptEdits',
  'plan-only': 'plan',
  'parent-rein': 'default',
  'tight-rein': 'default',
};

function runCommand({ command, args, cwd, env, transportConfig, timeoutMs, onLine, runtime }) {
  const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
  const executable = isSsh ? 'ssh' : resolveExecutable(command, 'claude-code');
  const commandArgs = isSsh
    ? ['-n', ...buildSshArgs(transportConfig, buildPosixCommandLine(command, args, cwd, env))]
    : args;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, commandArgs, {
        cwd: isSsh ? process.cwd() : cwd || process.cwd(),
        env: isSsh ? process.env : { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: !isSsh && process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable),
      });
    } catch (error) {
      resolve({ error });
      return;
    }
    if (runtime) runtime.child = child;
    let stdout = '';
    let stderr = '';
    let error = null;
    let timedOut = false;
    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
      stdout += `${line}\n`;
      if (onLine) {
        try {
          onLine(line);
        } catch (caught) {
          error = caught;
          killProcessTree(child).catch(() => {});
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (caught) => { error = caught; });
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killProcessTree(child).catch(() => {});
    }, timeoutMs) : null;
    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      if (runtime?.child === child) runtime.child = null;
      resolve({ stdout, stderr, exitCode, signal, error, timedOut });
    });
  });
}

export class ClaudeCodeDriver {
  constructor(targetConfig = {}) {
    this.targetConfig = targetConfig;
    this.activeSessions = new Map();
    this.tmuxSessions = new Map();
  }

  async listModels() {
    return {
      targetId: this.targetConfig.id || 'claude-code',
      kind: 'claude-code',
      currentConfig: {
        model: this.targetConfig.model || null,
        effort: this.targetConfig.effort || null,
        provider: 'anthropic',
      },
      models: [
        {
          id: 'sonnet',
          model: 'sonnet',
          displayName: 'Claude Sonnet',
          description: 'Balanced intelligence and speed for everyday coding tasks.',
          isDefault: true,
          defaultEffort: 'medium',
          supportedEfforts: ['low', 'medium', 'high', 'max'],
          inputModalities: ['text', 'image'],
        },
        {
          id: 'opus',
          model: 'opus',
          displayName: 'Claude Opus',
          description: 'Frontier model for complex architecture and deep reasoning.',
          isDefault: false,
          defaultEffort: 'high',
          supportedEfforts: ['low', 'medium', 'high', 'max'],
          inputModalities: ['text', 'image'],
        },
        {
          id: 'haiku',
          model: 'haiku',
          displayName: 'Claude Haiku',
          description: 'Fast and lightweight model for quick tasks.',
          isDefault: false,
          defaultEffort: 'low',
          supportedEfforts: ['low', 'medium', 'high'],
          inputModalities: ['text', 'image'],
        },
      ],
    };
  }

  _transportConfig() {
    return this.targetConfig.transport;
  }

  _claudeCommand() {
    const configured = this.targetConfig.command || 'auto';
    const isSsh = this._transportConfig()?.type === 'ssh' || this._transportConfig()?.kind === 'ssh';
    return isSsh ? (configured === 'auto' ? 'claude' : configured) : resolveExecutable(configured, 'claude-code');
  }

  _tmuxSessionName(snapshot) {
    const shortId = String(snapshot.sessionId || snapshot.taskId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    const name = snapshot.tmuxSession || this.targetConfig.tmuxSession ||
      `${this.targetConfig.tmuxPrefix || 'reins-claude'}-${shortId}`;
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error(`Invalid tmux session name: ${name}`);
    }
    return name;
  }

  async _tmux(args, snapshot, env = {}) {
    const command = this.targetConfig.tmuxCommand || 'tmux';
    const prefixArgs = Array.isArray(this.targetConfig.tmuxArgs) ? this.targetConfig.tmuxArgs : [];
    return runCommand({
      command,
      args: [...prefixArgs, ...args],
      cwd: snapshot.cwd,
      env: { ...(this.targetConfig.env || {}), ...env },
      transportConfig: this._transportConfig(),
      timeoutMs: 10000,
    });
  }

  async _ensureTmux(snapshot, env) {
    if (!snapshot.sessionId) throw new Error('Claude Code did not return a session ID for tmux resumption.');
    const name = this._tmuxSessionName(snapshot);
    const existing = await this._tmux(['has-session', '-t', `=${name}`], snapshot, env);
    if (existing.error || existing.timedOut || (existing.exitCode !== 0 && existing.exitCode !== 1)) {
      throw new Error(existing.error?.message || existing.stderr?.trim() || 'Unable to inspect the tmux session.');
    }
    if (existing.exitCode === 1) {
      const claudeCommand = buildPosixCommandLine(
        this._claudeCommand(),
        [...(Array.isArray(this.targetConfig.args) ? this.targetConfig.args : []), '--resume', snapshot.sessionId],
        undefined,
        env,
      );
      const created = await this._tmux([
        'new-session', '-d', '-s', name, '-c', snapshot.cwd || process.cwd(), claudeCommand,
      ], snapshot, env);
      if (created.error || created.timedOut || created.exitCode !== 0) {
        throw new Error(created.error?.message || created.stderr?.trim() || 'Unable to create the tmux session.');
      }
    }
    return name;
  }

  async runTurn(snapshot, { prompt, envVars = {}, timeoutMs = 3600000 }, onUpdate = () => {}) {
    const startedAt = Date.now();
    const transportConfig = this._transportConfig();
    const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
    const mode = typeof this.targetConfig.driver === 'object'
      ? this.targetConfig.driver.mode
      : this.targetConfig.mode || this.targetConfig.driver;
    const tmuxMode = mode === 'claude-tmux' && snapshot.sessionMode === 'persistent';
    const command = this._claudeCommand();
    const framedPrompt = applyPresetPrompt(prompt, snapshot.preset);
    const args = [
      ...(Array.isArray(this.targetConfig.args) ? this.targetConfig.args : []),
      '-p', framedPrompt, '--output-format', 'stream-json', '--verbose',
    ];
    if (snapshot.sessionId) args.push('--resume', snapshot.sessionId);
    if (snapshot.sessionMode === 'ephemeral') args.push('--no-session-persistence');
    const effectiveModel = snapshot.model || this.targetConfig.model;
    const effectiveEffort = snapshot.effort || this.targetConfig.effort;
    if (effectiveModel) args.push('--model', effectiveModel);
    if (effectiveEffort) args.push('--effort', effectiveEffort);
    args.push('--permission-mode', PERMISSION_MODES[snapshot.reinPolicy] || 'default');

    const env = { ...(this.targetConfig.env || {}), ...envVars };
    if (effectiveModel) env.DEEPSEEK_MODEL ||= effectiveModel;
    if (process.env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY ||= process.env.DEEPSEEK_API_KEY;
    if (process.env.DEEPSEEK_BASE_URL) env.DEEPSEEK_BASE_URL ||= process.env.DEEPSEEK_BASE_URL;
    const runtime = { child: null, aborted: false, snapshot, onUpdate };
    this.activeSessions.set(snapshot.taskId, runtime);
    const emitUpdate = () => {
      snapshot.metrics.updatedAt = new Date().toISOString();
      snapshot.metrics.durationMs = runtime.cliDurationMs ?? Math.max(0, Date.now() - startedAt);
      snapshot.diagnostic = formatDiagnosticSummary(snapshot);
      onUpdate(snapshot);
    };
    runtime.emitUpdate = emitUpdate;
    const appendEvent = (event) => {
      snapshot.transcript.lastSeq += 1;
      snapshot.transcript.totalEvents += 1;
      snapshot.transcript.messages.push({
        seq: snapshot.transcript.lastSeq,
        timestamp: new Date().toISOString(),
        ...event,
      });
    };
    snapshot.status = 'running';
    snapshot.stopReason = undefined;
    snapshot.error = undefined;
    snapshot.output = '';
    snapshot.metrics.turnCount = (snapshot.metrics.turnCount || 0) + 1;
    appendEvent({ role: 'user', phase: 'input', text: framedPrompt });
    emitUpdate();

    try {
      const result = await runCommand({
        command,
        args,
        cwd: snapshot.cwd,
        env,
        transportConfig,
        timeoutMs,
        runtime,
        onLine: (line) => {
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.session_id) snapshot.sessionId = event.session_id;
          if (event.type === 'assistant') {
            const blocks = event.message?.content || [];
            for (const block of blocks) {
              if (block.type === 'text' && block.text) {
                snapshot.output = snapshot.output ? `${snapshot.output}\n${block.text}` : block.text;
              } else if (block.type === 'tool_use') {
                appendEvent({ role: 'tool', phase: 'tool_call', toolCall: block });
              }
            }
          } else if (event.type === 'result') {
            if (typeof event.result === 'string') snapshot.output = event.result;
            if (Number.isFinite(event.total_cost_usd)) {
              snapshot.metrics.costUsd = (snapshot.metrics.costUsd || 0) + event.total_cost_usd;
            }
            if (Number.isFinite(event.duration_ms)) runtime.cliDurationMs = event.duration_ms;
            if (event.is_error) runtime.resultError = event.result || 'Claude Code reported an error.';
          }
          emitUpdate();
        },
      });

      if (runtime.aborted) {
        snapshot.status = 'aborted';
        snapshot.stopReason = 'aborted';
      } else if (result.error || result.timedOut || result.exitCode !== 0 || runtime.resultError) {
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error = result.timedOut
          ? `Claude Code turn timed out after ${timeoutMs}ms.`
          : result.error?.message || runtime.resultError || result.stderr?.trim() ||
            `Claude Code exited with code=${result.exitCode} signal=${result.signal}.`;
      } else {
        if (tmuxMode) {
          snapshot.tmuxSession = await this._ensureTmux(snapshot, env);
          this.tmuxSessions.set(snapshot.taskId, snapshot);
        }
        snapshot.resumeCommandHint = buildResumeCommandHint({
          kind: 'claude-code',
          sessionId: snapshot.sessionId,
          sessionMode: snapshot.sessionMode,
          transportType: isSsh ? 'ssh' : 'local',
          sshHost: transportConfig?.host || transportConfig?.sshHost,
          tmuxSession: tmuxMode ? snapshot.tmuxSession : undefined,
        });
        appendEvent({ role: 'assistant', phase: 'final_answer', text: snapshot.output });
        snapshot.status = 'completed';
        snapshot.stopReason = 'end_turn';
      }
    } catch (error) {
      snapshot.status = runtime.aborted ? 'aborted' : 'failed';
      snapshot.stopReason = runtime.aborted ? 'aborted' : 'error';
      if (!runtime.aborted) snapshot.error = error.message || String(error);
    } finally {
      this.activeSessions.delete(snapshot.taskId);
      emitUpdate();
    }
    return snapshot;
  }

  async steerLive(taskId, { action, message, snapshot } = {}) {
    const runtime = this.activeSessions.get(taskId);
    if (runtime) {
      if (action === 'interrupt') {
        await this.abort(taskId);
        return { handledLive: true };
      }
      if (action === 'reply') {
        throw new Error('An active Claude Code print turn cannot accept a live reply.');
      }
      return { handledLive: false };
    }

    const session = this.tmuxSessions.get(taskId) || snapshot;
    if (!session?.tmuxSession || session.sessionMode !== 'persistent') {
      return { handledLive: false };
    }
    if (action === 'reply') {
      if (!message || !String(message).trim()) {
        throw new Error('Steer action "reply" requires a non-empty message.');
      }
      return { handledLive: false };
    }
    if (action === 'interrupt') {
      await this.abort(taskId, session);
      return { handledLive: true, snapshot: session };
    }
    if (action !== 'approve' && action !== 'reject') return { handledLive: false };
    const key = action === 'approve' ? 'y' : 'n';
    const result = await this._tmux(['send-keys', '-t', `=${session.tmuxSession}`, key, 'Enter'], session);
    if (result.error || result.timedOut || result.exitCode !== 0) {
      throw new Error(result.error?.message || result.stderr?.trim() || 'Unable to steer the tmux session.');
    }
    return { handledLive: true };
  }

  async abort(taskId, snapshot) {
    const runtime = this.activeSessions.get(taskId);
    if (runtime) {
      runtime.aborted = true;
      runtime.snapshot.status = 'aborted';
      runtime.snapshot.stopReason = 'aborted';
      runtime.emitUpdate();
      if (runtime.child) await killProcessTree(runtime.child);
      return true;
    }
    const session = this.tmuxSessions.get(taskId) || snapshot;
    if (!session?.tmuxSession) return false;
    const result = await this._tmux(['send-keys', '-t', `=${session.tmuxSession}`, 'C-c'], session);
    if (result.error || result.timedOut || result.exitCode !== 0) {
      throw new Error(result.error?.message || result.stderr?.trim() || 'Unable to interrupt the tmux session.');
    }
    session.status = 'aborted';
    session.stopReason = 'aborted';
    this.tmuxSessions.delete(taskId);
    return true;
  }
}
