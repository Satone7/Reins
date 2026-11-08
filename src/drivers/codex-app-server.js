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

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolveExecutable } from '../transports/local.js';
import { createJsonRpcTransport } from '../transports/ssh.js';
import {
  applyPresetPrompt,
  buildResumeCommandHint,
  formatDiagnosticSummary,
  mapReinPolicyToCodex,
} from '../protocol/schema.js';

/**
 * Derives a concise, human-readable thread title for Codex Desktop from a prompt.
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
 * Encodes a length-prefixed JSON frame for the local Codex Desktop IPC router.
 *
 * @param {object} payload
 * @returns {Buffer}
 */
function encodeCodexIpcFrame(payload) {
  const json = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(json, 'utf8');
  const frame = Buffer.alloc(4 + byteLength);
  frame.writeUInt32LE(byteLength, 0);
  frame.write(json, 4, 'utf8');
  return frame;
}

/**
 * Broadcasts a thread update over the local Codex Desktop IPC bus (`\\.\pipe\codex-ipc`
 * on Windows or `~/.codex/ipc/ipc.sock` on Unix) so a running Codex Desktop window
 * immediately hydrates and surfaces the thread without requiring an app restart.
 *
 * @param {object} options
 * @param {string} options.threadId
 * @param {string} [options.codexHome]
 * @param {number} [options.timeoutMs=1200]
 * @returns {Promise<boolean>} True if a running Codex Desktop IPC router accepted the broadcast
 */
export async function notifyCodexDesktopIpc({ threadId, codexHome, timeoutMs = 1200 }) {
  if (!threadId) return false;
  const endpoint =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\codex-ipc'
      : path.join(codexHome || path.join(os.homedir(), '.codex'), 'ipc', 'ipc.sock');

  return new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const initRequestId = randomUUID();

    const finish = (ok, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.end();
        socket?.destroy();
      } catch {
        // Ignore socket teardown errors.
      }
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false, null), timeoutMs);
    timer.unref?.();

    let socket;
    try {
      socket = net.connect(endpoint, () => {
        try {
          socket.write(
            encodeCodexIpcFrame({
              type: 'request',
              requestId: initRequestId,
              sourceClientId: 'initializing-client',
              version: 0,
              method: 'initialize',
              params: { clientType: 'cli' },
            }),
          );
        } catch {
          finish(false, socket);
        }
      });
    } catch {
      finish(false, null);
      return;
    }

    socket.on('error', () => finish(false, socket));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const frameLen = buffer.readUInt32LE(0);
        if (frameLen === 0 || frameLen > 0x1000000) {
          finish(false, socket);
          return;
        }
        if (buffer.length < 4 + frameLen) return;
        const rawJson = buffer.subarray(4, 4 + frameLen).toString('utf8');
        buffer = buffer.subarray(4 + frameLen);
        let msg;
        try {
          msg = JSON.parse(rawJson);
        } catch {
          continue;
        }
        if (msg?.type === 'response' && msg?.requestId === initRequestId) {
          const clientId = msg?.result?.clientId || 'reins-h2h-client';
          try {
            const unarchiveFrame = encodeCodexIpcFrame({
              type: 'broadcast',
              method: 'thread-unarchived',
              sourceClientId: clientId,
              params: {
                hostId: 'local',
                conversationId: threadId,
              },
              version: 1,
            });
            const invalidateFrame = encodeCodexIpcFrame({
              type: 'broadcast',
              method: 'query-cache-invalidate',
              sourceClientId: clientId,
              params: {
                queryKey: [],
              },
              version: 1,
            });
            socket.write(Buffer.concat([unarchiveFrame, invalidateFrame]), () =>
              finish(true, socket),
            );
          } catch {
            finish(false, socket);
          }
          return;
        }
      }
    });
  });
}

/**
 * Strips the Windows extended-length path prefix (`\\?\` and `\\?\UNC\`) produced by
 * Rust `std::fs::canonicalize` so paths match Codex Desktop's Electron path normalization.
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

/**
 * Checks whether a workspace path is already registered in Codex Desktop's `local-projects`,
 * selecting the most specific (longest) matching project root.
 *
 * @param {Record<string, any>} localProjects
 * @param {string} targetCwd
 * @returns {string | null} Matching projectId if found
 */
function findMatchingCodexProjectId(localProjects, targetCwd) {
  if (!localProjects || typeof localProjects !== 'object' || !targetCwd) return null;
  const normTarget = path.resolve(normalizeCodexPath(targetCwd)).replace(/[\\/]+$/, '').toLowerCase();
  let bestId = null;
  let bestLen = -1;
  for (const [projectId, proj] of Object.entries(localProjects)) {
    const roots = Array.isArray(proj?.rootPaths) ? proj.rootPaths : [];
    for (const root of roots) {
      const normRoot = path.resolve(normalizeCodexPath(root)).replace(/[\\/]+$/, '').toLowerCase();
      if (normTarget === normRoot || normTarget.startsWith(`${normRoot}${path.sep}`)) {
        if (normRoot.length > bestLen) {
          bestLen = normRoot.length;
          bestId = projectId;
        }
      }
    }
  }
  return bestId;
}

/**
 * Ensures `cwd` is marked as trusted in `~/.codex/config.toml` so Codex Desktop can
 * register the workspace folder without blocking on an interactive trust prompt.
 *
 * @param {string} codexHome
 * @param {string} cwd
 */
function ensureCodexConfigTrustedProject(codexHome, cwd) {
  try {
    const configPath = path.join(codexHome, 'config.toml');
    if (!fs.existsSync(configPath) || !cwd) return;
    const raw = fs.readFileSync(configPath, 'utf8');
    const resolved = path.resolve(normalizeCodexPath(cwd));
    const lower = resolved.toLowerCase();
    const candidates = [resolved];
    if (lower !== resolved) candidates.push(lower);
    let appended = '';
    for (const candidate of candidates) {
      if (!raw.includes(`[projects.'${candidate}']`) && !raw.includes(`[projects."${candidate}"]`)) {
        appended += `\n[projects.'${candidate}']\ntrust_level = "trusted"\n`;
      }
    }
    if (appended) {
      fs.appendFileSync(configPath, appended, 'utf8');
    }
  } catch {
    // Non-fatal best-effort config update.
  }
}

/**
 * Synchronizes a persistent Codex session into Codex Desktop's SQLite catalog
 * (`~/.codex/state_5.sqlite`, `~/.codex/sqlite/codex.db`, and `~/.codex/session_index.jsonl`)
 * and notifies any running Codex Desktop instance so the session appears in the sidebar.
 *
 * @param {object} options
 * @param {string} options.threadId
 * @param {string} [options.cwd]
 * @param {string} [options.title]
 * @param {string} [options.codexHome]
 * @param {boolean} [options.notifyRunningDesktop=true]
 * @returns {Promise<{ syncedStateDb: boolean, syncedCatalogDb: boolean, ipcNotified: boolean }>}
 */
export async function syncCodexDesktopCatalog({
  threadId,
  cwd,
  title,
  projectId = null,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  notifyRunningDesktop = true,
}) {
  const result = {
    syncedStateDb: false,
    syncedCatalogDb: false,
    ipcNotified: false,
    projectId: projectId || null,
  };
  if (!threadId || !codexHome) return result;

  const effectiveCwd = normalizeCodexPath(cwd ? path.resolve(normalizeCodexPath(cwd)) : process.cwd());
  const effectiveTitle = (title && String(title).trim()) || `[Reins] ${threadId}`;
  const nowSec = Math.floor(Date.now() / 1000);
  let threadRow = null;

  // 1. Update `~/.codex/state_5.sqlite` (`threads` table and `project_roots` lookup)
  let serverProjectId = projectId || null;
  const stateDbPath = path.join(codexHome, 'state_5.sqlite');
  if (fs.existsSync(stateDbPath)) {
    let stateDb = null;
    try {
      stateDb = new DatabaseSync(stateDbPath);
      stateDb.exec('PRAGMA busy_timeout = 3000;');

      const existingRow = stateDb
        .prepare(`SELECT cwd, project_id FROM threads WHERE id = ?`)
        .get(threadId);
      const normalizedCwd = normalizeCodexPath(existingRow?.cwd || effectiveCwd);

      try {
        const projectRoots = stateDb
          .prepare(`SELECT project_id, path FROM project_roots`)
          .all();
        const normTarget = path.resolve(normalizedCwd).replace(/[\\/]+$/, '').toLowerCase();
        let bestLen = -1;
        for (const pr of projectRoots) {
          const normRoot = path
            .resolve(normalizeCodexPath(pr.path))
            .replace(/[\\/]+$/, '')
            .toLowerCase();
          if (normTarget === normRoot || normTarget.startsWith(`${normRoot}${path.sep}`)) {
            if (normRoot.length > bestLen) {
              bestLen = normRoot.length;
              serverProjectId = pr.project_id;
            }
          }
        }
        if (!serverProjectId) {
          const newProjId = randomUUID();
          const nowMs = Date.now();
          const maxPosRow = stateDb.prepare(`SELECT COALESCE(MAX(position), -1) AS maxPos FROM projects`).get();
          const nextPos = (Number(maxPosRow?.maxPos) || 0) + 1;
          const projName = path.basename(normalizedCwd) || 'Workspace';
          stateDb
            .prepare(
              `INSERT INTO projects (id, name, metadata, position, created_at_ms, updated_at_ms)
               VALUES (?, ?, '{}', ?, ?, ?)`,
            )
            .run(newProjId, projName, nextPos, nowMs, nowMs);
          stateDb
            .prepare(
              `INSERT INTO project_roots (project_id, position, path)
               VALUES (?, 0, ?)`,
            )
            .run(newProjId, normalizedCwd);
          serverProjectId = newProjId;
        }
      } catch {
        // Ignore if `project_roots` table is not present on older Codex versions.
      }

      stateDb
        .prepare(
          `UPDATE threads
              SET originator = 'Codex Desktop',
                  thread_source = 'user',
                  cwd = ?,
                  project_id = COALESCE(?, project_id),
                  title = CASE
                    WHEN title IS NULL OR TRIM(title) = '' THEN ?
                    ELSE title
                  END,
                  name = CASE
                    WHEN name IS NULL OR TRIM(name) = '' THEN ?
                    ELSE name
                  END
            WHERE id = ?`,
        )
        .run(normalizedCwd, serverProjectId, effectiveTitle, effectiveTitle, threadId);

      threadRow = stateDb
        .prepare(
          `SELECT id, created_at, updated_at, cwd, source, model_provider, git_branch, title, name, rollout_path, project_id
             FROM threads
            WHERE id = ?`,
        )
        .get(threadId);
      serverProjectId = threadRow?.project_id || serverProjectId;
      result.projectId = serverProjectId;
      result.syncedStateDb = Boolean(threadRow);
    } catch {
      // Ignore SQLite contention or schema differences.
    } finally {
      try {
        stateDb?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  // Also patch the rollout JSONL file's `session_meta.payload.originator` if it is 'reins'
  if (threadRow?.rollout_path) {
    try {
      const rolloutPath = normalizeCodexPath(threadRow.rollout_path);
      if (fs.existsSync(rolloutPath)) {
        const rawRollout = fs.readFileSync(rolloutPath, 'utf8');
        if (rawRollout.includes('"originator":"reins"')) {
          const patchedRollout = rawRollout.replace(
            '"originator":"reins"',
            '"originator":"Codex Desktop"',
          );
          fs.writeFileSync(rolloutPath, patchedRollout, 'utf8');
        }
      }
    } catch {
      // Non-fatal rollout metadata patch.
    }
  }

  const displayTitle =
    (threadRow?.name && String(threadRow.name).trim()) ||
    (threadRow?.title && String(threadRow.title).trim()) ||
    effectiveTitle;
  const sourceCreatedAt = Number.isFinite(threadRow?.created_at) ? threadRow.created_at : nowSec;
  const sourceUpdatedAt = Number.isFinite(threadRow?.updated_at) ? threadRow.updated_at : nowSec;
  const rowCwd = normalizeCodexPath(threadRow?.cwd || effectiveCwd);
  const modelProvider = threadRow?.model_provider || 'openai';
  const gitBranch = threadRow?.git_branch || null;

  // 2. Upsert into `~/.codex/sqlite/codex.db` (`local_thread_catalog` table)
  const catalogDbPath = path.join(codexHome, 'sqlite', 'codex.db');
  if (fs.existsSync(catalogDbPath)) {
    let catalogDb = null;
    try {
      catalogDb = new DatabaseSync(catalogDbPath);
      catalogDb.exec('PRAGMA busy_timeout = 3000;');

      const syncState = catalogDb
        .prepare(
          `SELECT observation_sequence, watermark_updated_at
             FROM local_thread_catalog_sync_state
            WHERE host_id = 'local'`,
        )
        .get();
      const nextObsSeq = (Number(syncState?.observation_sequence) || 0) + 1;
      const nextWatermark = Math.max(Number(syncState?.watermark_updated_at) || 0, sourceUpdatedAt);

      catalogDb
        .prepare(
          `INSERT INTO local_thread_catalog (
             host_id, thread_id, display_title, source_created_at, source_updated_at,
             cwd, source_kind, source_detail, model_provider, git_branch,
             observation_sequence, missing_candidate, thread_source, source_recency_at,
             pending_observed_title, project_id
           ) VALUES (
             'local', ?, ?, ?, ?,
             ?, 'vscode', NULL, ?, ?,
             ?, 0, 'user', ?,
             0, ?
           )
           ON CONFLICT(host_id, thread_id) DO UPDATE SET
             display_title = excluded.display_title,
             source_updated_at = excluded.source_updated_at,
             source_recency_at = excluded.source_recency_at,
             cwd = excluded.cwd,
             source_kind = 'vscode',
             thread_source = 'user',
             missing_candidate = 0,
             observation_sequence = excluded.observation_sequence,
             project_id = COALESCE(excluded.project_id, local_thread_catalog.project_id)`,
        )
        .run(
          threadId,
          displayTitle,
          sourceCreatedAt,
          sourceUpdatedAt,
          rowCwd,
          modelProvider,
          gitBranch,
          nextObsSeq,
          sourceUpdatedAt,
          serverProjectId,
        );

      catalogDb
        .prepare(
          `UPDATE local_thread_catalog_sync_state
              SET observation_sequence = ?,
                  watermark_updated_at = ?
            WHERE host_id = 'local'`,
        )
        .run(nextObsSeq, nextWatermark);

      catalogDb
        .prepare(
          `UPDATE local_thread_catalog_metadata
              SET catalog_revision = catalog_revision + 1
            WHERE id = 1`,
        )
        .run();

      result.syncedCatalogDb = true;
    } catch {
      // Ignore if catalog table does not exist.
    } finally {
      try {
        catalogDb?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  // 3. Ensure `~/.codex/session_index.jsonl` contains the thread entry
  try {
    const indexPath = path.join(codexHome, 'session_index.jsonl');
    let alreadyPresent = false;
    if (fs.existsSync(indexPath)) {
      const existing = fs.readFileSync(indexPath, 'utf8');
      alreadyPresent = existing.includes(`"id":"${threadId}"`);
    }
    if (!alreadyPresent) {
      fs.appendFileSync(
        indexPath,
        `${JSON.stringify({
          id: threadId,
          thread_name: displayTitle,
          updated_at: new Date(sourceUpdatedAt * 1000).toISOString(),
        })}\n`,
        'utf8',
      );
    }
  } catch {
    // Non-fatal index append.
  }

  // 4. Notify running Codex Desktop instance (if any) and ensure project root visibility
  if (notifyRunningDesktop) {
    ensureCodexConfigTrustedProject(codexHome, rowCwd);
    result.ipcNotified = await notifyCodexDesktopIpc({ threadId, codexHome });

    const globalStatePath = path.join(codexHome, '.codex-global-state.json');
    if (!result.ipcNotified && fs.existsSync(globalStatePath)) {
      try {
        const globalState = JSON.parse(fs.readFileSync(globalStatePath, 'utf8'));
        const localProjects = globalState['local-projects'] || {};
        const matchedProjectId = findMatchingCodexProjectId(localProjects, rowCwd);

        if (!matchedProjectId) {
          const newProjectId = serverProjectId || randomUUID();
          const nowMs = Date.now();
          localProjects[newProjectId] = {
            id: newProjectId,
            name: path.basename(rowCwd) || 'Workspace',
            rootPaths: [rowCwd],
            createdAt: nowMs,
            updatedAt: nowMs,
          };
          globalState['local-projects'] = localProjects;
          const projectOrder = Array.isArray(globalState['project-order'])
            ? globalState['project-order']
            : [];
          if (!projectOrder.includes(newProjectId)) {
            globalState['project-order'] = [newProjectId, ...projectOrder];
          }
          globalState['selected-project'] = { type: 'local', projectId: newProjectId };
          fs.writeFileSync(globalStatePath, JSON.stringify(globalState), 'utf8');
        }
      } catch {
        // Ignore global state parse/write errors.
      }
    }
  }

  return result;
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
   * Queries `codex app-server --stdio` for all selectable models, their supported
   * reasoning efforts, and the current user-configured defaults.
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
      ? (this.targetConfig.command && this.targetConfig.command !== 'auto' ? this.targetConfig.command : 'codex')
      : resolveExecutable(this.targetConfig.command || 'auto', 'codex');
    const args = Array.isArray(this.targetConfig.args) && this.targetConfig.args.length > 0
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
          effort:
            this.targetConfig.effort ||
            userConfig.model_reasoning_effort ||
            null,
          provider: userConfig.model_provider || null,
        },
        models,
      };
    } finally {
      await transport.close().catch(() => {});
    }
  }

  /**
   * Ensures `effectiveProjectRoot` is registered as a first-class project in `codex app-server`
   * via `project/list` and `project/create`, selecting the most-specific matching project root
   * and returning its `projectId`.
   *
   * @param {object} transport
   * @param {string} effectiveProjectRoot
   * @param {boolean} [isSsh=false]
   * @returns {Promise<string | null>}
   */
  async _ensureCodexProject(transport, effectiveProjectRoot, isSsh = false) {
    if (!effectiveProjectRoot) return null;
    const normPath = (p) =>
      isSsh
        ? String(p || '').replace(/\/+$/, '')
        : path.resolve(normalizeCodexPath(p)).replace(/[\\/]+$/, '').toLowerCase();

    const targetNorm = normPath(effectiveProjectRoot);
    const listRes = await transport.request('project/list', {}, 10000);
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
      return bestId;
    }

    const projName =
      (isSsh ? path.posix.basename(effectiveProjectRoot) : path.basename(effectiveProjectRoot)) ||
      'Workspace';
    const createdRes = await transport.request(
      'project/create',
      {
        idempotencyKey: randomUUID(),
        name: projName,
        roots: [{ path: effectiveProjectRoot }],
      },
      10000,
    );
    return createdRes?.project?.id || bestId || null;
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
      if (snapshot.status === 'running' || snapshot.status === 'queued' || snapshot.status === 'attention_required') {
        if (runtime.committedOutput !== undefined) {
          snapshot.output = runtime.committedOutput;
        }
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

      const isPersistent = snapshot.sessionMode === 'persistent';
      const threadTitle = deriveCodexThreadTitle(prompt, snapshot);
      const codexHome =
        envVars.CODEX_HOME ||
        this.targetConfig.env?.CODEX_HOME ||
        process.env.CODEX_HOME ||
        path.join(os.homedir(), '.codex');
      const rawTargetCwd = snapshot.cwd || process.cwd();
      const effectiveCwd = isSsh ? rawTargetCwd : normalizeCodexPath(path.resolve(rawTargetCwd));
      const explicitProjectRoot = snapshot.projectSelector?.root || null;
      const effectiveProjectRoot = isSsh
        ? explicitProjectRoot || effectiveCwd
        : explicitProjectRoot
          ? normalizeCodexPath(path.resolve(normalizeCodexPath(explicitProjectRoot)))
          : resolveGitWorktreeRoot(effectiveCwd);
      runtime.effectiveProjectRoot = effectiveProjectRoot;

      if (isPersistent && !isSsh) {
        ensureCodexConfigTrustedProject(codexHome, effectiveProjectRoot);
        if (effectiveCwd !== effectiveProjectRoot) {
          ensureCodexConfigTrustedProject(codexHome, effectiveCwd);
        }
      }

      // 1. Handshake
      await transport.request(
        'initialize',
        {
          clientInfo: {
            name: isPersistent ? 'Codex Desktop' : 'reins',
            title: isPersistent ? 'Codex Desktop' : 'Reins H2H Hub',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
          },
        },
        20000,
      );
      transport.notify('initialized');

      // 1b. Ensure target project workspace is onboarded in Codex app-server when persistent
      let projectId = snapshot.project?.id || null;
      if (isPersistent) {
        if (!projectId) {
          projectId = await this._ensureCodexProject(transport, effectiveProjectRoot, isSsh).catch(
            () => null,
          );
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
      if (!isNewThread && !isSsh) {
        const stateDbPath = path.join(codexHome, 'state_5.sqlite');
        if (fs.existsSync(stateDbPath)) {
          let stateDb = null;
          try {
            stateDb = new DatabaseSync(stateDbPath);
            stateDb.exec('PRAGMA busy_timeout = 2000;');
            const tRow = stateDb
              .prepare(`SELECT project_id, cwd FROM threads WHERE id = ?`)
              .get(runtime.threadId);
            if (tRow?.project_id) {
              existingThreadProjectId = tRow.project_id;
              const pRoots = stateDb
                .prepare(`SELECT path FROM project_roots WHERE project_id = ?`)
                .all(existingThreadProjectId);
              existingThreadRoots = pRoots.map((r) => r.path).filter(Boolean);
            } else if (tRow?.cwd) {
              existingThreadRoots = [tRow.cwd];
            }
          } catch {
            // Ignore SQLite read errors.
          } finally {
            try {
              stateDb?.close();
            } catch {
              // Ignore close errors.
            }
          }
        }
      }

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
        if (resumeRes?.thread?.cwd && existingThreadRoots.length === 0) {
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

      let metadataBound = false;
      let metadataRpcUnsupported = false;
      if (isPersistent && projectId) {
        metadataBound = await transport
          .request(
            'thread/metadata/update',
            {
              threadId: runtime.threadId,
              projectId,
            },
            5000,
          )
          .then((res) => Boolean(res?.thread?.projectId === projectId))
          .catch((err) => {
            if (err?.code === -32601 || /method not found/i.test(String(err?.message || ''))) {
              metadataRpcUnsupported = true;
            }
            return false;
          });
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

      if (isPersistent && !isSsh) {
        const syncRes = await syncCodexDesktopCatalog({
          threadId: runtime.threadId,
          cwd: effectiveProjectRoot,
          title: threadTitle,
          projectId,
          codexHome,
        }).catch(() => null);
        if (syncRes?.projectId && !projectId && metadataRpcUnsupported) {
          projectId = syncRes.projectId;
        }
        if (syncRes?.syncedStateDb && projectId && metadataRpcUnsupported) {
          metadataBound = true;
        }
      }

      if (isPersistent) {
        snapshot.project = {
          id: projectId,
          root: effectiveProjectRoot,
          binding: projectId && metadataBound ? 'bound' : 'failed',
          mechanism: projectId && metadataBound ? 'native-id' : null,
        };
        if (snapshot.project.binding !== 'bound') {
          throw new Error(
            `[H2H-PROJ-04] Failed to bind persistent session "${runtime.threadId}" to project (${snapshot.projectSelector?.id || projectId || effectiveProjectRoot}).`,
          );
        }
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

      if (isPersistent && !isSsh) {
        await syncCodexDesktopCatalog({
          threadId: runtime.threadId,
          cwd: effectiveProjectRoot,
          title: threadTitle,
          projectId,
          codexHome,
        }).catch(() => {});
      }

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
        // Stream verified final-answer deltas while keeping committedOutput intact
        snapshot.output = `${snapshot.output || ''}${delta}`;
        emitUpdate();
      } else if (knownPhase === null && itemId) {
        // Buffer deltas whose phase is not yet known so commentary never leaks into output
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
          snapshot.commentary = snapshot.commentary
            ? `${snapshot.commentary}\n${text}`
            : text;
          // Restore committed output in case deltas arrived before phase was known
          snapshot.output = runtime.committedOutput ?? '';
        } else {
          // Authoritative final text for the completed agentMessage item
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
          (typeof turn.error === 'string' ? turn.error : JSON.stringify(turn.error || 'Codex turn failed'));
      }
      emitUpdate();
      runtime.turnDoneResolve(snapshot);
    }
  }

  /**
   * Checks whether an approval request under `auto-edit` is strictly confined to the
   * bound workspace root (`effectiveProjectRoot`) and does not request outside-workspace
   * permissions or interactive user input.
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
      // In Codex `workspace-write` sandbox mode, sandboxed workspace commands run without
      // requesting approval; any command approval request must prove explicit sandbox
      // confinement (`sandboxed: true` and verified `writableRoots`) or be escalated.
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

    // Under `parent-rein` or `tight-rein` (or escalated `auto-edit`), pause task in `attention_required`
    // state so the parent agent or human operator can approve/reject via `reins steer`.
    snapshot.status = 'attention_required';
    snapshot.stopReason = 'attention-required';
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

  /**
   * Waits for an active turn to either complete or pause at the next `attention_required` gate.
   */
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
   * Steers an active in-flight turn (approving/rejecting a pending tool call, injecting
   * mid-turn guidance via `turn/steer`, or interrupting the active turn).
   *
   * @param {string} taskId
   * @param {object} steerParams
   * @param {'reply' | 'approve' | 'reject' | 'interrupt'} steerParams.action
   * @param {string} [steerParams.message]
   * @param {boolean} [steerParams.wait=false]
   * @returns {Promise<{ handledLive: boolean, snapshot?: object }>}
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
      ? (this.targetConfig.command && this.targetConfig.command !== 'auto' ? this.targetConfig.command : 'codex')
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
   * When `terminateSession: true` (`--kill`) is requested, also archives/terminates
   * the underlying Codex session (`thread/archive`) and clears `resumeCommandHint`
   * only after `thread/archive` succeeds.
   *
   * @param {string} taskId
   * @param {object} [snapshot]
   * @param {object} [options]
   * @param {boolean} [options.terminateSession=false]
   * @param {boolean} [options.hasRemoteOwner=false]
   * @returns {Promise<boolean>}
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
