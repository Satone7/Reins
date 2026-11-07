/**
 * Reins Southbound Driver — OpenAI Codex (`codex app-server --stdio`)
 *
 * Implements the full H2H Protocol v0.2 lifecycle over Codex's native JSON-RPC 2.0
 * `app-server` protocol, supporting:
 * - First-class persistent sessions (`ephemeral: false` -> saved in `~/.codex/sessions/`)
 * - Burn-after-reading ephemeral sessions (`ephemeral: true` -> in-memory / no session clutter)
 * - Session resumption via `thread/resume`
 * - Streaming item deltas, commentary, and final agent messages
 * - Interactive approval interception (`attention_required`) and live turn steering
 */

import { resolveExecutable } from '../transports/local.js';
import { createJsonRpcTransport } from '../transports/ssh.js';
import {
  applyPresetPrompt,
  buildResumeCommandHint,
  formatDiagnosticSummary,
  mapReinPolicyToCodex,
} from '../protocol/schema.js';

export class CodexAppServerDriver {
  /**
   * @param {object} [targetConfig={}]
   */
  constructor(targetConfig = {}) {
    this.targetConfig = targetConfig;
    /** @type {Map<string, object>} Active task runtime handles keyed by taskId */
    this.activeSessions = new Map();
  }

  /**
   * Executes or resumes a turn on a local or remote Codex `app-server` instance.
   *
   * @param {object} snapshot - Mutable H2HTaskSnapshot instance
   * @param {object} options
   * @param {string} options.prompt - Raw user/parent prompt
   * @param {Record<string, string>} [options.envVars={}] - Loop-guard and target environment variables
   * @param {number} [options.timeoutMs=600000] - Maximum turn duration in milliseconds
   * @param {(snapshot: object) => void} [onUpdate] - Callback invoked whenever snapshot state changes
   * @returns {Promise<object>} Finalized or attention-paused H2HTaskSnapshot
   */
  async runTurn(snapshot, { prompt, envVars = {}, timeoutMs = 600000 }, onUpdate = () => {}) {
    const transportConfig = this.targetConfig.transport;
    const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
    const command = isSsh
      ? (this.targetConfig.command && this.targetConfig.command !== 'auto' ? this.targetConfig.command : 'codex')
      : resolveExecutable(this.targetConfig.command || 'auto', 'codex');
    const args = Array.isArray(this.targetConfig.args) && this.targetConfig.args.length > 0
      ? this.targetConfig.args
      : ['app-server', '--stdio'];

    const transport = createJsonRpcTransport({
      transportConfig,
      command,
      args,
      cwd: snapshot.cwd || process.cwd(),
      env: {
        ...(this.targetConfig.env || {}),
        ...envVars,
      },
    });

    const startTimeMs = Date.now();
    const runtime = {
      taskId: snapshot.taskId,
      transport,
      snapshot,
      threadId: snapshot.sessionId || null,
      activeTurnId: null,
      pendingApproval: null,
      turnDoneResolve: null,
      turnDoneReject: null,
      abortedByCaller: false,
      onUpdate,
    };

    this.activeSessions.set(snapshot.taskId, runtime);

    const emitUpdate = () => {
      snapshot.metrics.updatedAt = new Date().toISOString();
      snapshot.metrics.durationMs = Math.max(0, Date.now() - startTimeMs);
      snapshot.diagnostic = formatDiagnosticSummary(snapshot);
      onUpdate(snapshot);
    };

    const appendEvent = (event) => {
      snapshot.transcript.totalEvents += 1;
      snapshot.transcript.lastSeq += 1;
      snapshot.transcript.messages.push({
        seq: snapshot.transcript.lastSeq,
        timestamp: new Date().toISOString(),
        ...event,
      });
    };

    const turnDonePromise = new Promise((resolve, reject) => {
      runtime.turnDoneResolve = resolve;
      runtime.turnDoneReject = reject;
    });

    transport.on('notification', (method, params) => {
      this._handleNotification(runtime, method, params, appendEvent, emitUpdate);
    });

    transport.on('request', (id, method, params) => {
      this._handleServerRequest(runtime, id, method, params, appendEvent, emitUpdate);
    });

    transport.on('error', (err) => {
      snapshot.status = 'failed';
      snapshot.stopReason = 'error';
      snapshot.error = err.message || String(err);
      emitUpdate();
      runtime.turnDoneResolve(snapshot);
    });

    transport.on('exit', (code, signal) => {
      if (snapshot.status === 'running' || snapshot.status === 'queued' || snapshot.status === 'attention_required') {
        if (runtime.abortedByCaller) {
          snapshot.status = 'aborted';
          snapshot.stopReason = 'aborted';
        } else {
          snapshot.status = 'failed';
          snapshot.stopReason = 'error';
          snapshot.error = snapshot.error || `Codex app-server exited unexpectedly (code=${code}, signal=${signal}).`;
        }
        emitUpdate();
        runtime.turnDoneResolve(snapshot);
      }
    });

    let timeoutTimer = null;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (snapshot.status === 'running' || snapshot.status === 'queued') {
          snapshot.status = 'failed';
          snapshot.stopReason = 'error';
          snapshot.error = `Task timed out after ${timeoutMs}ms.`;
          emitUpdate();
          transport.close().catch(() => {});
          runtime.turnDoneResolve(snapshot);
        }
      }, timeoutMs);
    }

    try {
      transport.start();
      snapshot.status = 'running';
      emitUpdate();

      // 1. Handshake
      await transport.request(
        'initialize',
        {
          clientInfo: {
            name: 'reins',
            title: 'Reins H2H Hub',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: false,
          },
        },
        20000,
      );
      transport.notify('initialized');

      // 2. Map ReinPolicy to Codex sandbox and approval parameters
      const { approvalPolicy, sandbox } = mapReinPolicyToCodex(snapshot.reinPolicy);
      const effectiveModel = snapshot.model || this.targetConfig.model || null;

      // 3. Start a new thread or resume an existing persistent session
      if (runtime.threadId) {
        const resumeRes = await transport.request(
          'thread/resume',
          {
            threadId: runtime.threadId,
            cwd: snapshot.cwd || process.cwd(),
            model: effectiveModel,
            approvalPolicy,
            sandbox,
            excludeTurns: true,
          },
          30000,
        );
        runtime.threadId = resumeRes?.thread?.id || runtime.threadId;
      } else {
        const startRes = await transport.request(
          'thread/start',
          {
            cwd: snapshot.cwd || process.cwd(),
            ephemeral: snapshot.sessionMode === 'ephemeral',
            model: effectiveModel,
            approvalPolicy,
            approvalsReviewer: 'user',
            sandbox,
          },
          30000,
        );
        runtime.threadId = startRes?.thread?.id;
        if (startRes?.model && !snapshot.model) {
          snapshot.model = startRes.model;
        }
      }

      if (!runtime.threadId) {
        throw new Error('Codex app-server did not return a valid thread.id.');
      }

      snapshot.sessionId = runtime.threadId;
      snapshot.resumeCommandHint = buildResumeCommandHint({
        kind: 'codex',
        sessionId: snapshot.sessionId,
        sessionMode: snapshot.sessionMode,
        transportType: this.targetConfig.transport?.type || this.targetConfig.transport?.kind || 'local',
        sshHost: this.targetConfig.transport?.host,
      });
      emitUpdate();

      // 4. Frame prompt according to preset and start turn
      const framedPrompt = applyPresetPrompt(prompt, snapshot.preset);
      appendEvent({
        role: 'user',
        phase: 'input',
        text: framedPrompt,
      });
      emitUpdate();

      const turnStartRes = await transport.request(
        'turn/start',
        {
          threadId: runtime.threadId,
          input: [
            {
              type: 'text',
              text: framedPrompt,
              text_elements: [],
            },
          ],
        },
        30000,
      );

      if (turnStartRes?.turn?.id) {
        runtime.activeTurnId = turnStartRes.turn.id;
      }

      // 5. Wait for turn/completed notification
      await turnDonePromise;
      return snapshot;
    } catch (err) {
      if (runtime.abortedByCaller) {
        snapshot.status = 'aborted';
        snapshot.stopReason = 'aborted';
      } else {
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error = err.message || String(err);
      }
      emitUpdate();
      return snapshot;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.activeSessions.delete(snapshot.taskId);
      await transport.close().catch(() => {});
    }
  }

  /**
   * Handles streaming notifications from `codex app-server`.
   */
  _handleNotification(runtime, method, params, appendEvent, emitUpdate) {
    const { snapshot } = runtime;

    if (method === 'turn/started') {
      runtime.activeTurnId = params?.turn?.id || runtime.activeTurnId;
      snapshot.metrics.turnCount = (snapshot.metrics.turnCount || 0) + 1;
      snapshot.status = 'running';
      emitUpdate();
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const delta = params?.delta || '';
      if (delta) {
        // Keep live output responsive during long generations before item/completed arrives
        snapshot.output = `${snapshot.output || ''}${delta}`;
        emitUpdate();
      }
      return;
    }

    if (method === 'item/completed') {
      const item = params?.item;
      if (!item) return;

      if (item.type === 'agentMessage') {
        const text = item.text || '';
        const phase = item.phase || 'final_answer';
        if (phase === 'commentary') {
          snapshot.commentary = snapshot.commentary
            ? `${snapshot.commentary}\n${text}`
            : text;
        } else {
          // Authoritative final text for the completed agentMessage item
          snapshot.output = text;
        }
        appendEvent({
          role: 'assistant',
          phase,
          text,
        });
        emitUpdate();
        return;
      }

      if (item.type === 'commandExecution') {
        appendEvent({
          role: 'tool',
          phase: 'commandExecution',
          command: item.command,
          exitCode: item.exitCode,
          status: item.status,
        });
        emitUpdate();
        return;
      }

      if (item.type === 'fileChange') {
        appendEvent({
          role: 'tool',
          phase: 'fileChange',
          status: item.status,
          changesCount: Array.isArray(item.changes) ? item.changes.length : 0,
        });
        emitUpdate();
        return;
      }
    }

    if (method === 'turn/completed') {
      runtime.activeTurnId = null;
      const turn = params?.turn || {};
      if (turn.status === 'completed') {
        snapshot.status = 'completed';
        snapshot.stopReason = 'end_turn';
      } else if (turn.status === 'interrupted' || runtime.abortedByCaller) {
        snapshot.status = 'aborted';
        snapshot.stopReason = 'aborted';
      } else {
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error =
          turn.error?.message ||
          (typeof turn.error === 'string' ? turn.error : JSON.stringify(turn.error || 'Codex turn failed'));
      }
      emitUpdate();
      runtime.turnDoneResolve(snapshot);
    }
  }

  /**
   * Handles server-initiated approval and user-input requests from `codex app-server`.
   */
  _handleServerRequest(runtime, id, method, params, appendEvent, emitUpdate) {
    const { snapshot, transport } = runtime;
    const policy = snapshot.reinPolicy;

    const autoAccept = policy === 'free-rein' || policy === 'auto-edit';
    const autoDecline = policy === 'plan-only';

    const sendDecision = (approved) => {
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        transport.respond(id, { decision: approved ? 'accept' : 'decline' });
      } else if (method === 'item/permissions/requestApproval') {
        transport.respond(id, {
          permissions: approved ? params?.permissions || {} : {},
          scope: 'turn',
        });
      } else if (method === 'item/tool/requestUserInput') {
        transport.respond(id, { answers: {} });
      } else if (method === 'mcpServer/elicitation/request') {
        transport.respond(id, {
          action: approved ? 'accept' : 'decline',
          content: null,
          _meta: null,
        });
      } else {
        transport.respondError(id, -32601, `Unhandled server request: ${method}`);
      }
    };

    if (autoAccept) {
      sendDecision(true);
      return;
    }
    if (autoDecline) {
      sendDecision(false);
      return;
    }

    // Under `parent-rein` or `tight-rein`, pause task in `attention_required` state
    // so the parent agent or human operator can approve/reject via `reins steer`.
    snapshot.status = 'attention_required';
    snapshot.attention = {
      requestId: String(id),
      method,
      summary:
        params?.command
          ? `Approval requested for command: ${params.command}`
          : params?.reason || `Codex requested approval (${method})`,
      params,
      createdAt: new Date().toISOString(),
    };
    appendEvent({
      role: 'system',
      phase: 'attention_required',
      text: snapshot.attention.summary,
    });
    emitUpdate();

    runtime.pendingApproval = {
      id,
      method,
      params,
      resolve: (approved) => {
        runtime.pendingApproval = null;
        snapshot.attention = undefined;
        snapshot.status = 'running';
        emitUpdate();
        sendDecision(approved);
      },
    };
  }

  /**
   * Steers an active in-flight turn (approving/rejecting a pending tool call, injecting
   * mid-turn guidance via `turn/steer`, or interrupting the active turn).
   *
   * @param {string} taskId
   * @param {object} steerParams
   * @param {'reply' | 'approve' | 'reject' | 'interrupt'} steerParams.action
   * @param {string} [steerParams.message]
   * @returns {Promise<{ handledLive: boolean }>}
   */
  async steerLive(taskId, { action, message }) {
    const runtime = this.activeSessions.get(taskId);
    if (!runtime) {
      return { handledLive: false };
    }

    if (action === 'approve' || action === 'reject') {
      if (!runtime.pendingApproval) {
        throw new Error(`Task "${taskId}" has no pending approval request to ${action}.`);
      }
      runtime.pendingApproval.resolve(action === 'approve');
      return { handledLive: true };
    }

    if (action === 'interrupt') {
      if (runtime.threadId && runtime.activeTurnId) {
        await runtime.transport.request(
          'turn/interrupt',
          {
            threadId: runtime.threadId,
            turnId: runtime.activeTurnId,
          },
          10000,
        );
        return { handledLive: true };
      }
      await this.abort(taskId);
      return { handledLive: true };
    }

    if (action === 'reply') {
      if (!message || !String(message).trim()) {
        throw new Error('Steer action "reply" requires a non-empty message.');
      }
      if (runtime.threadId && runtime.activeTurnId) {
        await runtime.transport.request(
          'turn/steer',
          {
            threadId: runtime.threadId,
            expectedTurnId: runtime.activeTurnId,
            input: [
              {
                type: 'text',
                text: String(message).trim(),
                text_elements: [],
              },
            ],
          },
          15000,
        );
        return { handledLive: true };
      }
      return { handledLive: false };
    }

    throw new Error(`Unsupported steer action: ${action}`);
  }

  /**
   * Aborts an active task and terminates its `codex app-server` subprocess tree.
   *
   * @param {string} taskId
   * @returns {Promise<boolean>}
   */
  async abort(taskId) {
    const runtime = this.activeSessions.get(taskId);
    if (!runtime) {
      return false;
    }
    runtime.abortedByCaller = true;
    if (runtime.threadId && runtime.activeTurnId) {
      try {
        await runtime.transport.request(
          'turn/interrupt',
          {
            threadId: runtime.threadId,
            turnId: runtime.activeTurnId,
          },
          3000,
        );
      } catch {
        // Proceed to hard process tree termination.
      }
    }
    await runtime.transport.close();
    return true;
  }
}
