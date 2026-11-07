/**
 * Antigravity CLI and SDK bridge driver for one-shot H2H turns.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPresetPrompt,
  buildResumeCommandHint,
  formatDiagnosticSummary,
} from '../protocol/schema.js';
import { killProcessTree, resolveExecutable } from '../transports/local.js';
import { buildPosixCommandLine, buildSshArgs } from '../transports/ssh.js';

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
      const match = record.match(/^(?:session(?:[ _-]?id)?|conversation(?:[ _-]?id)?)\s*[:=]\s*(\S+)\s*$/i);
      if (match) sessionId = match[1];
      else if (record.trim()) text.push(record);
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    sessionId = record.sessionId || record.session_id || record.conversationId ||
      record.conversation_id || record.session?.id || record.conversation?.id || sessionId;
    const message = record.output ?? record.response ?? record.text ?? record.message;
    if (typeof message === 'string' && message) text.push(message);
  }
  return { output: text.join('\n').trim(), sessionId };
}

function agentApiConversationId(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  for (const candidate of [stdout.trim(), ...lines.reverse()]) {
    try {
      const result = JSON.parse(candidate);
      const id = result?.response?.newConversation?.conversationId;
      if (id) return id;
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  throw new Error('agentapi new-conversation did not return a conversationId.');
}

function readTranscript(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export class AntigravityDriver {
  constructor(targetConfig = {}) {
    this.targetConfig = targetConfig;
    this.activeSessions = new Map();
  }

  async runTurn(snapshot, { prompt, envVars = {}, timeoutMs = 600000 }, onUpdate = () => {}) {
    const startedAt = Date.now();
    const transportConfig = this.targetConfig.transport;
    const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
    const driverMode = typeof this.targetConfig.driver === 'object'
      ? this.targetConfig.driver.mode
      : this.targetConfig.mode || this.targetConfig.driver;
    const isSdk = driverMode === 'antigravity-sdk';
    const configuredCommand = this.targetConfig.command || this.targetConfig.binaryPath;
    const remoteCommand = configuredCommand && configuredCommand !== 'auto'
      ? configuredCommand
      : isSdk ? 'python' : 'agy';
    const command = isSsh ? remoteCommand : resolveExecutable(remoteCommand, 'antigravity');
    if (/\bagentapi(?:\.bat|\.cmd|\.exe)?$/i.test(command) || driverMode === 'agentapi') {
      return this._runAgentApi(snapshot, { prompt, envVars, timeoutMs }, onUpdate, command);
    }
    const baseArgs = Array.isArray(this.targetConfig.args) ? this.targetConfig.args : [];
    const framedPrompt = applyPresetPrompt(prompt, snapshot.preset);
    const args = [
      ...(isSdk && baseArgs.length === 0 ? ['-m', 'google.antigravity'] : baseArgs),
      '--prompt', framedPrompt,
    ];
    if (snapshot.sessionMode === 'ephemeral') args.push('--ephemeral');
    else if (snapshot.sessionId) args.push('--conversation', snapshot.sessionId);
    if (snapshot.reinPolicy === 'plan-only') args.push('--read-only');
    else if (snapshot.reinPolicy === 'free-rein' || snapshot.reinPolicy === 'auto-edit') {
      args.push('--allow-write', '--allow-exec');
    }

    const env = { ...(this.targetConfig.env || {}), ...envVars };
    const spawnCommand = isSsh ? 'ssh' : command;
    const spawnArgs = isSsh
      ? buildSshArgs(transportConfig, buildPosixCommandLine(command, args, snapshot.cwd, env))
      : args;
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
      snapshot.metrics.durationMs = Math.max(0, Date.now() - Date.parse(snapshot.metrics.startedAt || startedAt));
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

    const runtime = { child: null, aborted: false, timedOut: false, snapshot, emitUpdate };
    this.activeSessions.set(snapshot.taskId, runtime);
    try {
      const result = await new Promise((resolve) => {
        let child;
        try {
          child = spawn(spawnCommand, spawnArgs, {
            cwd: isSsh ? process.cwd() : snapshot.cwd || process.cwd(),
            env: isSsh ? process.env : { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
            shell: !isSsh && process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
          });
        } catch (error) {
          resolve({ error });
          return;
        }
        runtime.child = child;
        let stdout = '';
        let stderr = '';
        let error = null;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (err) => { error = err; });
        child.on('close', (exitCode, signal) => {
          resolve({ stdout, stderr, exitCode, signal, error });
        });
        if (timeoutMs > 0) {
          runtime.timer = setTimeout(() => {
            runtime.timedOut = true;
            killProcessTree(child).catch(() => {});
          }, timeoutMs);
        }
      });
      if (runtime.aborted) {
        snapshot.status = 'aborted';
        snapshot.stopReason = 'aborted';
      } else if (runtime.timedOut || result.error || result.exitCode !== 0) {
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error = runtime.timedOut
          ? `Antigravity turn timed out after ${timeoutMs}ms.`
          : result.error?.message || result.stderr?.trim() ||
            `Antigravity process exited with code=${result.exitCode} signal=${result.signal}.`;
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
      if (runtime.timer) clearTimeout(runtime.timer);
      this.activeSessions.delete(snapshot.taskId);
    }
  }

  async _runAgentApi(snapshot, { prompt, envVars, timeoutMs }, onUpdate, resolvedCommand) {
    const startedAt = Date.now();
    const deadline = timeoutMs > 0 ? startedAt + timeoutMs : Infinity;
    const home = this.targetConfig.antigravityHome || path.join(os.homedir(), '.gemini', 'antigravity');
    const framedPrompt = applyPresetPrompt(prompt, snapshot.preset);
    const createdNew = !snapshot.sessionId;
    let command = resolvedCommand;
    const prefixArgs = [...(Array.isArray(this.targetConfig.args) ? this.targetConfig.args : [])];
    if (/\.bat$/i.test(command) && process.platform === 'win32' && process.env.LOCALAPPDATA) {
      const languageServer = path.join(
        process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe',
      );
      if (fs.existsSync(languageServer)) {
        command = languageServer;
        prefixArgs.unshift('agentapi');
      }
    } else if (/language_server\.exe$/i.test(command)) {
      prefixArgs.unshift('agentapi');
    }

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
      snapshot.metrics.durationMs = Math.max(0, Date.now() - Date.parse(snapshot.metrics.startedAt || startedAt));
      snapshot.diagnostic = formatDiagnosticSummary(snapshot);
      onUpdate(snapshot);
    };

    const runtime = { child: null, aborted: false, snapshot, emitUpdate };
    this.activeSessions.set(snapshot.taskId, runtime);
    snapshot.status = 'running';
    snapshot.stopReason = undefined;
    snapshot.error = undefined;
    snapshot.output = '';
    snapshot.metrics.turnCount = (snapshot.metrics.turnCount || 0) + 1;
    appendEvent({ role: 'user', phase: 'input', text: framedPrompt });
    emitUpdate();

    try {
      let transcriptPath;
      let previousUserIndex = -1;
      if (!createdNew) {
        transcriptPath = this._agentApiTranscriptPath(home, snapshot.sessionId);
        const previous = readTranscript(transcriptPath);
        previousUserIndex = previous.map((step) => step.type).lastIndexOf('USER_INPUT');
      }
      const args = createdNew
        ? ['new-conversation', ...(snapshot.model ? [`--model=${snapshot.model}`] : []), '--title=Reins H2H Task', framedPrompt]
        : ['send-message', snapshot.sessionId, framedPrompt];
      const result = await new Promise((resolve) => {
        let child;
        try {
          child = spawn(command, [...prefixArgs, ...args], {
            cwd: snapshot.cwd || process.cwd(),
            env: { ...process.env, ...(this.targetConfig.env || {}), ...envVars },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
            shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
          });
        } catch (error) {
          resolve({ error });
          return;
        }
        runtime.child = child;
        let stdout = '';
        let stderr = '';
        let error = null;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (caught) => { error = caught; });
        child.on('close', (exitCode) => {
          resolve({ stdout, stderr, exitCode, error });
        });
        if (Number.isFinite(deadline)) {
          runtime.timer = setTimeout(() => {
            runtime.timedOut = true;
            killProcessTree(child).catch(() => {});
          }, Math.max(1, deadline - Date.now()));
        }
      });
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.child = null;
      if (runtime.aborted) throw new Error('Antigravity turn aborted.');
      if (runtime.timedOut) throw new Error(`Antigravity turn timed out after ${timeoutMs}ms.`);
      if (result.error || result.exitCode !== 0) {
        throw new Error(result.error?.message || result.stderr?.trim() || `agentapi exited with code ${result.exitCode}.`);
      }
      if (createdNew) snapshot.sessionId = agentApiConversationId(result.stdout);
      transcriptPath = this._agentApiTranscriptPath(home, snapshot.sessionId);
      snapshot.resumeCommandHint = buildResumeCommandHint({
        kind: 'antigravity',
        sessionId: snapshot.sessionId,
        sessionMode: snapshot.sessionMode,
        transportType: 'local',
      });
      emitUpdate();

      while (Date.now() < deadline && !runtime.aborted) {
        const steps = readTranscript(transcriptPath);
        const userIndex = steps.map((step) => step.type).lastIndexOf('USER_INPUT');
        if (userIndex > previousUserIndex) {
          for (const step of steps.slice(userIndex + 1)) {
            if (step.type !== 'PLANNER_RESPONSE') continue;
            if (step.status === 'ERROR') {
              throw new Error(typeof step.content === 'string' ? step.content : 'Antigravity planner failed.');
            }
            if (step.status === 'DONE' && (!Array.isArray(step.tool_calls) || step.tool_calls.length === 0) &&
                typeof step.content === 'string') {
              snapshot.output = step.content.trim();
              if (typeof step.thinking === 'string') snapshot.commentary = step.thinking;
              const tokens = {
                inputTokens: step.input_tokens,
                outputTokens: step.output_tokens,
                cacheReadTokens: step.cache_read_tokens,
              };
              if (Object.values(tokens).some(Number.isFinite)) snapshot.metrics.tokens = tokens;
              appendEvent({ role: 'assistant', phase: 'final_answer', text: snapshot.output });
              snapshot.status = 'completed';
              snapshot.stopReason = 'end_turn';
              emitUpdate();
              if (snapshot.sessionMode === 'ephemeral' && createdNew) {
                fs.rmSync(path.join(home, 'brain', snapshot.sessionId), { recursive: true, force: true, maxRetries: 3 });
                fs.rmSync(path.join(home, 'conversations', `${snapshot.sessionId}.pb`), { force: true, maxRetries: 3 });
                fs.rmSync(path.join(home, 'annotations', `${snapshot.sessionId}.pbtxt`), { force: true, maxRetries: 3 });
              }
              return snapshot;
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (runtime.aborted) throw new Error('Antigravity turn aborted.');
      throw new Error(`Antigravity turn timed out after ${timeoutMs}ms waiting for transcript.`);
    } catch (error) {
      snapshot.status = runtime.aborted ? 'aborted' : 'failed';
      snapshot.stopReason = runtime.aborted ? 'aborted' : 'error';
      if (!runtime.aborted) snapshot.error = error.message || String(error);
      emitUpdate();
      return snapshot;
    } finally {
      if (runtime.timer) clearTimeout(runtime.timer);
      this.activeSessions.delete(snapshot.taskId);
    }
  }

  _agentApiTranscriptPath(home, sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId || '')) {
      throw new Error('Invalid Antigravity conversation ID.');
    }
    return path.join(home, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
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
