/**
 * Reins Local Subprocess & JSON-RPC 2.0 Stdio Transport
 *
 * Provides cross-platform executable resolution (including dynamic Windows Appx
 * OpenAI.Codex discovery), whole-process-tree termination, and newline-delimited
 * JSON-RPC 2.0 communication over stdin/stdout.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

let cachedWindowsCodexPath = null;

/**
 * Checks whether a command exists on the system PATH.
 *
 * @param {string} binaryName
 * @returns {string | null}
 */
export function findOnPath(binaryName) {
  if (!binaryName) return null;
  const isWin = process.platform === 'win32';
  const lookupCmd = isWin ? 'where.exe' : 'which';
  const res = spawnSync(lookupCmd, [binaryName], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 4000,
  });
  if (res.status === 0 && res.stdout) {
    const firstLine = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && fs.existsSync(l));
    if (firstLine) {
      return firstLine;
    }
  }
  return null;
}

/**
 * Resolves the OpenAI Codex CLI executable on Windows when installed via Microsoft Store Appx.
 * Dynamically re-queries `Get-AppxPackage OpenAI.Codex` whenever the cached path is missing
 * (for example, after an automatic Microsoft Store package update).
 *
 * @returns {string | null}
 */
export function resolveWindowsAppxCodexPath() {
  if (process.platform !== 'win32') {
    return null;
  }
  if (cachedWindowsCodexPath && fs.existsSync(cachedWindowsCodexPath)) {
    return cachedWindowsCodexPath;
  }

  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    const res = spawnSync(
      shell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 6000,
      },
    );
    if (res.status === 0 && res.stdout) {
      const installLocation = res.stdout.trim();
      if (installLocation) {
        const candidate = path.join(installLocation, 'app', 'resources', 'codex.exe');
        if (fs.existsSync(candidate)) {
          cachedWindowsCodexPath = candidate;
          return candidate;
        }
      }
    }
  }
  return null;
}

/**
 * Resolves a harness executable path across Windows, macOS, and Linux.
 *
 * @param {string} [commandSpec='auto']
 * @param {string} [harnessKind='codex']
 * @returns {string}
 */
export function resolveExecutable(commandSpec = 'auto', harnessKind = 'codex') {
  if (commandSpec && commandSpec !== 'auto' && fs.existsSync(commandSpec)) {
    return commandSpec;
  }

  if (harnessKind === 'antigravity' && ['auto', 'agy', 'agentapi'].includes(commandSpec)) {
    const agentApi = path.join(
      os.homedir(), '.gemini', 'antigravity', 'bin',
      process.platform === 'win32' ? 'agentapi.bat' : 'agentapi',
    );
    if (fs.existsSync(agentApi)) return agentApi;
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
      const languageServer = path.join(
        process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe',
      );
      if (fs.existsSync(languageServer)) return languageServer;
    }
  }

  const defaultBinaryByKind = {
    codex: 'codex',
    'claude-code': 'claude',
    dsh: 'dsh',
    antigravity: 'agy',
  };

  const binaryToFind =
    !commandSpec || commandSpec === 'auto'
      ? defaultBinaryByKind[harnessKind] || 'codex'
      : commandSpec;

  const onPath = findOnPath(binaryToFind);
  if (onPath) {
    return onPath;
  }

  if (harnessKind === 'codex' || binaryToFind === 'codex' || binaryToFind === 'codex.exe') {
    const appxPath = resolveWindowsAppxCodexPath();
    if (appxPath) {
      return appxPath;
    }
  }

  if (process.platform === 'win32' && binaryToFind === 'agy') {
    const candidates = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'Antigravity.exe'),
      path.join(os.homedir(), '.gemini', 'antigravity-cli'),
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  }

  return binaryToFind;
}

/**
 * Terminates a child process and its entire descendant process tree across platforms.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
export async function killProcessTree(child) {
  if (!child || child.exitCode !== null || !child.pid) {
    return;
  }

  const pid = child.pid;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000,
    });
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore if already terminated.
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore if already exited.
    }
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore.
        }
      }
      resolve();
    }, 1000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Bidirectional JSON-RPC 2.0 client over a local subprocess's stdin/stdout streams.
 *
 * Emits:
 * - `'notification'`: `(method: string, params: any) => void`
 * - `'request'`: `(id: string | number, method: string, params: any) => void`
 * - `'stderr'`: `(line: string) => void`
 * - `'exit'`: `(code: number | null, signal: string | null) => void`
 */
export class JsonRpcStdioTransport extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.command
   * @param {string[]} [options.args=[]]
   * @param {string} [options.cwd=process.cwd()]
   * @param {Record<string, string>} [options.env={}]
   */
  constructor({ command, args = [], cwd = process.cwd(), env = {} }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrRing = [];
    this.closed = false;
  }

  /**
   * Spawns the underlying child process and attaches line-delimited JSON-RPC readers.
   */
  start() {
    if (this.child) {
      return;
    }

    const useShell =
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.command);

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
      detached: process.platform !== 'win32',
    });

    const stdoutReader = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    stdoutReader.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this._handleStdoutLine(trimmed);
    });

    const stderrReader = readline.createInterface({
      input: this.child.stderr,
      crlfDelay: Infinity,
    });

    stderrReader.on('line', (line) => {
      this.stderrRing.push(line);
      if (this.stderrRing.length > 50) {
        this.stderrRing.shift();
      }
      this.emit('stderr', line);
    });

    this.child.on('error', (err) => {
      this._rejectAllPending(new Error(`Failed to spawn "${this.command}": ${err.message}`));
      this.emit('error', err);
    });

    this.child.on('exit', (code, signal) => {
      this.closed = true;
      const tailStderr = this.stderrRing.slice(-5).join(' | ');
      const suffix = tailStderr ? ` (stderr: ${tailStderr})` : '';
      this._rejectAllPending(
        new Error(`Process "${path.basename(this.command)}" exited with code=${code} signal=${signal}${suffix}`),
      );
      this.emit('exit', code, signal);
    });
  }

  /**
   * Parses a single newline-delimited JSON-RPC message from stdout.
   *
   * @param {string} line
   */
  _handleStdoutLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('nonJsonLine', line);
      return;
    }

    // Case 1: Response to a client-initiated request
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        const errMessage =
          typeof msg.error === 'object' && msg.error !== null
            ? msg.error.message || JSON.stringify(msg.error)
            : String(msg.error);
        const err = new Error(`JSON-RPC error (${entry.method}): ${errMessage}`);
        err.code = msg.error?.code;
        err.data = msg.error?.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Case 2: Server-to-client request (expects a response with matching `id`)
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.emit('request', msg.id, msg.method, msg.params);
      return;
    }

    // Case 3: Server-to-client notification
    if (typeof msg.method === 'string') {
      this.emit('notification', msg.method, msg.params);
    }
  }

  /**
   * Writes a raw JSON-RPC payload to the child's stdin.
   *
   * @param {object} payload
   */
  _sendRaw(payload) {
    if (!this.child || this.closed || !this.child.stdin.writable) {
      throw new Error('JSON-RPC transport is not writable.');
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * Sends a JSON-RPC request and awaits the matching response.
   *
   * @param {string} method
   * @param {any} [params]
   * @param {number} [timeoutMs=60000]
   * @returns {Promise<any>}
   */
  request(method, params = {}, timeoutMs = 60000) {
    if (!this.child) {
      this.start();
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this._sendRaw({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Sends a JSON-RPC notification (no response expected).
   *
   * @param {string} method
   * @param {any} [params]
   */
  notify(method, params) {
    if (!this.child) {
      this.start();
    }
    const payload = params !== undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method };
    this._sendRaw(payload);
  }

  /**
   * Sends a JSON-RPC response to a server-initiated request.
   *
   * @param {string | number} id
   * @param {any} result
   */
  respond(id, result) {
    this._sendRaw({ jsonrpc: '2.0', id, result });
  }

  /**
   * Sends a JSON-RPC error response to a server-initiated request.
   *
   * @param {string | number} id
   * @param {number} code
   * @param {string} message
   * @param {any} [data]
   */
  respondError(id, code, message, data) {
    this._sendRaw({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  _rejectAllPending(err) {
    for (const [, entry] of this.pending.entries()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Terminates the underlying process tree and cleans up pending requests.
   */
  async close() {
    this.closed = true;
    this._rejectAllPending(new Error('JSON-RPC transport closed by caller.'));
    if (this.child) {
      await killProcessTree(this.child);
    }
  }
}
