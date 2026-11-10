/**
 * DeepSeek Harness driver over ACP JSON-RPC stdio or headless JSONL stream.
 *
 * Thin, version-agnostic protocol driver that delegates via `createJsonRpcTransport`
 * (for ACP mode) or `runStreamingProcess` (for headless CLI mode) without scraping
 * private `~/.dsh/.credentials.yaml` files via custom `awk` scripts.
 */

import {
  applyPresetPrompt,
  buildResumeCommandHint,
  formatDiagnosticSummary,
} from '../protocol/schema.js';
import { killProcessTree, resolveExecutable } from '../transports/local.js';
import { createJsonRpcTransport, runStreamingProcess } from '../transports/ssh.js';

function findAllowOption(options) {
  return options?.find(
    (option) =>
      option.optionId !== undefined &&
      [option.kind, option.name, option.title, option.label].some((value) =>
        /^(allow|approve)(?:\b|_)/i.test(value || ''),
      ),
  );
}

function isUnsupportedMethod(error) {
  return error?.code === -32601 || /method not found|unsupported/i.test(error?.message || '');
}

export class DshDriver {
  constructor(targetConfig = {}) {
    this.targetConfig = targetConfig;
    this.activeSessions = new Map();
  }

  async listModels() {
    return {
      targetId: this.targetConfig.id || 'local-dsh',
      kind: 'dsh',
      currentConfig: {
        model: this.targetConfig.model || process.env.REINS_TEST_MODEL || 'deepseek-flash',
        effort: this.targetConfig.effort || null,
        provider: 'deepseek',
      },
      models: [
        {
          id: 'deepseek-flash',
          model: 'deepseek-flash',
          displayName: 'DeepSeek Flash',
          description: 'Fast, low-latency DeepSeek model for coding and automated verification.',
          isDefault: true,
          defaultEffort: 'low',
          supportedEfforts: ['low', 'medium', 'high'],
          inputModalities: ['text'],
        },
        {
          id: 'deepseek-chat',
          model: 'deepseek-chat',
          displayName: 'DeepSeek V3 / Chat',
          description: 'General-purpose coding and agentic tool-use model.',
          isDefault: false,
          defaultEffort: 'medium',
          supportedEfforts: ['low', 'medium', 'high'],
          inputModalities: ['text'],
        },
        {
          id: 'deepseek-reasoner',
          model: 'deepseek-reasoner',
          displayName: 'DeepSeek R1 / Reasoner',
          description: 'Deep reasoning model for complex analysis and debugging.',
          isDefault: false,
          defaultEffort: 'high',
          supportedEfforts: ['medium', 'high', 'max'],
          inputModalities: ['text'],
        },
      ],
    };
  }

  async runTurn(snapshot, { prompt, envVars = {}, timeoutMs = 600000 }, onUpdate = () => {}) {
    const configuredArgs = Array.isArray(this.targetConfig.args) ? this.targetConfig.args : [];
    if (this.targetConfig.driver === 'dsh-headless' || configuredArgs.includes('headless')) {
      return this._runHeadless(snapshot, { prompt, envVars, timeoutMs }, onUpdate);
    }
    const transportConfig = this.targetConfig.transport;
    const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
    const configuredCommand = this.targetConfig.command || 'auto';
    const command = isSsh
      ? configuredCommand === 'auto'
        ? 'dsh'
        : configuredCommand
      : resolveExecutable(configuredCommand, 'dsh');
    const effectiveModel = snapshot.model || this.targetConfig.model;
    const env = { ...(this.targetConfig.env || {}), ...envVars };
    if (effectiveModel) env.DEEPSEEK_MODEL ||= effectiveModel;
    if (process.env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY ||= process.env.DEEPSEEK_API_KEY;
    if (process.env.DEEPSEEK_BASE_URL) env.DEEPSEEK_BASE_URL ||= process.env.DEEPSEEK_BASE_URL;
    const transport = createJsonRpcTransport({
      transportConfig,
      command,
      args: Array.isArray(this.targetConfig.args) ? this.targetConfig.args : [],
      cwd: snapshot.cwd || (isSsh ? undefined : process.cwd()),
      env,
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
      if (
        method !== 'session/update' ||
        (params?.sessionId && params.sessionId !== snapshot.sessionId)
      ) {
        return;
      }
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
      await transport.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
          clientInfo: { name: 'reins', version: '0.1.0' },
        },
        20000,
      );

      const sessionParams = { cwd: snapshot.cwd, mcpServers: [] };
      if (snapshot.sessionId) {
        try {
          await transport.request(
            'session/load',
            {
              sessionId: snapshot.sessionId,
              ...sessionParams,
            },
            30000,
          );
        } catch (error) {
          if (!isUnsupportedMethod(error)) throw error;
          const created = await transport.request(
            'session/new',
            {
              ...sessionParams,
              _meta: {
                ephemeral: snapshot.sessionMode === 'ephemeral',
                reinPolicy: snapshot.reinPolicy,
              },
            },
            30000,
          );
          snapshot.sessionId = created?.sessionId;
        }
      } else {
        const created = await transport.request(
          'session/new',
          {
            ...sessionParams,
            _meta: {
              ephemeral: snapshot.sessionMode === 'ephemeral',
              reinPolicy: snapshot.reinPolicy,
            },
          },
          30000,
        );
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
      runtime.promptPromise = transport.request(
        'session/prompt',
        {
          sessionId: snapshot.sessionId,
          prompt: [{ type: 'text', text: applyPresetPrompt(prompt, snapshot.preset) }],
        },
        timeoutMs,
      );
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

  async _runHeadless(snapshot, { prompt, envVars, timeoutMs }, onUpdate) {
    const startTimeMs = Date.now();
    const transportConfig = this.targetConfig.transport;
    const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
    const configuredCommand = this.targetConfig.command || 'auto';
    const command = isSsh && configuredCommand === 'auto' ? 'dsh' : configuredCommand;
    const framedPrompt = applyPresetPrompt(prompt, snapshot.preset);
    const args = [...(Array.isArray(this.targetConfig.args) ? this.targetConfig.args : [])];
    if (!args.includes('--profile')) args.push('--profile', 'headless');
    if (!args.includes('--json')) args.push('--json');
    if (snapshot.sessionId) args.push('--session-id', snapshot.sessionId);
    args.push(framedPrompt);

    const env = { ...(this.targetConfig.env || {}), ...envVars };
    const effectiveModel = snapshot.model || this.targetConfig.model;
    if (effectiveModel) env.DEEPSEEK_MODEL ||= effectiveModel;
    if (process.env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY ||= process.env.DEEPSEEK_API_KEY;
    if (process.env.DEEPSEEK_BASE_URL) env.DEEPSEEK_BASE_URL ||= process.env.DEEPSEEK_BASE_URL;
    if (isSsh) env.NARB_DISABLE_NATIVE_CACHE ||= '1';

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
      snapshot.metrics.durationMs = Math.max(0, Date.now() - startTimeMs);
      snapshot.diagnostic = formatDiagnosticSummary(snapshot);
      onUpdate(snapshot);
    };
    const runtime = { child: null, snapshot, emitUpdate, aborted: false };
    this.activeSessions.set(snapshot.taskId, runtime);
    snapshot.status = 'running';
    snapshot.stopReason = undefined;
    snapshot.error = undefined;
    snapshot.output = '';
    snapshot.metrics.turnCount = (snapshot.metrics.turnCount || 0) + 1;
    appendEvent({ role: 'user', phase: 'input', text: framedPrompt });
    emitUpdate();

    try {
      const result = await runStreamingProcess({
        command,
        args,
        harnessKind: 'dsh',
        cwd: snapshot.cwd,
        env,
        transportConfig,
        timeoutMs,
        closeRemoteStdin: true,
        runtime,
        onLine: (line) => {
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type === 'session' && event.sessionId) {
            snapshot.sessionId = event.sessionId;
            snapshot.resumeCommandHint = buildResumeCommandHint({
              kind: 'dsh',
              sessionId: snapshot.sessionId,
              sessionMode: snapshot.sessionMode,
              transportType: isSsh ? 'ssh' : 'local',
              sshHost: transportConfig?.host || transportConfig?.sshHost,
            });
          } else if (event.type === 'thinking' && typeof event.text === 'string') {
            snapshot.commentary = `${snapshot.commentary || ''}${event.text}`;
          } else if (event.type === 'text' && typeof event.text === 'string') {
            snapshot.output = `${snapshot.output || ''}${event.text}`;
          } else if (event.type === 'final' && typeof event.text === 'string') {
            snapshot.output = event.text;
          } else if (event.type === 'status' && event.phase === 'step_end' && event.usage) {
            const usage = event.usage;
            const previous = snapshot.metrics.tokens || {};
            snapshot.metrics.tokens = {
              inputTokens:
                (previous.inputTokens || 0) + (usage.inputTokens ?? usage.input_tokens ?? 0),
              outputTokens:
                (previous.outputTokens || 0) + (usage.outputTokens ?? usage.output_tokens ?? 0),
              cacheReadTokens:
                (previous.cacheReadTokens || 0) +
                (usage.cacheReadTokens ?? usage.cache_read_tokens ?? 0),
            };
          } else if (event.type === 'status' && event.phase === 'turn_end') {
            runtime.turnReason = event.reason;
          }
          emitUpdate();
        },
      });

      if (runtime.aborted) {
        snapshot.status = 'aborted';
        snapshot.stopReason = 'aborted';
      } else if (
        result.timedOut ||
        result.error ||
        result.exitCode !== 0 ||
        runtime.turnReason?.kind === 'error'
      ) {
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error = result.timedOut
          ? `DeepSeek Harness turn timed out after ${timeoutMs}ms.`
          : result.error?.message ||
            runtime.turnReason?.message ||
            result.stderr?.trim() ||
            `DeepSeek Harness (${result.commandLine}) exited with code ${result.exitCode}.`;
      } else {
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
    if (runtime.child) {
      if (action === 'interrupt') {
        await this.abort(taskId);
        return { handledLive: true };
      }
      if (action === 'reply') {
        throw new Error('An active DSH headless turn cannot accept a live reply.');
      }
      return { handledLive: false };
    }
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
    if (runtime.child) {
      await killProcessTree(runtime.child);
      return true;
    }
    if (runtime.snapshot.sessionId) {
      try {
        runtime.transport.notify('session/cancel', { sessionId: runtime.snapshot.sessionId });
        if (runtime.promptPromise) {
          let graceTimer;
          await Promise.race([
            runtime.promptPromise.catch(() => {}),
            new Promise((resolve) => {
              graceTimer = setTimeout(resolve, 250);
            }),
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
