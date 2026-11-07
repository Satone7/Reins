#!/usr/bin/env node

/**
 * Reins Northbound CLI Entry Point (`reins <subcommand>`)
 * Isomorphic to the MCP Server (`src/mcp/index.js`) and backed by `skills/reins/SKILL.md`.
 *
 * Subcommands:
 *   - reins targets [--tag <tag>] [--no-sessions] [--json]
 *   - reins delegate <target> [-p <prompt> | -f <file> | --prompt-stdin] [--preset <p>] [--wait <sec>] [--bg] [--json]
 *   - reins status [taskId] [--all] [--wait <sec>] [--since-seq <n>] [--pane] [--json]
 *   - reins steer <taskId> <approve|approve_session|deny|reply> [-m <msg> | -f <file> | --message-stdin] [--wait <sec>] [--json]
 *   - reins abort <taskId> [--kill] [--json]
 *   - reins hub <start|status|stop> [--json]
 */

export async function runCli(argv = process.argv.slice(2)) {
  // Milestone 1 implementation target
  return { argv };
}
