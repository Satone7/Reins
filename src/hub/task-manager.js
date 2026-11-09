/**
 * Reins H2H Task Manager & Session Coordinator
 *
 * Orchestrates the lifecycle of H2H delegated tasks across Southbound drivers,
 * persists task snapshots to `~/.reins/tasks/`, enforces Loop Guard policies,
 * and supports both synchronous (`wait: true`) and asynchronous (`wait: false`)
 * execution across CLI and MCP surfaces.
 */

import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInitialTaskSnapshot,
  formatDiagnosticSummary,
  normalizeSnapshotEnvelope,
  resolveReinPolicy,
  resolveSessionMode,
} from '../protocol/schema.js';
import { advanceTraceOrThrow } from './loop-guard.js';
import { expandHome, TargetRegistry } from './registry.js';
import { CodexAppServerDriver } from '../drivers/codex-app-server.js';
import { AntigravityDriver } from '../drivers/antigravity-driver.js';
import { DshDriver } from '../drivers/dsh-driver.js';
import { ClaudeCodeDriver } from '../drivers/claude-code-driver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_ENTRY_PATH = path.resolve(__dirname, '..', 'index.js');

export class TaskManager {
  /**
   * @param {object} [options]
   * @param {TargetRegistry} [options.registry]
   * @param {string} [options.stateDir]
   * @param {Record<string, any>} [options.driverOverrides]
   */
  constructor({ registry, stateDir, driverOverrides = {} } = {}) {
    this.registry = registry || new TargetRegistry();
    const configuredStateDir =
      stateDir ||
      process.env.REINS_STATE_DIR ||
      this.registry.config?.hub?.stateDir ||
      '~/.reins';
    this.stateDir = expandHome(configuredStateDir);
    this.tasksDir = path.join(this.stateDir, 'tasks');
    this.driverOverrides = driverOverrides;
    this.drivers = new Map();
    this.memoryTasks = new Map();
    this.activeExecutions = new Map();

    fs.mkdirSync(this.tasksDir, { recursive: true });
  }

  /**
   * Resolves or instantiates the Southbound driver for a target.
   *
   * @param {object} target
   * @returns {any}
   */
  getDriver(target) {
    if (this.driverOverrides[target.id]) {
      return this.driverOverrides[target.id];
    }
    if (this.driverOverrides[target.driver]) {
      return this.driverOverrides[target.driver];
    }
    if (this.drivers.has(target.id)) {
      return this.drivers.get(target.id);
    }

    let driver;
    switch (target.driver) {
      case 'codex-app-server':
        driver = new CodexAppServerDriver(target);
        break;
      case 'agy-cli':
      case 'antigravity-cli':
      case 'antigravity-sdk':
      case 'agentapi':
        driver = new AntigravityDriver(target);
        break;
      case 'acp':
      case 'acp-stdio':
      case 'dsh-sdk':
      case 'dsh-headless':
        driver = new DshDriver(target);
        break;
      case 'claude-tmux':
      case 'claude-print':
      case 'claude-cli':
        driver = new ClaudeCodeDriver(target);
        break;
      default:
        if (target.kind === 'antigravity') {
          driver = new AntigravityDriver(target);
        } else if (target.kind === 'dsh') {
          driver = new DshDriver(target);
        } else if (target.kind === 'claude-code') {
          driver = new ClaudeCodeDriver(target);
        } else {
          throw new Error(
            `Southbound driver "${target.driver}" for target "${target.id}" (${target.kind}) is not yet registered.`,
          );
        }
    }

    this.drivers.set(target.id, driver);
    return driver;
  }

  /**
   * Returns the file path for a persisted task snapshot.
   *
   * @param {string} taskId
   * @returns {string}
   */
  _snapshotPath(taskId) {
    const safeId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.tasksDir, `${safeId}.json`);
  }

  /**
   * Returns the file path for a queued background task execution payload.
   *
   * @param {string} taskId
   * @returns {string}
   */
  _requestPath(taskId) {
    const safeId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.tasksDir, `${safeId}.request.json`);
  }

  /**
   * Returns the file path for a cross-process live steering control request.
   *
   * @param {string} taskId
   * @returns {string}
   */
  _controlPath(taskId) {
    const safeId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.tasksDir, `${safeId}.control.json`);
  }

  /**
   * Checks whether a local OS process PID is currently alive.
   *
   * @param {number} pid
   * @returns {boolean}
   */
  _isPidAlive(pid) {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code === 'EPERM';
    }
  }

  /**
   * Starts a lightweight poller for cross-process / cross-manager `<taskId>.control.json`
   * steering and abort commands while a turn is executing.
   */
  _startControlPoller(taskId, driver, executionPromise) {
    const controlPath = this._controlPath(taskId);
    let stopped = false;
    let processing = false;
    const timer = setInterval(async () => {
      if (stopped || processing || !fs.existsSync(controlPath)) return;
      processing = true;
      let req;
      try {
        req = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
        fs.unlinkSync(controlPath);
      } catch {
        processing = false;
        return;
      }
      if (!req || !req.action) {
        processing = false;
        return;
      }
      const activeExec = this.activeExecutions.get(taskId);
      const snapshot = activeExec?.snapshot || this.getTask(taskId);
      try {
        if (req.action === 'abort') {
          await driver.abort(taskId, snapshot, {
            terminateSession: Boolean(req.terminateSession),
            hasRemoteOwner: false,
          });
          if (snapshot) {
            snapshot.status = 'aborted';
            snapshot.stopReason = 'aborted';
            snapshot.controlAckId = req.id || 'ack';
            delete snapshot.controlError;
            snapshot.metrics.updatedAt = new Date().toISOString();
            snapshot.diagnostic = formatDiagnosticSummary(snapshot);
            this.saveSnapshot(snapshot);
          }
          return;
        }
        if (req.model && snapshot) snapshot.model = req.model;
        if (req.effort && snapshot) snapshot.effort = req.effort;
        const { handledLive, snapshot: steered } = await driver.steerLive(taskId, {
          action: req.action,
          message: req.message,
          snapshot,
          wait: false,
        });
        const targetSnap = steered || snapshot;
        if (targetSnap) {
          targetSnap.controlAckId = req.id || 'ack';
          delete targetSnap.controlError;
          this.saveSnapshot(targetSnap);
        }
      } catch (err) {
        if (snapshot) {
          snapshot.error = err.message || String(err);
          snapshot.controlError = err.message || String(err);
          snapshot.controlAckId = req.id || 'ack';
          if (req.action === 'abort') {
            snapshot.status = 'aborted';
            snapshot.stopReason = 'aborted';
          }
          snapshot.metrics.updatedAt = new Date().toISOString();
          snapshot.diagnostic = formatDiagnosticSummary(snapshot);
          this.saveSnapshot(snapshot);
        }
      } finally {
        processing = false;
      }
    }, 40);
    timer.unref?.();
    const stop = () => {
      if (processing) {
        setTimeout(stop, 40).unref?.();
        return;
      }
      stopped = true;
      clearInterval(timer);
      try {
        if (fs.existsSync(controlPath)) fs.unlinkSync(controlPath);
      } catch {
        // Ignore cleanup race.
      }
    };
    executionPromise.then(stop, stop);
    return stop;
  }

  /**
   * Persists a task snapshot atomically to disk and updates the in-memory cache.
   *
   * @param {object} snapshot
   */
  saveSnapshot(snapshot) {
    normalizeSnapshotEnvelope(snapshot);
    this.memoryTasks.set(snapshot.taskId, snapshot);
    const filePath = this._snapshotPath(snapshot.taskId);
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      try {
        fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      } catch {
        // Ignore write race on teardown.
      }
    }
  }

  /**
   * Loads a task snapshot by ID from disk or memory.
   *
   * @param {string} taskId
   * @returns {object | null}
   */
  getTask(taskId) {
    const filePath = this._snapshotPath(taskId);
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        this.memoryTasks.set(taskId, parsed);
        return parsed;
      } catch {
        // Fall back to in-memory snapshot if disk read races with write.
      }
    }
    return this.memoryTasks.get(taskId) || null;
  }

  /**
   * Lists recent tasks filtered by optional `status` or `targetId`.
   *
   * @param {object} [filters]
   * @param {string} [filters.status]
   * @param {string} [filters.targetId]
   * @param {number} [filters.limit=20]
   * @returns {object[]}
   */
  listTasks({ status, targetId, limit = 20 } = {}) {
    const snapshots = [];
    if (fs.existsSync(this.tasksDir)) {
      const files = fs
        .readdirSync(this.tasksDir)
        .filter(
          (f) =>
            f.endsWith('.json') &&
            !f.endsWith('.request.json') &&
            !f.endsWith('.control.json'),
        );

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.tasksDir, file), 'utf8'));
          if (data && data.taskId) {
            snapshots.push(data);
          }
        } catch {
          // Ignore malformed/partial files.
        }
      }
    }

    snapshots.sort((a, b) => {
      const ta = Date.parse(a.metrics?.updatedAt || a.metrics?.startedAt || 0);
      const tb = Date.parse(b.metrics?.updatedAt || b.metrics?.startedAt || 0);
      return tb - ta;
    });

    return snapshots
      .filter((s) => (!status || s.status === status) && (!targetId || s.targetId === targetId))
      .slice(0, limit);
  }

  /**
   * Queries selectable models and reasoning efforts for a registered target.
   *
   * @param {string} [targetId='local-codex']
   * @returns {Promise<object>}
   */
  async listModels(targetId = 'local-codex') {
    const target = this.registry.getTargetOrThrow(targetId);
    const driver = this.getDriver(target);
    if (typeof driver.listModels === 'function') {
      return driver.listModels({ cwd: target.defaultCwd });
    }
    return {
      targetId: target.id,
      kind: target.kind,
      currentConfig: {
        model: target.model || null,
        effort: target.effort || null,
        provider: null,
      },
      models: target.model
        ? [
            {
              id: target.model,
              model: target.model,
              displayName: target.model,
              description: `Configured default model for ${target.id}`,
              isDefault: true,
              defaultEffort: target.effort || null,
              supportedEfforts: target.effort ? [target.effort] : [],
              effortDetails: [],
              inputModalities: ['text'],
            },
          ]
        : [],
    };
  }

  /**
   * Delegates a new task (or resumes a session) on the specified target.
   *
   * @param {object} request
   * @param {string} request.targetId
   * @param {string} request.prompt
   * @param {string} [request.sessionMode]
   * @param {string} [request.preset='task']
   * @param {string} [request.reinPolicy]
   * @param {string} [request.sessionId]
   * @param {string} [request.cwd]
   * @param {string} [request.model]
   * @param {string} [request.effort]
   * @param {boolean} [request.wait=true]
   * @param {boolean} [request.detachWorker=false]
   * @param {number} [request.timeoutSec]
   * @param {object} [request.trace]
   * @param {boolean} [request.allowTargetReentry=false]
   * @param {(snapshot: object) => void} [onUpdate]
   * @returns {Promise<object>} H2HTaskSnapshot
   */
  async delegate(request, onUpdate = () => {}) {
    const {
      targetId,
      prompt,
      preset = 'task',
      sessionId,
      cwd,
      project: requestProject,
      model,
      effort,
      wait = true,
      detachWorker = false,
      timeoutSec,
      trace: requestTrace,
      allowTargetReentry = false,
    } = request;

    if (!targetId) {
      throw new Error('targetId is required for H2H delegation.');
    }
    if (!prompt || !String(prompt).trim()) {
      throw new Error('prompt is required for H2H delegation.');
    }

    const target = this.registry.getTargetOrThrow(targetId);
    const maxHops = this.registry.config?.hub?.maxHops || 3;

    const { trace, envVars } = advanceTraceOrThrow({
      targetId: target.id,
      requestTrace,
      configuredMaxHops: maxHops,
      allowTargetReentry,
    });

    const sessionMode = resolveSessionMode({
      requestedMode: request.sessionMode,
      preset,
      targetDefaultMode: target.defaultSessionMode,
    });

    const reinPolicy = resolveReinPolicy({
      requestedPolicy: request.reinPolicy,
      preset,
      targetDefaultPolicy: target.defaultPolicy,
    });

    let effectiveProject = requestProject;
    if (sessionId) {
      const priorTasksForSession = this.listTasks({
        targetId: target.id,
        limit: Number.MAX_SAFE_INTEGER,
      }).filter((t) => t.sessionId === sessionId);
      if (priorTasksForSession.some((t) => t.sessionTerminated)) {
        throw new Error(
          `Session "${sessionId}" was terminated via abort --kill and cannot be resumed.`,
        );
      }
      const priorTask = priorTasksForSession.find(
        (t) => t.project && (t.project.id || t.project.root),
      );
      if (priorTask?.project) {
        if (
          requestProject?.id &&
          priorTask.project.id &&
          requestProject.id !== priorTask.project.id
        ) {
          throw new Error(
            `[H2H-PROJ-05] Project binding mismatch: session "${sessionId}" is bound to project "${priorTask.project.id}", cannot rebind to "${requestProject.id}".`,
          );
        }
        if (
          requestProject?.root &&
          priorTask.project.root &&
          path.resolve(requestProject.root).toLowerCase() !==
            path.resolve(priorTask.project.root).toLowerCase()
        ) {
          throw new Error(
            `[H2H-PROJ-05] Project binding mismatch: session "${sessionId}" is bound to project root "${priorTask.project.root}", cannot rebind to "${requestProject.root}".`,
          );
        }
        if (!effectiveProject) {
          effectiveProject = {
            id: priorTask.project.id || null,
            root: priorTask.project.root || null,
          };
        }
      }
    }

    const effectiveCwd = cwd || target.defaultCwd || process.cwd();
    const taskId = `tsk_${crypto.randomBytes(6).toString('hex')}`;
    const timeoutMs =
      (timeoutSec ?? this.registry.config?.hub?.defaultTimeoutSec ?? 600) * 1000;

    const snapshot = createInitialTaskSnapshot({
      taskId,
      targetId: target.id,
      kind: target.kind,
      sessionMode,
      reinPolicy,
      preset,
      cwd: effectiveCwd,
      project: effectiveProject,
      model: model || target.model,
      effort: effort || target.effort,
      sessionId,
      transportType: target.transport?.type || 'local',
      sshHost: target.transport?.host,
      targetRules: target.rules,
      trace,
    });

    this.saveSnapshot(snapshot);

    if (detachWorker) {
      fs.writeFileSync(
        this._requestPath(taskId),
        JSON.stringify({ prompt, envVars, timeoutMs }, null, 2),
        'utf8',
      );
      const workerArgs = [CLI_ENTRY_PATH, '_worker', taskId, '--state-dir', this.stateDir];
      if (
        this.registry?.configSource &&
        this.registry.configSource !== 'built-in defaults' &&
        fs.existsSync(this.registry.configSource)
      ) {
        workerArgs.push('--config', this.registry.configSource);
      }
      const child = spawn(process.execPath, workerArgs, {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      snapshot.workerPid = child.pid;
      snapshot.status = 'running';
      snapshot.diagnostic = formatDiagnosticSummary(snapshot);
      this.saveSnapshot(snapshot);
      if (!wait) {
        return snapshot;
      }

      const deadline = Date.now() + timeoutMs + 10000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 60));
        const latest = this.getTask(taskId);
        if (!latest) break;
        if (
          latest.status === 'completed' ||
          latest.status === 'failed' ||
          latest.status === 'aborted' ||
          latest.status === 'attention_required'
        ) {
          return latest;
        }
        if (!this._isPidAlive(child.pid)) {
          await new Promise((r) => setTimeout(r, 60));
          const finalCheck = this.getTask(taskId) || latest;
          if (finalCheck.status === 'running' || finalCheck.status === 'queued') {
            finalCheck.status = 'failed';
            finalCheck.stopReason = 'error';
            finalCheck.error = finalCheck.error || 'Detached H2H worker exited unexpectedly.';
            this.saveSnapshot(finalCheck);
          }
          return finalCheck;
        }
      }
      return this.getTask(taskId) || snapshot;
    }

    snapshot.workerPid = process.pid;
    const driver = this.getDriver(target);
    const attentionWaiters = new Set();
    const waitForNextStop = (ignoreRequestId = null) => {
      if (
        snapshot.status === 'attention_required' &&
        (snapshot.attention?.requestId || null) !== ignoreRequestId
      ) {
        return Promise.resolve(snapshot);
      }
      if (
        snapshot.status === 'completed' ||
        snapshot.status === 'failed' ||
        snapshot.status === 'aborted'
      ) {
        return Promise.resolve(snapshot);
      }
      return new Promise((resolve) => {
        const waiter = (updated) => {
          if (
            updated.status === 'attention_required' &&
            (updated.attention?.requestId || null) !== ignoreRequestId
          ) {
            attentionWaiters.delete(waiter);
            resolve(updated);
          }
        };
        attentionWaiters.add(waiter);
        executionPromise.then(
          (finalSnap) => {
            attentionWaiters.delete(waiter);
            resolve(finalSnap);
          },
          () => {
            attentionWaiters.delete(waiter);
            resolve(this.getTask(taskId) || snapshot);
          },
        );
      });
    };

    const executionPromise = driver.runTurn(
      snapshot,
      { prompt, envVars, timeoutMs },
      (updated) => {
        this.saveSnapshot(updated);
        onUpdate(updated);
        if (updated.status === 'attention_required') {
          for (const waiter of [...attentionWaiters]) {
            waiter(updated);
          }
        }
      },
    );
    this.activeExecutions.set(taskId, { executionPromise, waitForNextStop, snapshot });
    this._startControlPoller(taskId, driver, executionPromise);

    executionPromise
      .then((finalSnap) => {
        this.activeExecutions.delete(taskId);
        this.saveSnapshot(finalSnap);
      })
      .catch((err) => {
        this.activeExecutions.delete(taskId);
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error = err.message || String(err);
        snapshot.diagnostic = formatDiagnosticSummary(snapshot);
        this.saveSnapshot(snapshot);
      });

    if (!wait) {
      return snapshot;
    }

    const finalOrAttentionSnapshot = await waitForNextStop(null);
    this.saveSnapshot(finalOrAttentionSnapshot);
    return finalOrAttentionSnapshot;
  }

  /**
   * Executes a queued background task from a detached CLI worker process.
   *
   * @param {string} taskId
   * @returns {Promise<object>}
   */
  async runDetachedWorkerTask(taskId) {
    const snapshot = this.getTask(taskId);
    if (!snapshot) {
      throw new Error(`Task "${taskId}" not found.`);
    }
    const reqPath = this._requestPath(taskId);
    if (!fs.existsSync(reqPath)) {
      throw new Error(`Worker request payload for task "${taskId}" not found.`);
    }
    const { prompt, envVars, timeoutMs } = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
    try {
      fs.unlinkSync(reqPath);
    } catch {
      // Ignore.
    }

    snapshot.workerPid = process.pid;
    this.saveSnapshot(snapshot);

    const target = this.registry.getTargetOrThrow(snapshot.targetId);
    const driver = this.getDriver(target);

    const executionPromise = driver.runTurn(
      snapshot,
      { prompt, envVars, timeoutMs },
      (updated) => {
        this.saveSnapshot(updated);
      },
    );
    this.activeExecutions.set(taskId, {
      executionPromise,
      waitForNextStop: () => executionPromise,
      snapshot,
    });
    this._startControlPoller(taskId, driver, executionPromise);

    try {
      const finalSnapshot = await executionPromise;
      this.saveSnapshot(finalSnapshot);
      return finalSnapshot;
    } finally {
      this.activeExecutions.delete(taskId);
    }
  }

  /**
   * Steers an active or completed task (`reply`, `approve`, `reject`, `interrupt`).
   *
   * - If the task is actively running in memory, delegates to `driver.steerLive(...)`.
   * - If `action === 'reply'` and the previous turn has already completed on a session,
   *   resumes the session (`snapshot.sessionId`) and executes a follow-up turn.
   *
   * @param {string} taskId
   * @param {object} params
   * @param {'reply' | 'approve' | 'reject' | 'interrupt'} params.action
   * @param {string} [params.message]
   * @param {string} [params.model]
   * @param {string} [params.effort]
   * @param {boolean} [params.wait=true]
   * @returns {Promise<object>} Updated H2HTaskSnapshot
   */
  async steer(taskId, { action, message, model, effort, wait = true }) {
    const snapshot = this.getTask(taskId);
    if (!snapshot) {
      throw new Error(`Unknown taskId "${taskId}".`);
    }

    if (model) {
      snapshot.model = model;
    }
    if (effort) {
      snapshot.effort = effort;
    }

    const target = this.registry.getTargetOrThrow(snapshot.targetId);
    const driver = this.getDriver(target);

    const activeExec = this.activeExecutions.get(taskId);
    const liveSnapshot = activeExec?.snapshot || snapshot;
    const priorRequestId = liveSnapshot.attention?.requestId || null;
    if (model) {
      liveSnapshot.model = model;
    }
    if (effort) {
      liveSnapshot.effort = effort;
    }

    const { handledLive, snapshot: steeredSnapshot } = await driver.steerLive(taskId, {
      action,
      message,
      snapshot: liveSnapshot,
      wait,
    });
    if (handledLive) {
      if (wait && activeExec) {
        const stoppedSnap = await activeExec.waitForNextStop(priorRequestId);
        this.saveSnapshot(stoppedSnap);
        return stoppedSnap;
      }
      const latest = steeredSnapshot || this.getTask(taskId) || liveSnapshot;
      this.saveSnapshot(latest);
      return latest;
    }

    // Cross-process / cross-manager live steering when another owner has an active turn
    if (
      !this.activeExecutions.has(taskId) &&
      snapshot.workerPid &&
      this._isPidAlive(snapshot.workerPid) &&
      (snapshot.status === 'attention_required' || snapshot.status === 'running')
    ) {
      const priorRequestId = snapshot.attention?.requestId || null;
      const priorUpdatedAt = snapshot.metrics?.updatedAt || null;
      const controlPath = this._controlPath(taskId);
      fs.writeFileSync(
        controlPath,
        JSON.stringify({ id: crypto.randomUUID(), action, message, model, effort }, null, 2),
        'utf8',
      );
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 80));
        const latest = this.getTask(taskId);
        if (!latest) break;
        if (!wait && !fs.existsSync(controlPath) && latest.metrics?.updatedAt !== priorUpdatedAt) {
          return latest;
        }
        if (
          latest.status === 'completed' ||
          latest.status === 'failed' ||
          latest.status === 'aborted'
        ) {
          return latest;
        }
        if (
          latest.status === 'attention_required' &&
          latest.attention?.requestId &&
          latest.attention.requestId !== priorRequestId
        ) {
          return latest;
        }
        if (!this._isPidAlive(snapshot.workerPid)) {
          return latest;
        }
      }
      return this.getTask(taskId);
    }

    if (action === 'interrupt') {
      return this.abort(taskId);
    }

    if (action === 'reply') {
      if (!message || !String(message).trim()) {
        throw new Error('Steer action "reply" requires a non-empty message.');
      }
      if (!snapshot.sessionId) {
        throw new Error(
          `Task "${taskId}" does not have a resumable sessionId (sessionMode=${snapshot.sessionMode}).`,
        );
      }
      if (snapshot.sessionTerminated) {
        throw new Error(
          `Task "${taskId}" session "${snapshot.sessionId}" was terminated via abort --kill and cannot be resumed.`,
        );
      }
      if (snapshot.sessionMode === 'ephemeral') {
        throw new Error(
          `Task "${taskId}" was created in ephemeral mode and its turn has already ended; use --persistent for multi-turn sessions.`,
        );
      }

      const timeoutMs = (this.registry.config?.hub?.defaultTimeoutSec ?? 600) * 1000;
      const envVars = snapshot.trace
        ? {
            H2H_TRACE_ID: snapshot.trace.traceId,
            H2H_HOP_COUNT: String(snapshot.trace.hopCount),
            H2H_MAX_HOPS: String(snapshot.trace.maxHops),
            H2H_CALL_CHAIN: (snapshot.trace.callChain || []).join(','),
            REINS_TRACE_ID: snapshot.trace.traceId,
            REINS_HOP_COUNT: String(snapshot.trace.hopCount),
            REINS_MAX_HOPS: String(snapshot.trace.maxHops),
            REINS_CALL_CHAIN: (snapshot.trace.callChain || []).join(','),
          }
        : {};

      snapshot.workerPid = process.pid;
      snapshot.error = null;
      delete snapshot.controlError;
      this.saveSnapshot(snapshot);

      const attentionWaiters = new Set();
      const waitForNextStop = (ignoreRequestId = null) => {
        if (
          snapshot.status === 'attention_required' &&
          (snapshot.attention?.requestId || null) !== ignoreRequestId
        ) {
          return Promise.resolve(snapshot);
        }
        if (
          snapshot.status === 'completed' ||
          snapshot.status === 'failed' ||
          snapshot.status === 'aborted'
        ) {
          return Promise.resolve(snapshot);
        }
        return new Promise((resolve) => {
          const waiter = (updated) => {
            if (
              updated.status === 'attention_required' &&
              (updated.attention?.requestId || null) !== ignoreRequestId
            ) {
              attentionWaiters.delete(waiter);
              resolve(updated);
            }
          };
          attentionWaiters.add(waiter);
          turnPromise.then(
            (finalSnap) => {
              attentionWaiters.delete(waiter);
              resolve(finalSnap);
            },
            () => {
              attentionWaiters.delete(waiter);
              resolve(this.getTask(taskId) || snapshot);
            },
          );
        });
      };

      const turnPromise = driver.runTurn(
        snapshot,
        { prompt: message, envVars, timeoutMs },
        (updated) => {
          this.saveSnapshot(updated);
          if (updated.status === 'attention_required') {
            for (const waiter of [...attentionWaiters]) {
              waiter(updated);
            }
          }
        },
      );
      this.activeExecutions.set(taskId, {
        executionPromise: turnPromise,
        waitForNextStop,
        snapshot,
      });
      this._startControlPoller(taskId, driver, turnPromise);
      turnPromise
        .then((finalSnap) => {
          this.activeExecutions.delete(taskId);
          this.saveSnapshot(finalSnap);
        })
        .catch((err) => {
          this.activeExecutions.delete(taskId);
          snapshot.status = 'failed';
          snapshot.stopReason = 'error';
          snapshot.error = err.message || String(err);
          snapshot.diagnostic = formatDiagnosticSummary(snapshot);
          this.saveSnapshot(snapshot);
        });

      if (!wait) {
        return snapshot;
      }

      const updated = await waitForNextStop(null);
      this.saveSnapshot(updated);
      return updated;
    }

    throw new Error(
      `Cannot perform steer action "${action}" on task "${taskId}" in status "${snapshot.status}".`,
    );
  }

  /**
   * Aborts an active task and terminates its subprocess tree.
   *
   * @param {string} taskId
   * @param {object} [options]
   * @param {boolean} [options.terminateSession=false]
   * @returns {Promise<object>} Updated H2HTaskSnapshot
   */
  async abort(taskId, { terminateSession = false } = {}) {
    const activeExec = this.activeExecutions.get(taskId);
    const snapshot = activeExec?.snapshot || this.getTask(taskId);
    if (!snapshot) {
      throw new Error(`Unknown taskId "${taskId}".`);
    }

    const isActiveTurn =
      snapshot.status === 'running' ||
      snapshot.status === 'queued' ||
      snapshot.status === 'attention_required';
    const hasRemoteOwner =
      !activeExec &&
      isActiveTurn &&
      Boolean(snapshot.workerPid && this._isPidAlive(snapshot.workerPid));

    const target = this.registry.getTargetOrThrow(snapshot.targetId);
    const driver = this.getDriver(target);
    let abortedInProcess = await driver.abort(taskId, snapshot, {
      terminateSession,
      hasRemoteOwner,
    });

    if (!abortedInProcess && hasRemoteOwner) {
      const controlPath = this._controlPath(taskId);
      const controlId = crypto.randomUUID();
      delete snapshot.controlError;
      delete snapshot.controlAckId;
      this.saveSnapshot(snapshot);
      fs.writeFileSync(
        controlPath,
        JSON.stringify(
          { id: controlId, action: 'abort', terminateSession },
          null,
          2,
        ),
        'utf8',
      );
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40));
        const latest = this.getTask(taskId);
        if (latest && latest.controlAckId === controlId) {
          delete latest.controlAckId;
          if (latest.controlError) {
            const errText = latest.controlError;
            delete latest.controlError;
            this.saveSnapshot(latest);
            throw new Error(errText);
          }
          this.saveSnapshot(latest);
          return latest;
        }
        if (!this._isPidAlive(snapshot.workerPid)) {
          abortedInProcess = true;
          break;
        }
      }
      if (snapshot.workerPid && snapshot.workerPid !== process.pid) {
        if (process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/PID', String(snapshot.workerPid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          try {
            process.kill(snapshot.workerPid, 'SIGTERM');
          } catch {
            // Ignore if already exited.
          }
        }
      }
      if (terminateSession && snapshot.sessionId && !snapshot.sessionTerminated) {
        await driver.abort(taskId, snapshot, {
          terminateSession: true,
          hasRemoteOwner: false,
        });
      }
    }

    snapshot.status = 'aborted';
    snapshot.stopReason = 'aborted';
    snapshot.metrics.updatedAt = new Date().toISOString();
    snapshot.diagnostic = formatDiagnosticSummary(snapshot);
    this.saveSnapshot(snapshot);
    return snapshot;
  }
}
