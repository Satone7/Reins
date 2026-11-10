/**
 * Reins Southbound Driver — OpenAI Codex (`codex app-server --stdio`)
 *
 * Thin, version-agnostic JSON-RPC 2.0 driver over Codex's standard `app-server --stdio`
 * protocol. Avoids mutating private SQLite databases (`state_5.sqlite`, `codex.db`),
 * internal rollout files, or undocumented Electron IPC sockets so it remains compatible
 * across different Codex CLI versions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveExecutable } from '../transports/local.js';
import { createJsonRpcTransport } from '../transports/ssh.js';
import {
  applyPresetPrompt,
  buildResumeCommandHint,
  formatDiagnosticSummary,
  mapReinPolicyToCodex,
} from '../protocol/schema.js';

/**
 * Derives a concise, human-readable thread title from a prompt.
 *
 * @param {string} prompt
 * @param {object} [snapshot={}]
 * @returns {string}
 */
export function deriveCodexThreadTitle(prompt, snapshot = {}) {
  if (snapshot?.title && String(snapshot.title).trim()) {
    return String(snapshot.title).trim().slice(0, 80);
  }
  const raw = String(prompt || '')
    .replace(/^\[Reins H2H Preset:[^\]]*\]\s*/i, '')
    .trim();
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line.length > 0) || 'Reins H2H Session';
  const truncated = firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
  return truncated.startsWith('[Reins]') ? truncated : `[Reins] ${truncated}`;
}

/**
 * Strips the Windows extended-length path prefix (`\\?\` and `\\?\UNC\`) produced by
 * Rust `std::fs::canonicalize`.
 *
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizeCodexPath(rawPath) {
  return String(rawPath || '')
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/, '');
}

/**
 * Resolves the containing Git worktree root for a local path by walking up parent
 * directories looking for a `.git` directory or linked-worktree `.git` file.
 * Falls back to the normalized `targetCwd` when not inside a Git checkout.
 *
 * @param {string} targetCwd
 * @returns {string}
 */
export function resolveGitWorktreeRoot(targetCwd) {
  const resolved = normalizeCodexPath(path.resolve(normalizeCodexPath(targetCwd || process.cwd())));
  let current = resolved;
  while (true) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) {
        return current;
      }
    } catch {
      // Ignore permission errors while walking up.
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) {
      return resolved;
    }
    current = parent;
  }
}

function isMethodNotFound(err) {
  return (
    err?.code === -32601 ||
    /method not found|unknown variant|unsupported/i.test(String(err?.message || ''))
  );
}

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
   * Queries `codex app-server --stdio` for selectable models, supported reasoning
   * efforts, and current defaults.
   *
   * @param {object} [options]
   * @param {string} [options.cwd]
   * @param {Record<string, string>} [options.envVars={}]
   * @param {number} [options.timeoutMs=15000]
   * @returns {Promise<object>}
   */
  async listModels({ cwd, envVars = {}, timeoutMs = 15000 } = {}) {
    const transportConfig = this.targetConfig.transport;
    const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
    const command = isSsh
      ? this.targetConfig.command && this.targetConfig.command !== 'auto'
        ? this.targetConfig.command
        : 'codex'
      : resolveExecutable(this.targetConfig.command || 'auto', 'codex');
    const args =
      Array.isArray(this.targetConfig.args) && this.targetConfig.args.length > 0
        ? this.targetConfig.args
        : ['app-server', '--stdio'];

    const transport = createJsonRpcTransport({
      transportConfig,
      command,
      args,
      cwd: cwd || this.targetConfig.defaultCwd || process.cwd(),
      env: {
        ...(this.targetConfig.env || {}),
        ...envVars,
      },
    });

    try {
      transport.start();
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
        timeoutMs,
      );
      transport.notify('initialized');

      const [modelsRes, configRes] = await Promise.all([
        transport.request('model/list', {}, timeoutMs),
        transport.request('config/read', { includeLayers: false }, timeoutMs).catch(() => null),
      ]);

      const rawModels = Array.isArray(modelsRes?.data) ? modelsRes.data : [];
      const userConfig = configRes?.config || {};

      const models = rawModels.map((entry) => {
        const efforts = Array.isArray(entry.supportedReasoningEfforts)
          ? entry.supportedReasoningEfforts.map((r) => ({
              effort: r.reasoningEffort || r.effort,
              description: r.description || '',
            }))
          : [];
        return {
          id: entry.id || entry.model,
          model: entry.model || entry.id,
          displayName: entry.displayName || entry.model || entry.id,
          description: entry.description || '',
          isDefault: Boolean(entry.isDefault),
          defaultEffort: entry.defaultReasoningEffort || null,
          supportedEfforts: efforts.map((e) => e.effort).filter(Boolean),
          effortDetails: efforts,
          inputModalities: Array.isArray(entry.inputModalities) ? entry.inputModalities : ['text'],
        };
      });

      return {
        targetId: this.targetConfig.id || 'local-codex',
        kind: 'codex',
        currentConfig: {
          model: this.targetConfig.model || userConfig.model || null,
          effort: this.targetConfig.effort || userConfig.model_reasoning_effort || null,
          provider: userConfig.model_provider || null,
        },
        models,
      };
    } finally {
      await transport.close().catch(() => {});
    }
  }

  /**
   * Registers `effectiveProjectRoot` via standard `project/list` and `project/create` RPCs
   * when supported by the target `codex app-server` version.
   *
   * @param {object} transport
   * @param {string} effectiveProjectRoot
   * @param {boolean} [isSsh=false]
   * @returns {Promise<{ projectId: string | null, rpcSupported: boolean }>}
   */
  async _ensureCodexProject(transport, effectiveProjectRoot, isSsh = false) {
    if (!effectiveProjectRoot) return { projectId: null, rpcSupported: false };
    const normPath = (p) =>
      isSsh
        ? String(p || '').replace(/\/+$/, '')
        : path.resolve(normalizeCodexPath(p)).replace(/[\\/]+$/, '').toLowerCase();

    const targetNorm = normPath(effectiveProjectRoot);
    let listRes;
    try {
      listRes = await transport.request('project/list', {}, 10000);
    } catch (err) {
      if (isMethodNotFound(err)) {
        return { projectId: null, rpcSupported: false };
      }
      throw err;
    }

    const projects = Array.isArray(listRes?.data) ? listRes.data : [];
    let bestId = null;
    let bestLen = -1;
    const sep = isSsh ? '/' : path.sep;
    for (const proj of projects) {
      const roots = Array.isArray(proj?.roots) ? proj.roots : [];
      for (const r of roots) {
        const rootPath = typeof r === 'string' ? r : r?.path;
        if (!rootPath) continue;
        const rootNorm = normPath(rootPath);
        if (targetNorm === rootNorm || targetNorm.startsWith(`${rootNorm}${sep}`)) {
          if (rootNorm.length > bestLen) {
            bestLen = rootNorm.length;
            bestId = proj.id || null;
          }
        }
      }
    }
    if (bestId && bestLen === targetNorm.length) {
      return { projectId: bestId, rpcSupported: true };
    }

    const projName =
      (isSsh ? path.posix.basename(effectiveProjectRoot) : path.basename(effectiveProjectRoot)) ||
      'Workspace';
    try {
      const createdRes = await transport.request(
        'project/create',
        {
          idempotencyKey: randomUUID(),
          name: projName,
          roots: [{ path: effectiveProjectRoot }],
        },
        10000,
      );
      return { projectId: createdRes?.project?.id || bestId || null, rpcSupported: true };
    } catch (err) {
      if (isMethodNotFound(err)) {
        return { projectId: bestId, rpcSupported: false };
      }
      return { projectId: bestId, rpcSupported: true };
    }
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
      ? this.targetConfig.command && this.targetConfig.command !== 'auto'
        ? this.targetConfig.command
        : 'codex'
      : resolveExecutable(this.targetConfig.command || 'auto', 'codex');
    const args =
      Array.isArray(this.targetConfig.args) && this.targetConfig.args.length > 0
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
    runtime.turnDonePromise = turnDonePromise;
    runtime.attentionListeners = new Set();

    transport.on('notification', (method, params) => {
      this._handleNotification(runtime, method, params, appendEvent, emitUpdate);
    });

    transport.on('request', (id, method, params) => {
      this._handleServerRequest(runtime, id, method, params, appendEvent, emitUpdate);
    });

    transport.on('error', (err) => {
      if (runtime.committedOutput !== undefined) {
        snapshot.output = runtime.committedOutput;
      }
      snapshot.status = 'failed';
      snapshot.stopReason = 'error';
      snapshot.error = err.message || String(err);
      emitUpdate();
      runtime.turnDoneResolve(snapshot);
    });

    transport.on('exit', (code, signal) => {
      if (
        snapshot.status === 'running' ||
        snapshot.status === 'queued' ||
        snapshot.status === 'attention_required'
      ) {
        if (runtime.committedOutput !== undefined) {
          snapshot.output = runtime.committedOutput;
        }
        if (runtime.abortedByCaller) {
          snapshot.status = 'aborted';
          snapshot.stopReason = 'aborted';
        } else {
          snapshot.status = 'failed';
          snapshot.stopReason = 'error';
          snapshot.error =
            snapshot.error ||
            `Codex app-server (${command} ${args.join(' ')}) exited unexpectedly (code=${code}, signal=${signal}).`;
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

      const isPersistent = snapshot.sessionMode === 'persistent';
      const threadTitle = deriveCodexThreadTitle(prompt, snapshot);
      const rawTargetCwd = snapshot.cwd || process.cwd();
      const effectiveCwd = isSsh ? rawTargetCwd : normalizeCodexPath(path.resolve(rawTargetCwd));
      const explicitProjectRoot = snapshot.projectSelector?.root || null;
      const effectiveProjectRoot = isSsh
        ? explicitProjectRoot || effectiveCwd
        : explicitProjectRoot
          ? normalizeCodexPath(path.resolve(normalizeCodexPath(explicitProjectRoot)))
          : resolveGitWorktreeRoot(effectiveCwd);
      runtime.effectiveProjectRoot = effectiveProjectRoot;

      // 1. Standard JSON-RPC Handshake
      await transport.request(
        'initialize',
        {
          clientInfo: {
            name: 'reins',
            title: 'Reins H2H Hub',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
          },
        },
        20000,
      );
      transport.notify('initialized');

      // 1b. Project Onboarding over standard RPC (falls back to cwd binding if RPC is unsupported)
      let projectId = snapshot.project?.id || null;
      let projectRpcSupported = true;
      if (isPersistent) {
        if (!projectId) {
          const ensured = await this._ensureCodexProject(
            transport,
            effectiveProjectRoot,
            isSsh,
          ).catch(() => ({ projectId: null, rpcSupported: false }));
          projectId = ensured.projectId;
          projectRpcSupported = ensured.rpcSupported;
        }
      } else {
        snapshot.project = {
          id: null,
          root: effectiveProjectRoot,
          binding: 'not-required',
          mechanism: null,
        };
      }

      // 2. Map ReinPolicy to Codex sandbox and approval parameters
      const { approvalPolicy, sandbox } = mapReinPolicyToCodex(snapshot.reinPolicy);
      const effectiveModel = snapshot.model || this.targetConfig.model || null;
      const effectiveEffort = snapshot.effort || this.targetConfig.effort || null;
      const threadConfigOverrides = effectiveEffort
        ? { model_reasoning_effort: effectiveEffort }
        : undefined;

      // 3. Start a new thread or resume an existing persistent session
      const isNewThread = !runtime.threadId;
      let existingThreadProjectId = null;
      let existingThreadRoots = [];

      if (runtime.threadId) {
        let resumeRes;
        try {
          resumeRes = await transport.request(
            'thread/resume',
            {
              threadId: runtime.threadId,
              cwd: effectiveCwd,
              ...(effectiveModel ? { model: effectiveModel } : {}),
              ...(threadConfigOverrides ? { config: threadConfigOverrides } : {}),
              approvalPolicy,
              sandbox,
              excludeTurns: true,
            },
            30000,
          );
        } catch (resumeErr) {
          if (/already has an active writer/i.test(String(resumeErr?.message || ''))) {
            resumeRes = await transport.request(
              'thread/fork',
              {
                threadId: runtime.threadId,
                cwd: effectiveCwd,
                ...(effectiveModel ? { model: effectiveModel } : {}),
                ...(threadConfigOverrides ? { config: threadConfigOverrides } : {}),
                approvalPolicy,
                sandbox,
              },
              30000,
            );
          } else {
            throw resumeErr;
          }
        }
        runtime.threadId = resumeRes?.thread?.id || runtime.threadId;
        if (resumeRes?.thread?.projectId) {
          existingThreadProjectId = resumeRes.thread.projectId;
        }
        if (resumeRes?.thread?.cwd) {
          existingThreadRoots = [resumeRes.thread.cwd];
        }
        if (
          existingThreadProjectId &&
          snapshot.projectSelector?.id &&
          snapshot.projectSelector.id !== existingThreadProjectId
        ) {
          throw new Error(
            `[H2H-PROJ-05] Project binding mismatch: native session "${runtime.threadId}" is bound to project "${existingThreadProjectId}", cannot rebind to "${snapshot.projectSelector.id}".`,
          );
        }
        if (snapshot.projectSelector?.root && existingThreadRoots.length > 0) {
          const normComparePath = (p) =>
            isSsh
              ? path.posix.resolve('/', String(p || '')).replace(/\/+$/, '')
              : path.resolve(normalizeCodexPath(p)).replace(/[\\/]+$/, '').toLowerCase();
          const reqNorm = normComparePath(snapshot.projectSelector.root);
          const matchesRoot = existingThreadRoots.some((r) => normComparePath(r) === reqNorm);
          if (!matchesRoot) {
            throw new Error(
              `[H2H-PROJ-05] Project binding mismatch: native session "${runtime.threadId}" is bound to project root "${existingThreadRoots[0]}", cannot rebind to "${snapshot.projectSelector.root}".`,
            );
          }
        }
        if (existingThreadProjectId) {
          projectId = existingThreadProjectId;
        }
        if (resumeRes?.model && !snapshot.model) {
          snapshot.model = resumeRes.model;
        }
        if ((resumeRes?.reasoningEffort || effectiveEffort) && !snapshot.effort) {
          snapshot.effort = resumeRes?.reasoningEffort || effectiveEffort;
        }
      } else {
        const startRes = await transport.request(
          'thread/start',
          {
            cwd: effectiveCwd,
            ephemeral: snapshot.sessionMode === 'ephemeral',
            ...(effectiveModel ? { model: effectiveModel } : {}),
            ...(threadConfigOverrides ? { config: threadConfigOverrides } : {}),
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
        if ((startRes?.reasoningEffort || effectiveEffort) && !snapshot.effort) {
          snapshot.effort = startRes?.reasoningEffort || effectiveEffort;
        }
      }

      if (!runtime.threadId) {
        throw new Error('Codex app-server did not return a valid thread.id.');
      }

      if (isPersistent && projectId) {
        await transport
          .request(
            'thread/metadata/update',
            {
              threadId: runtime.threadId,
              projectId,
            },
            5000,
          )
          .catch(() => {});
      }

      if (isPersistent && isNewThread) {
        await transport
          .request(
            'thread/name/set',
            {
              threadId: runtime.threadId,
              name: threadTitle,
            },
            5000,
          )
          .catch(() => {});
      }

      snapshot.sessionId = runtime.threadId;
      snapshot.resumeCommandHint =
        buildResumeCommandHint({
          kind: 'codex',
          sessionId: snapshot.sessionId,
          sessionMode: snapshot.sessionMode,
          transportType:
            this.targetConfig.transport?.type || this.targetConfig.transport?.kind || 'local',
          sshHost: this.targetConfig.transport?.host,
        }) || null;

      if (isPersistent) {
        snapshot.project = {
          id: projectId || effectiveProjectRoot,
          root: effectiveProjectRoot,
          binding: 'bound',
          mechanism: projectId && projectRpcSupported ? 'native-id' : 'cwd',
        };
      }
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
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(effectiveEffort ? { effort: effectiveEffort } : {}),
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
      runtime.committedOutput = '';
      runtime.itemPhases = new Map();
      runtime.pendingItemDeltas = new Map();
      snapshot.output = '';
      snapshot.error = null;
      snapshot.metrics.turnCount = (snapshot.metrics.turnCount || 0) + 1;
      snapshot.status = 'running';
      emitUpdate();
      return;
    }

    if (method === 'item/started') {
      const item = params?.item;
      if (item?.id && item?.type === 'agentMessage') {
        runtime.itemPhases = runtime.itemPhases || new Map();
        const phase = item.phase || null;
        runtime.itemPhases.set(item.id, phase);
        if (phase === 'final_answer' && runtime.pendingItemDeltas?.has(item.id)) {
          const buffered = runtime.pendingItemDeltas.get(item.id) || '';
          runtime.pendingItemDeltas.delete(item.id);
          if (buffered) {
            snapshot.output = `${snapshot.output || ''}${buffered}`;
            emitUpdate();
          }
        }
      }
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const delta = params?.delta || '';
      const itemId = params?.itemId;
      const knownPhase = itemId && runtime.itemPhases ? runtime.itemPhases.get(itemId) : null;
      if (!delta) return;
      if (knownPhase === 'final_answer') {
        snapshot.output = `${snapshot.output || ''}${delta}`;
        emitUpdate();
      } else if (knownPhase === null && itemId) {
        runtime.pendingItemDeltas = runtime.pendingItemDeltas || new Map();
        runtime.pendingItemDeltas.set(
          itemId,
          `${runtime.pendingItemDeltas.get(itemId) || ''}${delta}`,
        );
      }
      return;
    }

    if (method === 'item/completed') {
      const item = params?.item;
      if (!item) return;

      if (item.type === 'agentMessage') {
        if (item.id && runtime.pendingItemDeltas) {
          runtime.pendingItemDeltas.delete(item.id);
        }
        const text = item.text || '';
        const phase = item.phase || 'final_answer';
        if (phase === 'commentary') {
          snapshot.commentary = snapshot.commentary ? `${snapshot.commentary}\n${text}` : text;
          snapshot.output = runtime.committedOutput ?? '';
        } else {
          runtime.committedOutput = text;
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
        snapshot.error = null;
      } else if (turn.status === 'interrupted' || runtime.abortedByCaller) {
        if (runtime.committedOutput !== undefined) {
          snapshot.output = runtime.committedOutput;
        }
        snapshot.status = 'aborted';
        snapshot.stopReason = 'aborted';
      } else {
        if (runtime.committedOutput !== undefined) {
          snapshot.output = runtime.committedOutput;
        }
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error =
          turn.error?.message ||
          (typeof turn.error === 'string'
            ? turn.error
            : JSON.stringify(turn.error || 'Codex turn failed'));
      }
      emitUpdate();
      runtime.turnDoneResolve(snapshot);
    }
  }

  /**
   * Checks whether an approval request under `auto-edit` is strictly confined to the
   * bound workspace root (`effectiveProjectRoot`).
   */
  _isWithinWorkspaceForAutoEdit(runtime, method, params) {
    const workspaceRoot =
      runtime.effectiveProjectRoot ||
      runtime.snapshot?.project?.root ||
      runtime.snapshot?.cwd;
    if (!workspaceRoot || !params || typeof params !== 'object') {
      return false;
    }
    const normRoot = path
      .resolve(normalizeCodexPath(workspaceRoot))
      .replace(/[\\/]+$/, '')
      .toLowerCase();
    const isInside = (candidate) => {
      if (!candidate || typeof candidate !== 'string') return false;
      const resolved = path
        .resolve(normalizeCodexPath(workspaceRoot), normalizeCodexPath(candidate))
        .replace(/[\\/]+$/, '')
        .toLowerCase();
      return resolved === normRoot || resolved.startsWith(`${normRoot}${path.sep}`);
    };

    if (method === 'item/fileChange/requestApproval') {
      if (params.grantRoot && !isInside(params.grantRoot)) {
        return false;
      }
      if (params.cwd && !isInside(params.cwd)) {
        return false;
      }
      const rawPaths =
        Array.isArray(params.changes) && params.changes.length > 0
          ? params.changes.map((c) => c?.path || c?.filePath)
          : Array.isArray(params.paths) && params.paths.length > 0
            ? params.paths
            : null;
      if (!rawPaths || rawPaths.length === 0) {
        return false;
      }
      return rawPaths.every((p) => isInside(p));
    }

    if (method === 'item/commandExecution/requestApproval') {
      if (params.sandboxed !== true || params.requiresEscalation === true) {
        return false;
      }
      if (params.grantRoot && !isInside(params.grantRoot)) {
        return false;
      }
      if (params.cwd && !isInside(params.cwd)) {
        return false;
      }
      if (!Array.isArray(params.writableRoots) || params.writableRoots.length === 0) {
        return false;
      }
      return params.writableRoots.every((r) => isInside(r));
    }

    return false;
  }

  /**
   * Handles server-initiated approval and user-input requests from `codex app-server`.
   */
  _handleServerRequest(runtime, id, method, params, appendEvent, emitUpdate) {
    const { snapshot, transport } = runtime;
    const policy = snapshot.reinPolicy;

    const autoAccept =
      policy === 'free-rein' ||
      (policy === 'auto-edit' && this._isWithinWorkspaceForAutoEdit(runtime, method, params));
    const autoDecline = policy === 'plan-only';

    const sendDecision = (approved) => {
      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval'
      ) {
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

    snapshot.status = 'attention_required';
    snapshot.stopReason = 'attention-required';
    snapshot.attention = {
      requestId: String(id),
      method,
      summary: params?.command
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
    if (runtime.attentionListeners) {
      for (const notifyAttention of runtime.attentionListeners) {
        notifyAttention(snapshot);
      }
      runtime.attentionListeners.clear();
    }

    runtime.pendingApproval = {
      id,
      method,
      params,
      resolve: (approved) => {
        runtime.pendingApproval = null;
        snapshot.attention = undefined;
        snapshot.status = 'running';
        snapshot.stopReason = 'running';
        emitUpdate();
        sendDecision(approved);
      },
    };
  }

  _waitForTurnOrAttention(runtime) {
    if (!runtime || !runtime.turnDonePromise) {
      return Promise.resolve(runtime?.snapshot);
    }
    if (
      runtime.snapshot?.status === 'completed' ||
      runtime.snapshot?.status === 'failed' ||
      runtime.snapshot?.status === 'aborted'
    ) {
      return Promise.resolve(runtime.snapshot);
    }
    return new Promise((resolve) => {
      const onAttention = (snap) => {
        resolve(snap);
      };
      runtime.attentionListeners = runtime.attentionListeners || new Set();
      runtime.attentionListeners.add(onAttention);
      runtime.turnDonePromise.then(
        (snap) => {
          runtime.attentionListeners?.delete(onAttention);
          resolve(snap);
        },
        () => {
          runtime.attentionListeners?.delete(onAttention);
          resolve(runtime.snapshot);
        },
      );
    });
  }

  /**
   * Steers an active in-flight turn.
   */
  async steerLive(taskId, { action, message, wait = false }) {
    const runtime = this.activeSessions.get(taskId);
    if (!runtime) {
      return { handledLive: false };
    }

    if (action === 'approve' || action === 'reject') {
      if (!runtime.pendingApproval) {
        throw new Error(`Task "${taskId}" has no pending approval request to ${action}.`);
      }
      runtime.pendingApproval.resolve(action === 'approve');
      if (wait) {
        const updated = await this._waitForTurnOrAttention(runtime);
        return { handledLive: true, snapshot: updated };
      }
      return { handledLive: true, snapshot: runtime.snapshot };
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
        if (wait) {
          const updated = await this._waitForTurnOrAttention(runtime);
          return { handledLive: true, snapshot: updated };
        }
        return { handledLive: true, snapshot: runtime.snapshot };
      }
      await this.abort(taskId, runtime.snapshot);
      return { handledLive: true, snapshot: runtime.snapshot };
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
        if (wait) {
          const updated = await this._waitForTurnOrAttention(runtime);
          return { handledLive: true, snapshot: updated };
        }
        return { handledLive: true, snapshot: runtime.snapshot };
      }
      return { handledLive: false };
    }

    throw new Error(`Unsupported steer action: ${action}`);
  }

  /**
   * Archives a persistent Codex session over a short-lived `codex app-server` transport
   * when no in-memory runtime is currently open for the task.
   */
  async _archiveSessionViaNewTransport(threadId, cwd) {
    const transportConfig = this.targetConfig.transport;
    const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
    const command = isSsh
      ? this.targetConfig.command && this.targetConfig.command !== 'auto'
        ? this.targetConfig.command
        : 'codex'
      : resolveExecutable(this.targetConfig.command || 'auto', 'codex');
    const args =
      Array.isArray(this.targetConfig.args) && this.targetConfig.args.length > 0
        ? this.targetConfig.args
        : ['app-server', '--stdio'];
    const transport = createJsonRpcTransport({
      transportConfig,
      command,
      args,
      cwd: cwd || this.targetConfig.defaultCwd || process.cwd(),
      env: { ...(this.targetConfig.env || {}) },
    });
    try {
      transport.start();
      await transport.request(
        'initialize',
        {
          clientInfo: { name: 'reins', title: 'Reins H2H Hub', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        },
        10000,
      );
      transport.notify('initialized');
      await transport.request('thread/archive', { threadId }, 5000);
    } finally {
      await transport.close().catch(() => {});
    }
  }

  /**
   * Aborts an active task and terminates its `codex app-server` subprocess tree.
   */
  async abort(taskId, snapshot = null, { terminateSession = false, hasRemoteOwner = false } = {}) {
    const runtime = this.activeSessions.get(taskId);
    if (!runtime) {
      if (hasRemoteOwner) {
        return false;
      }
      if (terminateSession && snapshot?.sessionId) {
        await this._archiveSessionViaNewTransport(snapshot.sessionId, snapshot.cwd);
        snapshot.resumeCommandHint = null;
        snapshot.sessionTerminated = true;
        return true;
      }
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
    let archiveError = null;
    if (terminateSession && runtime.threadId) {
      try {
        await runtime.transport.request(
          'thread/archive',
          {
            threadId: runtime.threadId,
          },
          5000,
        );
        if (snapshot) {
          snapshot.resumeCommandHint = null;
          snapshot.sessionTerminated = true;
        }
        if (runtime.snapshot) {
          runtime.snapshot.resumeCommandHint = null;
          runtime.snapshot.sessionTerminated = true;
        }
      } catch (err) {
        archiveError = err;
      }
    }
    await runtime.transport.close();
    if (archiveError) {
      throw new Error(
        `Failed to terminate Codex session "${runtime.threadId}" via thread/archive: ${archiveError.message || archiveError}`,
      );
    }
    return true;
  }
}
