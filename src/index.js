#!/usr/bin/env node

/**
 * Reins — H2H (Harness-to-Harness) CLI, Agent Skill & MCP Orchestration Hub
 *
 * Main entry point (`reins` binary and programmatic SDK exports).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli/index.js';

export const VERSION = '0.1.0';

export * from './protocol/schema.js';
export { advanceTraceOrThrow, resolveIncomingTrace } from './hub/loop-guard.js';
export { TargetRegistry, loadConfig, parseSimpleYaml } from './hub/registry.js';
export { TaskManager } from './hub/task-manager.js';
export { ReinsHubServer } from './hub/server.js';
export { ReinsMcpServer, MCP_TOOLS } from './mcp/index.js';
export { CodexAppServerDriver } from './drivers/codex-app-server.js';
export { AntigravityDriver } from './drivers/antigravity-driver.js';
export { DshDriver } from './drivers/dsh-driver.js';
export { ClaudeCodeDriver } from './drivers/claude-code-driver.js';
export {
  buildSshArgs,
  quotePosixShellArg,
  buildPosixCommandLine,
  execRemoteCommand,
  SshStdioTransport,
  createJsonRpcTransport,
} from './transports/ssh.js';

const __filename = fileURLToPath(import.meta.url);
const isDirectMain =
  process.argv[1] && path.resolve(__filename) === path.resolve(process.argv[1]);

if (isDirectMain) {
  runCli(process.argv.slice(2));
}
