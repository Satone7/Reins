#!/usr/bin/env node

/**
 * Reins MCP Server (`reins-mcp`) — Northbound Model Context Protocol Server
 *
 * Exposes the 5 canonical H2H Protocol v0.2 tools over stdio JSON-RPC 2.0:
 * - `reins_targets`
 * - `reins_delegate`
 * - `reins_status`
 * - `reins_steer`
 * - `reins_abort`
 */

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { TaskManager } from '../hub/task-manager.js';
import {
  REASONING_EFFORTS,
  REIN_POLICIES,
  SESSION_MODES,
  STEER_ACTIONS,
  TASK_PRESETS,
  TASK_STATUSES,
} from '../protocol/schema.js';

export const MCP_TOOLS = Object.freeze([
  {
    name: 'reins_targets',
    description:
      'List all local and remote AI coding harnesses (Codex, Antigravity, DSH, Claude Code) registered in Reins along with their session modes, policies, caller usage rules (`rules`), and availability. Pass targetId or includeModels=true to also retrieve selectable models and reasoning effort levels.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: {
          type: 'string',
          description: 'Optional target ID (e.g., "local-codex", "local-dsh", "remote-claude") to inspect along with its selectable models and reasoning efforts.',
        },
        includeModels: {
          type: 'boolean',
          description: 'If true, query selectable models and reasoning effort levels for the specified targetId (or Codex targets).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reins_delegate',
    description:
      'Delegate a coding task, review, or rescue operation to a target Harness (or resume an existing session). Choose sessionMode="persistent" for multi-turn/resumable work or sessionMode="ephemeral" for one-shot tasks. IMPORTANT: Before delegating, inspect the target\'s `rules` field via `reins_targets` and strictly obey all target-specific caller rules when composing `prompt`.',
    inputSchema: {
      type: 'object',
      required: ['targetId', 'prompt'],
      properties: {
        targetId: {
          type: 'string',
          description: 'Registered target ID (e.g., "local-codex", "local-agy", "local-dsh", "remote-dsh", "remote-claude").',
        },
        prompt: {
          type: 'string',
          description: 'Task instructions or follow-up prompt.',
        },
        sessionMode: {
          type: 'string',
          enum: SESSION_MODES,
          description:
            '"persistent" saves the session in the target Harness default store so the user can resume it natively; "ephemeral" runs burn-after-reading without cluttering user session lists.',
        },
        preset: {
          type: 'string',
          enum: TASK_PRESETS,
          description: 'Task preset ("task", "review", "adversarial-review", "rescue").',
        },
        reinPolicy: {
          type: 'string',
          enum: REIN_POLICIES,
          description: 'Permission and sandbox policy ("free-rein", "auto-edit", "parent-rein", "tight-rein", "plan-only").',
        },
        sessionId: {
          type: 'string',
          description: 'Optional native session/thread ID to resume.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory on the target host.',
        },
        project: {
          type: 'object',
          description: 'Optional Project Onboarding & Session Binding selector.',
          properties: {
            id: {
              type: 'string',
              description: 'Explicit native project ID in the target Harness.',
            },
            root: {
              type: 'string',
              description: 'Explicit project root directory on the target host.',
            },
          },
          additionalProperties: false,
        },
        model: {
          type: 'string',
          description: 'Optional model override (e.g., "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna").',
        },
        effort: {
          type: 'string',
          enum: REASONING_EFFORTS,
          description: 'Optional reasoning effort override ("low", "medium", "high", "xhigh", "max", "ultra").',
        },
        wait: {
          type: 'boolean',
          description: 'If true (default), wait for turn completion; if false, run asynchronously and return taskId immediately.',
        },
        timeoutSec: {
          type: 'number',
          description: 'Maximum turn duration in seconds (default: 600).',
        },
        allowTargetReentry: {
          type: 'boolean',
          description: 'If true, allow intentional ping-pong re-entry to a target already in the call chain (still bounded by maxHops).',
        },
        trace: {
          type: 'object',
          description: 'Optional Loop Guard trace context propagated from parent Harness.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reins_status',
    description:
      'Query the canonical H2HTaskSnapshot (status, output, commentary, resumeCommandHint, attention requests, and transcript) of a specific taskId, or list recent delegated tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID to inspect. Omit to list recent tasks.',
        },
        status: {
          type: 'string',
          enum: TASK_STATUSES,
          description: 'Optional status filter when listing tasks.',
        },
        targetId: {
          type: 'string',
          description: 'Optional targetId filter when listing tasks.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of tasks to return when listing (default: 20).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reins_steer',
    description:
      'Steer an active or persistent H2H task: send a multi-turn reply ("reply"), approve/reject a pending tool call ("approve" / "reject"), or interrupt the current turn ("interrupt").',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'action'],
      properties: {
        taskId: {
          type: 'string',
          description: 'Target taskId.',
        },
        action: {
          type: 'string',
          enum: STEER_ACTIONS,
          description: 'Steering action: "reply", "approve", "reject", or "interrupt".',
        },
        message: {
          type: 'string',
          description: 'Follow-up prompt message when action="reply".',
        },
        model: {
          type: 'string',
          description: 'Optional model override for the steered turn.',
        },
        effort: {
          type: 'string',
          enum: REASONING_EFFORTS,
          description: 'Optional reasoning effort override for the steered turn ("low", "medium", "high", "xhigh", "max", "ultra").',
        },
        wait: {
          type: 'boolean',
          description: 'Whether to wait for the steered turn to complete (default: true).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reins_abort',
    description:
      'Hard-abort a delegated task and terminate its entire subprocess tree on the target host.',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID to abort.',
        },
        terminateSession: {
          type: 'boolean',
          description: 'If true, also destroy any persistent tmux/daemon session hosting the task.',
        },
      },
      additionalProperties: false,
    },
  },
]);

/**
 * Stateful MCP request dispatcher backed by `TaskManager`.
 */
export class ReinsMcpServer {
  /**
   * @param {object} [options]
   * @param {TaskManager} [options.taskManager]
   */
  constructor({ taskManager } = {}) {
    this.taskManager = taskManager || new TaskManager();
  }

  /**
   * Handles a single JSON-RPC 2.0 request object and returns a response object
   * (or `null` for notifications).
   *
   * @param {object} msg
   * @returns {Promise<object | null>}
   */
  async handleMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      return null;
    }

    // Notifications have no `id`
    if (msg.id === undefined) {
      return null;
    }

    const { id, method, params = {} } = msg;

    try {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params.protocolVersion || '2024-11-05',
            serverInfo: {
              name: 'reins-mcp',
              version: '0.1.0',
            },
            capabilities: {
              tools: {},
            },
          },
        };
      }

      if (method === 'ping') {
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        };
      }

      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: MCP_TOOLS,
          },
        };
      }

      if (method === 'tools/call') {
        const toolResult = await this.callTool(params.name, params.arguments || {});
        return {
          jsonrpc: '2.0',
          id,
          result: toolResult,
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: err.message || String(err),
        },
      };
    }
  }

  /**
   * Executes one of the 5 Reins MCP tools.
   *
   * @param {string} name
   * @param {object} args
   * @returns {Promise<{ content: Array<{ type: 'text', text: string }>, isError?: boolean }>}
   */
  async callTool(name, args = {}) {
    try {
      if (name === 'reins_targets') {
        const allTargets = this.taskManager.registry.listTargets();
        const targets = args.targetId
          ? allTargets.filter((t) => t.id === args.targetId)
          : allTargets;
        let modelCatalog;
        if (args.targetId || args.includeModels) {
          const modelTargetId = args.targetId || 'local-codex';
          try {
            modelCatalog = await this.taskManager.listModels(modelTargetId);
          } catch (err) {
            modelCatalog = {
              targetId: modelTargetId,
              error: err.message || String(err),
            };
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  targets,
                  ...(modelCatalog ? { modelCatalog } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === 'reins_delegate') {
        const snapshot = await this.taskManager.delegate({
          targetId: args.targetId,
          prompt: args.prompt,
          sessionMode: args.sessionMode,
          preset: args.preset,
          reinPolicy: args.reinPolicy,
          sessionId: args.sessionId,
          cwd: args.cwd,
          project: args.project,
          model: args.model,
          effort: args.effort,
          wait: args.wait ?? true,
          timeoutSec: args.timeoutSec,
          trace: args.trace,
          allowTargetReentry: Boolean(args.allowTargetReentry),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(snapshot, null, 2),
            },
          ],
          isError: snapshot.status === 'failed',
        };
      }

      if (name === 'reins_status') {
        if (args.taskId) {
          const snapshot = this.taskManager.getTask(args.taskId);
          if (!snapshot) {
            throw new Error(`Task "${args.taskId}" not found.`);
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(snapshot, null, 2),
              },
            ],
          };
        }
        const tasks = this.taskManager.listTasks({
          status: args.status,
          targetId: args.targetId,
          limit: args.limit || 20,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ tasks }, null, 2),
            },
          ],
        };
      }

      if (name === 'reins_steer') {
        const snapshot = await this.taskManager.steer(args.taskId, {
          action: args.action,
          message: args.message,
          model: args.model,
          effort: args.effort,
          wait: args.wait ?? true,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(snapshot, null, 2),
            },
          ],
          isError: snapshot.status === 'failed',
        };
      }

      if (name === 'reins_abort') {
        const snapshot = await this.taskManager.abort(args.taskId, {
          terminateSession: Boolean(args.terminateSession),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(snapshot, null, 2),
            },
          ],
        };
      }

      throw new Error(`Unknown Reins MCP tool "${name}".`);
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: err.message || String(err) }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Starts listening on `process.stdin` / `process.stdout` using newline-delimited JSON-RPC 2.0.
   */
  startStdio() {
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Content-Length:')) {
        return;
      }
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      const response = await this.handleMessage(msg);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    });
  }
}

const __filename = fileURLToPath(import.meta.url);
const isDirectMain =
  process.argv[1] && path.resolve(__filename) === path.resolve(process.argv[1]);

if (isDirectMain) {
  const server = new ReinsMcpServer();
  server.startStdio();
}
