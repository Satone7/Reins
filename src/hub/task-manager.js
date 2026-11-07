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
  resolveReinPolicy,
  resolveSessionMode,
} from '../protocol/schema.js';
import { advanceTraceOrThrow } from './loop-guard.js';
import { expandHome, TargetRegistry } from './registry.js';
import { CodexAppServerDriver } from '../drivers/codex-app-server.js';

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
      default:
        throw new Error(
          `Southbound driver "${target.driver}" for target "${target.id}" (${target.kind}) is not yet registered.`,
        );
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
   * Persists a task snapshot atomically to disk and updates the in-memory cache.
   *
   * @param {object} snapshot
   */
  saveSnapshot(snapshot) {
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
        .filter((f) => f.endsWith('.json') && !f.endsWith('.request.json'));

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
      model,
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
    const maxHops = this.registry.config?.hub?.maxHops || 4;

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
      model: model || target.model,
      sessionId,
      transportType: target.transport?.type || 'local',
      sshHost: target.transport?.host,
      trace,
    });

    this.saveSnapshot(snapshot);

    if (!wait && detachWorker) {
      fs.writeFileSync(
        this._requestPath(taskId),
        JSON.stringify({ prompt, envVars, timeoutMs }, null, 2),
        'utf8',
      );
      const child = spawn(
        process.execPath,
        [CLI_ENTRY_PATH, '_worker', taskId, '--state-dir', this.stateDir],
        {
          cwd: process.cwd(),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.unref();
      snapshot.workerPid = child.pid;
      snapshot.status = 'running';
      snapshot.diagnostic = formatDiagnosticSummary(snapshot);
      this.saveSnapshot(snapshot);
      return snapshot;
    }

    const driver = this.getDriver(target);
    const executionPromise = driver.runTurn(
      snapshot,
      { prompt, envVars, timeoutMs },
      (updated) => {
        this.saveSnapshot(updated);
        onUpdate(updated);
      },
    );

    if (!wait) {
      executionPromise.catch((err) => {
        snapshot.status = 'failed';
        snapshot.stopReason = 'error';
        snapshot.error = err.message || String(err);
        snapshot.diagnostic = formatDiagnosticSummary(snapshot);
        this.saveSnapshot(snapshot);
      });
      return snapshot;
    }

    const finalSnapshot = await executionPromise;
    this.saveSnapshot(finalSnapshot);
    return finalSnapshot;
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

    const finalSnapshot = await driver.runTurn(
      snapshot,
      { prompt, envVars, timeoutMs },
      (updated) => {
        this.saveSnapshot(updated);
      },
    );
    this.saveSnapshot(finalSnapshot);
    return finalSnapshot;
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
   * @param {boolean} [params.wait=true]
   * @returns {Promise<object>} Updated H2HTaskSnapshot
   */
  async steer(taskId, { action, message, wait = true }) {
    const snapshot = this.getTask(taskId);
    if (!snapshot) {
      throw new Error(`Unknown taskId "${taskId}".`);
    }

    const target = this.registry.getTargetOrThrow(snapshot.targetId);
    const driver = this.getDriver(target);

    const { handledLive } = await driver.steerLive(taskId, { action, message });
    if (handledLive) {
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
      if (snapshot.sessionMode === 'ephemeral') {
        throw new Error(
          `Task "${taskId}" was created in ephemeral mode and its turn has already ended; use --persistent for multi-turn sessions.`,
        );
      }

      const timeoutMs = (this.registry.config?.hub?.defaultTimeoutSec ?? 600) * 1000;
      const envVars = snapshot.trace
        ? {
            REINS_TRACE_ID: snapshot.trace.traceId,
            REINS_HOP_COUNT: String(snapshot.trace.hopCount),
            REINS_MAX_HOPS: String(snapshot.trace.maxHops),
            REINS_CALL_CHAIN: (snapshot.trace.callChain || []).join(','),
          }
        : {};

      const turnPromise = driver.runTurn(
        snapshot,
        { prompt: message, envVars, timeoutMs },
        (updated) => {
          this.saveSnapshot(updated);
        },
      );

      if (!wait) {
        turnPromise.catch(() => {});
        return snapshot;
      }

      const updated = await turnPromise;
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
   * @returns {Promise<object>} Updated H2HTaskSnapshot
   */
  async abort(taskId) {
    const snapshot = this.getTask(taskId);
    if (!snapshot) {
      throw new Error(`Unknown taskId "${taskId}".`);
    }

    const target = this.registry.getTargetOrThrow(snapshot.targetId);
    const driver = this.getDriver(target);
    const abortedInProcess = await driver.abort(taskId);

    if (!abortedInProcess && snapshot.workerPid && snapshot.workerPid !== process.pid) {
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

    snapshot.status = 'aborted';
    snapshot.stopReason = 'aborted';
    snapshot.metrics.updatedAt = new Date().toISOString();
    snapshot.diagnostic = formatDiagnosticSummary(snapshot);
    this.saveSnapshot(snapshot);
    return snapshot;
  }
}
