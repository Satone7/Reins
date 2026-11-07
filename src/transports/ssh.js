/**
 * SSH subprocess transport for remote newline-delimited JSON-RPC servers.
 */

import { spawn } from 'node:child_process';
import { JsonRpcStdioTransport, killProcessTree } from './local.js';

export function quotePosixShellArg(arg) {
  return `'${String(arg).replaceAll("'", `'"'"'`)}'`;
}

export function buildPosixCommandLine(command, args = [], cwd, envVars = {}, { closeStdin = false } = {}) {
  if (!command || command === 'auto') {
    throw new Error('A remote executable command is required.');
  }

  const parts = [];
  if (cwd) {
    parts.push(`cd ${quotePosixShellArg(cwd)}`);
  }

  const exports = Object.entries(envVars)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid remote environment variable name: ${name}`);
      }
      return `${name}=${quotePosixShellArg(value)}`;
    });
  if (exports.length) {
    parts.push(`export ${exports.join(' ')}`);
  }

  const commandLine = [command, ...args].map(quotePosixShellArg).join(' ');
  parts.push(closeStdin ? `${commandLine} < /dev/null` : commandLine);
  return parts.join(' && ');
}

export function buildSshArgs(transportConfig, remoteCommandString) {
  const host = transportConfig?.host || transportConfig?.sshHost;
  if (!host || typeof host !== 'string' || host.startsWith('-') || /\s/.test(host)) {
    throw new Error('SSH transport requires a valid host.');
  }

  const timeout = transportConfig.connectTimeoutSec ?? 10;
  if (!Number.isInteger(Number(timeout)) || Number(timeout) <= 0) {
    throw new Error('SSH connectTimeoutSec must be a positive integer.');
  }

  const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeout}`];
  if (transportConfig.port !== undefined) {
    const port = Number(transportConfig.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be an integer from 1 to 65535.');
    }
    args.push('-p', String(port));
  }
  if (transportConfig.identityFile) {
    args.push('-i', transportConfig.identityFile);
  }

  const user = transportConfig.user;
  if (user && (typeof user !== 'string' || user.startsWith('-') || /[@\s]/.test(user))) {
    throw new Error('SSH user must be a valid username.');
  }
  args.push(user ? `${user}@${host}` : host, remoteCommandString);
  return args;
}

export function execRemoteCommand(transportConfig, remoteCommand, { timeoutMs = 30000, input } = {}) {
  const args = buildSshArgs(transportConfig, remoteCommand);
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr, exitCode });
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        killProcessTree(child).catch(() => {});
        finish(new Error(`SSH command timed out after ${timeoutMs}ms.`));
      }, timeoutMs)
      : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(null, code));
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') finish(error);
    });
    child.stdin.end(input);
  });
}

export class SshStdioTransport extends JsonRpcStdioTransport {
  constructor({ transportConfig, command, args = [], cwd, env = {} }) {
    const remoteCommand = buildPosixCommandLine(command, args, cwd, env);
    super({ command: 'ssh', args: buildSshArgs(transportConfig, remoteCommand) });
    this.transportConfig = transportConfig;
  }
}

export function createJsonRpcTransport({ transportConfig, command, args, cwd, env }) {
  const options = { transportConfig, command, args, cwd, env };
  return transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh'
    ? new SshStdioTransport(options)
    : new JsonRpcStdioTransport(options);
}
