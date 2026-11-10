/**
 * SSH subprocess transport for remote newline-delimited JSON-RPC servers.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { JsonRpcStdioTransport, killProcessTree, resolveExecutable } from './local.js';

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

/**
 * Atomic streaming subprocess primitive for local and SSH CLI execution.
 * Spawns a command, streams stdout line-by-line via `onLine`, captures stderr,
 * enforces timeout with whole-process-tree termination, and returns structured
 * diagnostics (`commandLine`, `exitCode`, `stderr`) so the hosting Agent can
 * inspect and adapt to CLI version differences.
 *
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} [options.args=[]]
 * @param {string} [options.harnessKind]
 * @param {string} [options.cwd]
 * @param {Record<string, string>} [options.env={}]
 * @param {object} [options.transportConfig]
 * @param {number} [options.timeoutMs=600000]
 * @param {boolean} [options.closeRemoteStdin=false]
 * @param {(line: string) => void} [options.onLine]
 * @param {object} [options.runtime] - Optional mutable runtime handle (`runtime.child` is populated)
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null, signal: string | null, error: Error | null, timedOut: boolean, commandLine: string }>}
 */
export function runStreamingProcess({
  command,
  args = [],
  harnessKind = 'codex',
  cwd,
  env = {},
  transportConfig,
  timeoutMs = 600000,
  closeRemoteStdin = false,
  onLine,
  runtime,
}) {
  const isSsh = transportConfig?.type === 'ssh' || transportConfig?.kind === 'ssh';
  const executable = isSsh ? 'ssh' : resolveExecutable(command, harnessKind);
  const remoteCmdLine = isSsh
    ? buildPosixCommandLine(command, args, cwd, env, { closeStdin: closeRemoteStdin })
    : null;
  const spawnArgs = isSsh ? ['-n', ...buildSshArgs(transportConfig, remoteCmdLine)] : args;
  const commandLine = isSsh
    ? `ssh ${transportConfig?.host || transportConfig?.sshHost} -- ${remoteCmdLine}`
    : [executable, ...args].join(' ');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, spawnArgs, {
        cwd: isSsh ? process.cwd() : cwd || process.cwd(),
        env: isSsh ? process.env : { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        shell: !isSsh && process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable),
      });
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        error,
        timedOut: false,
        commandLine,
      });
      return;
    }

    if (runtime) runtime.child = child;
    let stdout = '';
    let stderr = '';
    let error = null;
    let timedOut = false;

    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
      stdout += `${line}\n`;
      if (onLine) {
        try {
          onLine(line);
        } catch (caught) {
          error = caught;
          killProcessTree(child).catch(() => {});
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (caught) => {
      error = caught;
    });

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessTree(child).catch(() => {});
          }, timeoutMs)
        : null;

    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      if (runtime?.child === child) runtime.child = null;
      resolve({ stdout, stderr, exitCode, signal, error, timedOut, commandLine });
    });
  });
}
