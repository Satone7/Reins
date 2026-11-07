/**
 * DeepSeek Harness driver over ACP JSON-RPC stdio or SSH.
 */

import {
  applyPresetPrompt,
  buildResumeCommandHint,
  formatDiagnosticSummary,
} from '../protocol/schema.js';
import { resolveExecutable } from '../transports/local.js';
import { createJsonRpcTransport } from '../transports/ssh.js';

function findAllowOption(options) {
  return options?.find((option) =>
    option.optionId !== undefined &&
    [option.kind, option.name, option.title, option.label].some((value) =>
      /^(allow|approve)(?:\b|_)/i.test(value || '')));
}

function isUnsupportedMethod(error) {
  return error?.code === -32601 || /method not found|unsupported/i.test(error?.message || '');
}

export class DshDriver {
  constructor(targetConfig = {}) {
    this.targetConfig = targetConfig;
    this.activeSessions = new Map();
  }

  async runTurn(snapshot, { prompt, envVars = {}, timeoutMs = 600000 }, onUpdate = () => {}) {
    const transportConfig = this.targetConfig.transport;
    const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
    const configuredCommand = this.targetConfig.command || 'auto';
    const command = isSsh
      ? (configuredCommand === 'auto' ? 'dsh' : configuredCommand)
      : resolveExecutable(configuredCommand, 'dsh');
    const transport = createJsonRpcTransport({
      transportConfig,
      command,
      args: Array.isArray(this.targetConfig.args) ? this.targetConfig.args : [],
      cwd: snapshot.cwd || (isSsh ? undefined : process.cwd()),
      env: { ...(this.targetConfig.env || {}), ...envVars },
    });
    const startTimeMs = Date.now();
    const runtime = {
      transport,
      snapshot,
      onUpdate,
      pendingApproval: null,
      aborted: false,
      timedOut: false,
    };
    this.activeSessions.set(snapshot.taskId, runtime);

    const emitUpdate = () => {
      snapshot.metrics.updatedAt = new Date().toISOString();
      snapshot.metrics.durationMs = Math.max(0, Date.now() - startTimeMs);
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

    transport.on('notification', (method, params) => {
      if (method !== 'session/update' ||
          (params?.sessionId && params.sessionId !== snapshot.sessionId)) return;
      const update = params.update || {};
      const content = update.content;
      const text = content?.type === 'text' ? content.text || '' : '';
      if (update.sessionUpdate === 'agent_thought_chunk') {
        snapshot.commentary = `${snapshot.commentary || ''}${text}`;
      } else if (update.sessionUpdate === 'tool_call') {
        appendEvent({ role: 'tool', phase: 'tool_call', toolCall: update });
      } else if (update.sessionUpdate === 'agent_message_chunk' || content?.type === 'text') {
        snapshot.output = `${snapshot.output || ''}${text}`;
      } else {
        return;
      }
      emitUpdate();
    });

    transport.on('request', (id, method, params) => {
      if (method !== 'session/request_permission') {
        transport.respondError(id, -32601, `Unhandled ACP request: ${method}`);
        return;
      }
      const respond = (approved) => {
        const allowOption = approved ? findAllowOption(params?.options) : null;
        transport.respond(id, {
          outcome: allowOption
            ? { outcome: 'selected', optionId: allowOption.optionId }
            : { outcome: 'cancelled' },
        });
      };
      if (snapshot.reinPolicy === 'free-rein' || snapshot.reinPolicy === 'auto-edit') {
        respond(true);
      } else if (snapshot.reinPolicy === 'plan-only') {
        respond(false);
      } else {
        snapshot.status = 'attention_required';
        snapshot.attention = {
          requestId: String(id),
          method,
          summary: params?.toolCall?.title || 'DeepSeek Harness requested permission.',
          params,
          createdAt: new Date().toISOString(),
        };
        runtime.pendingApproval = { respond };
        emitUpdate();
      }
    });

    transport.on('error', (error) => {
      runtime.transportError = error;
    });

    snapshot.status = 'running';
    snapshot.stopReason = undefined;
    snapshot.error = undefined;
    snapshot.output = '';
    appendEvent({ role: 'user', phase: 'input', text: applyPresetPrompt(prompt, snapshot.preset) });
    emitUpdate();

    if (timeoutMs > 0) {
      runtime.timer = setTimeout(() => {
        runtime.timedOut = true;
        transport.close().catch(() => {});
      }, timeoutMs);
    }

    try {
      transport.start();
      await transport.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: 'reins', version: '0.1.0' },
      }, 20000);

      const sessionParams = { cwd: snapshot.cwd, mcpServers: [] };
      if (snapshot.sessionId) {
        try {
          await transport.request('session/load', {
            sessionId: snapshot.sessionId,
            ...sessionParams,
          }, 30000);
        } catch (error) {
          if (!isUnsupportedMethod(error)) throw error;
          const created = await transport.request('session/new', {
            ...sessionParams,
            _meta: { ephemeral: snapshot.sessionMode === 'ephemeral', reinPolicy: snapshot.reinPolicy },
          }, 30000);
          snapshot.sessionId = created?.sessionId;
        }
      } else {
        const created = await transport.request('session/new', {
          ...sessionParams,
          _meta: { ephemeral: snapshot.sessionMode === 'ephemeral', reinPolicy: snapshot.reinPolicy },
        }, 30000);
        snapshot.sessionId = created?.sessionId;
      }
      if (!snapshot.sessionId) throw new Error('ACP session/new did not return a sessionId.');
      snapshot.resumeCommandHint = buildResumeCommandHint({
        kind: 'dsh',
        sessionId: snapshot.sessionId,
        sessionMode: snapshot.sessionMode,
        transportType: isSsh ? 'ssh' : 'local',
        sshHost: transportConfig?.host || transportConfig?.sshHost,
      });
      emitUpdate();

      snapshot.metrics.turnCount = (snapshot.metrics.turnCount || 0) + 1;
      runtime.promptPromise = transport.request('session/prompt', {
        sessionId: snapshot.sessionId,
        prompt: [{ type: 'text', text: applyPresetPrompt(prompt, snapshot.preset) }],
      }, timeoutMs);
      const result = await runtime.promptPromise;
      if (runtime.aborted || result?.stopReason === 'cancelled') {
        snapshot.status = 'aborted';
        snapshot.stopReason = 'aborted';
      } else if (result?.stopReason && result.stopReason !== 'end_turn') {
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error = `ACP session/prompt stopped: ${result.stopReason}`;
      } else {
        appendEvent({ role: 'assistant', phase: 'final_answer', text: snapshot.output });
        snapshot.status = 'completed';
        snapshot.stopReason = 'end_turn';
      }
    } catch (error) {
      if (runtime.aborted) {
        snapshot.status = 'aborted';
        snapshot.stopReason = 'aborted';
      } else {
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error = runtime.timedOut
          ? `DeepSeek Harness turn timed out after ${timeoutMs}ms.`
          : runtime.transportError?.message || error.message || String(error);
      }
    } finally {
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.pendingApproval = null;
      this.activeSessions.delete(snapshot.taskId);
      emitUpdate();
      await transport.close().catch(() => {});
    }
    return snapshot;
  }

  async steerLive(taskId, { action, message }) {
    const runtime = this.activeSessions.get(taskId);
    if (!runtime) return { handledLive: false };
    if (action === 'approve' || action === 'reject') {
      if (!runtime.pendingApproval) {
        throw new Error(`Task "${taskId}" has no pending permission request.`);
      }
      const approval = runtime.pendingApproval;
      runtime.pendingApproval = null;
      runtime.snapshot.attention = undefined;
      runtime.snapshot.status = 'running';
      runtime.emitUpdate();
      approval.respond(action === 'approve');
      return { handledLive: true };
    }
    if (action === 'interrupt') {
      await this.abort(taskId);
      return { handledLive: true };
    }
    if (action === 'reply') {
      if (!message || !String(message).trim()) {
        throw new Error('Steer action "reply" requires a non-empty message.');
      }
      throw new Error('An active ACP turn cannot accept a live reply.');
    }
    return { handledLive: false };
  }

  async abort(taskId) {
    const runtime = this.activeSessions.get(taskId);
    if (!runtime) return false;
    runtime.aborted = true;
    runtime.snapshot.status = 'aborted';
    runtime.snapshot.stopReason = 'aborted';
    runtime.snapshot.attention = undefined;
    runtime.emitUpdate();
    if (runtime.snapshot.sessionId) {
      try {
        runtime.transport.notify('session/cancel', { sessionId: runtime.snapshot.sessionId });
        if (runtime.promptPromise) {
          let graceTimer;
          await Promise.race([
            runtime.promptPromise.catch(() => {}),
            new Promise((resolve) => { graceTimer = setTimeout(resolve, 250); }),
          ]);
          clearTimeout(graceTimer);
        }
      } catch {
        // The process may already have exited.
      }
    }
    await runtime.transport.close();
    return true;
  }
}
