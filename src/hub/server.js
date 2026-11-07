/**
 * Reins Hub Local HTTP Daemon (`127.0.0.1:19420`)
 *
 * Exposes a lightweight REST/JSON interface over `TaskManager` and `TargetRegistry`
 * so long-running interactive sessions, CLI commands, and Web/PWA dashboards can
 * share a single stateful daemon when desired.
 */

import http from 'node:http';
import { TaskManager } from './task-manager.js';

export class ReinsHubServer {
  /**
   * @param {object} [options]
   * @param {TaskManager} [options.taskManager]
   * @param {string} [options.host='127.0.0.1']
   * @param {number} [options.port=19420]
   */
  constructor({ taskManager, host, port } = {}) {
    this.taskManager = taskManager || new TaskManager();
    const hubCfg = this.taskManager.registry.config?.hub || {};
    this.host = host || hubCfg.host || '127.0.0.1';
    this.port = port ?? hubCfg.port ?? 19420;
    this.server = null;
  }

  /**
   * Starts listening on `host:port`.
   *
   * @returns {Promise<{ host: string, port: number }>}
   */
  async start() {
    if (this.server) {
      return { host: this.host, port: this.port };
    }

    this.server = http.createServer(async (req, res) => {
      try {
        await this._handleRequest(req, res);
      } catch (err) {
        this._sendJson(res, 500, {
          error: err.message || String(err),
        });
      }
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
    });

    return { host: this.host, port: this.port };
  }

  /**
   * Stops the HTTP server.
   */
  async stop() {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise((resolve) => srv.close(() => resolve()));
  }

  _sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  async _readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  }

  async _handleRequest(req, res) {
    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      this._sendJson(res, 200, {
        status: 'ok',
        pid: process.pid,
        host: this.host,
        port: this.port,
        stateDir: this.taskManager.stateDir,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/targets') {
      this._sendJson(res, 200, {
        targets: this.taskManager.registry.listTargets(),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/tasks') {
      const status = url.searchParams.get('status') || undefined;
      const targetId = url.searchParams.get('targetId') || undefined;
      const limit = Number.parseInt(url.searchParams.get('limit') || '20', 10);
      this._sendJson(res, 200, {
        tasks: this.taskManager.listTasks({ status, targetId, limit }),
      });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/tasks/')) {
      const taskId = pathname.slice('/tasks/'.length);
      const snapshot = this.taskManager.getTask(taskId);
      if (!snapshot) {
        this._sendJson(res, 404, { error: `Task "${taskId}" not found.` });
        return;
      }
      this._sendJson(res, 200, snapshot);
      return;
    }

    if (req.method === 'POST' && pathname === '/delegate') {
      const body = await this._readJsonBody(req);
      const snapshot = await this.taskManager.delegate(body);
      this._sendJson(res, 200, snapshot);
      return;
    }

    if (req.method === 'POST' && pathname.endsWith('/steer') && pathname.startsWith('/tasks/')) {
      const taskId = pathname.slice('/tasks/'.length, -'/steer'.length);
      const body = await this._readJsonBody(req);
      const snapshot = await this.taskManager.steer(taskId, body);
      this._sendJson(res, 200, snapshot);
      return;
    }

    if (req.method === 'POST' && pathname.endsWith('/abort') && pathname.startsWith('/tasks/')) {
      const taskId = pathname.slice('/tasks/'.length, -'/abort'.length);
      const snapshot = await this.taskManager.abort(taskId);
      this._sendJson(res, 200, snapshot);
      return;
    }

    this._sendJson(res, 404, { error: `Route not found: ${req.method} ${pathname}` });
  }
}
