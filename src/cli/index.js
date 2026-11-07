/**
 * Reins CLI — Northbound Command-Line Interface & Agent Skill Entry Point
 *
 * Provides full H2H Protocol v0.2 parity with `reins-mcp`, supporting:
 * - `reins targets`
 * - `reins delegate <targetId> ...`
 * - `reins status [taskId]`
 * - `reins steer <taskId> <action> [message]`
 * - `reins abort <taskId>`
 * - `reins hub start|status`
 */

import fs from 'node:fs';
import { TaskManager } from '../hub/task-manager.js';
import { ReinsHubServer } from '../hub/server.js';

const VERSION = '0.1.0';

function printHelp() {
  console.log(`Reins v${VERSION} — Take the reins of all your local and remote AI coding harnesses.

Usage:
  reins <command> [options]

Commands:
  targets                           List all registered H2H Harness targets
  models [targetId]                 List selectable models and reasoning efforts for a target (default: local-codex)
  delegate <targetId> [options]     Delegate a task or resume a session on a target Harness
  status [taskId] [options]         Query status/transcript of a task or list recent tasks
  steer <taskId> <action> [msg]     Steer a task (reply | approve | reject | interrupt)
  abort <taskId>                    Abort an active task and terminate its subprocess tree
  hub <start|status>                Manage the local Reins Hub HTTP daemon

Delegate Options:
  -p, --prompt <text>               Prompt text to send to the target Harness
  --prompt-file <path>              Read prompt text from a UTF-8 file
  --prompt-stdin                    Read prompt text from standard input
  --persistent                      Register as a first-class user-resumable session
  --ephemeral                       Run as a burn-after-reading one-shot session
  --preset <name>                   Preset: task | review | adversarial-review | rescue
  --policy <policy>                 Policy: free-rein | auto-edit | parent-rein | tight-rein | plan-only
  --session <sessionId>             Resume an existing native Harness session ID
  --cwd <path>                      Working directory on the target host
  --model <model>                   Override model identifier (e.g. gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna)
  --effort <level>                  Reasoning effort level (low | medium | high | xhigh | max | ultra)
  --wait                            Wait for the turn to complete (default)
  --bg                              Run asynchronously in the background and return taskId immediately
  --timeout <sec>                   Turn timeout in seconds (default: 600)

Global Options:
  --json                            Output canonical JSON (H2HTaskSnapshot) for agent parsing
  --config <path>                   Explicit path to reins.yaml / reins.json
  --state-dir <path>                Override state directory (default: ~/.reins)
  -h, --help                        Show help
  -v, --version                     Show version
`);
}

/**
 * Parses CLI argv into positional arguments and options.
 *
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  const positionals = [];
  const flags = {
    json: false,
    wait: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg === '-v' || arg === '--version') {
      flags.version = true;
    } else if (arg === '--persistent') {
      flags.sessionMode = 'persistent';
    } else if (arg === '--ephemeral') {
      flags.sessionMode = 'ephemeral';
    } else if (arg === '--wait') {
      flags.wait = true;
    } else if (arg === '--bg' || arg === '--no-wait') {
      flags.wait = false;
    } else if (arg === '--prompt-stdin') {
      flags.promptStdin = true;
    } else if (arg === '-p' || arg === '--prompt') {
      flags.prompt = argv[++i];
    } else if (arg === '--prompt-file') {
      flags.promptFile = argv[++i];
    } else if (arg === '--preset') {
      flags.preset = argv[++i];
    } else if (arg === '--policy') {
      flags.policy = argv[++i];
    } else if (arg === '--session') {
      flags.session = argv[++i];
    } else if (arg === '--cwd') {
      flags.cwd = argv[++i];
    } else if (arg === '--model') {
      flags.model = argv[++i];
    } else if (arg === '--effort' || arg === '--reasoning-effort') {
      flags.effort = argv[++i];
    } else if (arg === '--timeout') {
      flags.timeout = Number.parseInt(argv[++i], 10);
    } else if (arg === '--status') {
      flags.statusFilter = argv[++i];
    } else if (arg === '--target') {
      flags.targetFilter = argv[++i];
    } else if (arg === '--limit') {
      flags.limit = Number.parseInt(argv[++i], 10);
    } else if (arg === '--config') {
      flags.config = argv[++i];
    } else if (arg === '--state-dir') {
      flags.stateDir = argv[++i];
    } else if (arg === '--allow-reentry') {
      flags.allowReentry = true;
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function printSnapshotHuman(snapshot) {
  console.log(snapshot.diagnostic);
  if (snapshot.resumeCommandHint) {
    console.log(`Resume Command : ${snapshot.resumeCommandHint}`);
  }
  if (snapshot.attention) {
    console.log(`Attention Req  : [${snapshot.attention.method}] ${snapshot.attention.summary}`);
  }
  if (snapshot.error) {
    console.error(`Error          : ${snapshot.error}`);
  }
  if (snapshot.output) {
    console.log('\n--- Output ---');
    console.log(snapshot.output);
  }
}

export async function runCli(argv) {
  const { positionals, flags } = parseCliArgs(argv);
  const command = positionals[0];

  if (flags.version || command === 'version') {
    console.log(VERSION);
    return;
  }

  if (flags.help || !command || command === 'help') {
    printHelp();
    return;
  }

  const taskManager = new TaskManager({
    stateDir: flags.stateDir,
  });

  try {
    if (command === '_worker') {
      const taskId = positionals[1];
      await taskManager.runDetachedWorkerTask(taskId);
      return;
    }

    if (command === 'targets') {
      const targets = taskManager.registry.listTargets();
      if (flags.json) {
        console.log(JSON.stringify({ targets }, null, 2));
      } else {
        console.log(`Registered H2H Targets (${targets.length}):\n`);
        for (const t of targets) {
          const availTag = t.available ? 'READY' : 'UNVERIFIED';
          const transportDesc =
            t.transport?.type === 'ssh' ? `ssh://${t.transport.host}` : 'local';
          console.log(
            `  - ${t.id.padEnd(14)} [${t.kind.padEnd(11)}] (${transportDesc}, mode=${t.defaultSessionMode}, policy=${t.defaultPolicy}, ${availTag})`,
          );
          if (t.description) {
            console.log(`      ${t.description}`);
          }
        }
      }
      return;
    }

    if (command === 'models') {
      const targetId = positionals[1] || 'local-codex';
      const catalog = await taskManager.listModels(targetId);
      if (flags.json) {
        console.log(JSON.stringify(catalog, null, 2));
      } else {
        console.log(
          `Selectable Models for ${catalog.targetId} (${catalog.kind}):`,
        );
        if (catalog.currentConfig?.model || catalog.currentConfig?.effort) {
          console.log(
            `  Current Default : model=${catalog.currentConfig.model || '(default)'}, effort=${catalog.currentConfig.effort || '(default)'}${catalog.currentConfig.provider ? `, provider=${catalog.currentConfig.provider}` : ''}`,
          );
        }
        console.log('');
        if (!catalog.models || catalog.models.length === 0) {
          console.log('  (No dynamic model catalog reported by this target driver)');
        } else {
          for (const m of catalog.models) {
            const defaultTag = m.isDefault ? ' [catalog-default]' : '';
            const activeTag =
              catalog.currentConfig?.model && catalog.currentConfig.model === m.id
                ? ' [configured-default]'
                : '';
            const effortsStr =
              Array.isArray(m.supportedEfforts) && m.supportedEfforts.length > 0
                ? m.supportedEfforts.join(' | ')
                : 'default';
            console.log(
              `  - ${m.id.padEnd(16)} (${m.displayName})${defaultTag}${activeTag}`,
            );
            console.log(
              `      efforts: [${effortsStr}] (default effort: ${m.defaultEffort || 'default'})`,
            );
            if (m.description) {
              console.log(`      ${m.description}`);
            }
          }
        }
      }
      return;
    }

    if (command === 'delegate') {
      const targetId = positionals[1];
      if (!targetId) {
        throw new Error('Usage: reins delegate <targetId> -p "<prompt>" [options]');
      }

      let prompt = flags.prompt;
      if (!prompt && flags.promptFile) {
        prompt = fs.readFileSync(flags.promptFile, 'utf8');
      }
      if (!prompt && flags.promptStdin) {
        prompt = await readStdinText();
      }
      if (!prompt && positionals.length > 2) {
        prompt = positionals.slice(2).join(' ');
      }
      if (!prompt || !String(prompt).trim()) {
        throw new Error('A non-empty prompt is required (-p "<text>", --prompt-file <path>, or --prompt-stdin).');
      }

      const snapshot = await taskManager.delegate({
        targetId,
        prompt,
        sessionMode: flags.sessionMode,
        preset: flags.preset,
        reinPolicy: flags.policy,
        sessionId: flags.session,
        cwd: flags.cwd,
        model: flags.model,
        effort: flags.effort,
        wait: flags.wait,
        detachWorker: !flags.wait,
        timeoutSec: flags.timeout,
        allowTargetReentry: Boolean(flags.allowReentry),
      });

      if (flags.json) {
        console.log(JSON.stringify(snapshot, null, 2));
      } else {
        printSnapshotHuman(snapshot);
      }

      if (snapshot.status === 'failed' || snapshot.status === 'aborted') {
        process.exitCode = 1;
      }
      return;
    }

    if (command === 'status') {
      const taskId = positionals[1];
      if (taskId) {
        const snapshot = taskManager.getTask(taskId);
        if (!snapshot) {
          throw new Error(`Task "${taskId}" not found.`);
        }
        if (flags.json) {
          console.log(JSON.stringify(snapshot, null, 2));
        } else {
          printSnapshotHuman(snapshot);
        }
        return;
      }

      const tasks = taskManager.listTasks({
        status: flags.statusFilter,
        targetId: flags.targetFilter,
        limit: flags.limit || 20,
      });

      if (flags.json) {
        console.log(JSON.stringify({ tasks }, null, 2));
      } else if (tasks.length === 0) {
        console.log('No delegated H2H tasks recorded yet.');
      } else {
        for (const t of tasks) {
          console.log(t.diagnostic);
        }
      }
      return;
    }

    if (command === 'steer') {
      const taskId = positionals[1];
      const action = positionals[2];
      let message = flags.prompt;
      if (!message && flags.promptFile) {
        message = fs.readFileSync(flags.promptFile, 'utf8');
      }
      if (!message && flags.promptStdin) {
        message = await readStdinText();
      }
      if (!message && positionals.length > 3) {
        message = positionals.slice(3).join(' ');
      }

      if (!taskId || !action) {
        throw new Error('Usage: reins steer <taskId> <reply|approve|reject|interrupt> [message]');
      }

      const snapshot = await taskManager.steer(taskId, {
        action,
        message,
        model: flags.model,
        effort: flags.effort,
        wait: flags.wait,
      });

      if (flags.json) {
        console.log(JSON.stringify(snapshot, null, 2));
      } else {
        printSnapshotHuman(snapshot);
      }
      return;
    }

    if (command === 'abort') {
      const taskId = positionals[1];
      if (!taskId) {
        throw new Error('Usage: reins abort <taskId>');
      }
      const snapshot = await taskManager.abort(taskId);
      if (flags.json) {
        console.log(JSON.stringify(snapshot, null, 2));
      } else {
        printSnapshotHuman(snapshot);
      }
      return;
    }

    if (command === 'hub') {
      const sub = positionals[1] || 'status';
      if (sub === 'start') {
        const server = new ReinsHubServer({ taskManager });
        const { host, port } = await server.start();
        console.log(`Reins Hub daemon listening on http://${host}:${port}`);
        return;
      }
      if (sub === 'status') {
        const info = {
          stateDir: taskManager.stateDir,
          configSource: taskManager.registry.configSource,
          targetsCount: taskManager.registry.listTargets().length,
          recentTasksCount: taskManager.listTasks({ limit: 100 }).length,
        };
        if (flags.json) {
          console.log(JSON.stringify(info, null, 2));
        } else {
          console.log(`Reins Hub Status:`);
          console.log(`  State Dir     : ${info.stateDir}`);
          console.log(`  Config Source : ${info.configSource}`);
          console.log(`  Targets       : ${info.targetsCount}`);
          console.log(`  Stored Tasks  : ${info.recentTasksCount}`);
        }
        return;
      }
    }

    throw new Error(`Unknown command "${command}". Run "reins --help" for usage.`);
  } catch (err) {
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            error: err.message || String(err),
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`[Reins Error] ${err.message || err}`);
    }
    process.exitCode = 1;
  }
}
