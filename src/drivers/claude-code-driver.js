/**
 * Claude Code interactive `claude-tmux` Southbound Driver.
 *
 * Strictly drives Claude Code interactively inside a detached `tmux` session using:
 * - `--session-id <uuid>` (new sessions) / `--resume <uuid>` (existing sessions)
 * - `tmux load-buffer` + `tmux paste-buffer -p` (bracketed paste) + `tmux send-keys Enter`
 * - `~/.claude/projects/<slug>/<sessionId>.jsonl` transcript tailing & structured folding
 * - `tmux capture-pane -p` for readiness, busy-state, and interactive permission dialog detection
 * - `Enter` / `Escape` keystrokes for live approval, rejection, and turn interruption
 *
 * IMPORTANT: `claude -p` (`--print`) and `--output-format stream-json` are strictly forbidden
 * and never used by this driver.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPresetPrompt,
  buildResumeCommandHint,
  formatDiagnosticSummary,
} from '../protocol/schema.js';
import { resolveExecutable } from '../transports/local.js';
import {
  buildPosixCommandLine,
  execRemoteCommand,
  quotePosixShellArg,
  runStreamingProcess,
} from '../transports/ssh.js';

const PERMISSION_MODES = {
  'free-rein': 'bypassPermissions',
  'auto-edit': 'acceptEdits',
  'plan-only': 'plan',
  'parent-rein': 'default',
  'tight-rein': 'default',
};

/**
 * Strips any forbidden headless/print flags (`-p`, `--print`, `--output-format`,
 * `--no-session-persistence`) so Claude Code is always launched interactively.
 *
 * @param {string[]} [rawArgs=[]]
 * @returns {string[]}
 */
export function sanitizeClaudeArgs(rawArgs = []) {
  if (!Array.isArray(rawArgs)) return [];
  const cleaned = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === '-p' || arg === '--print' || arg === '--no-session-persistence') {
      continue;
    }
    if (arg === '--output-format') {
      if (i + 1 < rawArgs.length && !String(rawArgs[i + 1]).startsWith('-')) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--output-format=')) {
      continue;
    }
    cleaned.push(arg);
  }
  return cleaned;
}

/**
 * Converts a workspace path into Claude Code's project directory slug.
 * Claude Code replaces every non-alphanumeric character with `-`.
 *
 * @param {string} workdir
 * @returns {string}
 */
export function projectSlug(workdir) {
  return String(workdir || '').replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Strips ANSI escape sequences from captured terminal lines.
 *
 * @param {string} [text='']
 * @returns {string}
 */
export function stripAnsi(text = '') {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

/**
 * Detects whether a captured `tmux` pane shows Claude Code's interactive ready prompt.
 *
 * @param {string[]} [lines=[]]
 * @returns {boolean}
 */
export function claudePaneLooksReady(lines = []) {
  const text = lines.map((line) => stripAnsi(line)).join('\n');
  return (
    (/Claude Code v/i.test(text) && /❯/.test(text)) ||
    (/❯/.test(text) &&
      /mode on|Ctx:|agents|permissions on|shift\+tab|bypass|\/effort|manual mode/i.test(text))
  );
}

/**
 * Heuristic check for whether the Claude Code TUI pane is actively executing or streaming.
 *
 * @param {string[]} [lines=[]]
 * @returns {boolean}
 */
export function claudePaneLooksBusy(lines = []) {
  const cleaned = lines
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);
  const tail = cleaned.slice(-12).join('\n');
  return /esc to interrupt|ctrl\+c to interrupt|thinking|running|working|reading|writing|searching|executing|✢|✻|✽|✶|✳|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/i.test(
    tail,
  );
}

/**
 * Inspects captured `tmux` pane lines for blocking interactive dialogs
 * (`permission`, `trust`, `login`, or `dead` pane).
 *
 * @param {string[]} [lines=[]]
 * @param {boolean} [dead=false]
 * @returns {{ kind: string, summary: string, detail: string, options: string[] } | null}
 */
export function detectClaudeAttention(lines = [], dead = false) {
  const cleaned = lines
    .map((line) => stripAnsi(line).trimEnd())
    .filter((line) => line.trim().length > 0);
  const tailLines = cleaned.slice(-28);
  const tail = tailLines.join('\n');

  if (dead || /Pane is dead \(status/i.test(tail)) {
    return {
      kind: 'dead',
      summary: 'Claude Code tmux pane exited unexpectedly',
      detail: tailLines.slice(-10).join('\n') || 'The tmux pane is no longer running.',
      options: [],
    };
  }

  if (
    /Select login method|Choose the text style|Claude account with subscription|Anthropic Console account/i.test(
      tail,
    )
  ) {
    return {
      kind: 'login',
      summary: 'Claude Code requires interactive login or onboarding',
      detail: tailLines.slice(-12).join('\n'),
      options: [],
    };
  }

  if (/do you trust the files in this folder|trust this folder|quick safety check/i.test(tail)) {
    const options = tailLines
      .filter((line) => /^\s*(❯\s*)?\d[.)]\s+/.test(line))
      .map((line) => line.trim());
    return {
      kind: 'trust',
      summary: 'Claude Code is asking to trust the workspace folder',
      detail: tailLines.slice(-12).join('\n'),
      options,
    };
  }

  const hasChoiceList =
    /^\s*(❯\s*)?\d[.)]\s+\S/m.test(tail) ||
    /esc to cancel|Tab to amend|enter to confirm/i.test(tail);
  const hasPermissionCue =
    /do you want to (proceed|allow|make this edit|run|create|use)|yes, and don'?t ask again|allow once|allow always|permission to (use|run|access)|requires? (your )?approval|would you like to proceed/i.test(
      tail,
    );

  if (hasChoiceList && hasPermissionCue) {
    const options = tailLines
      .filter((line) => /^\s*(❯\s*)?\d[.)]\s+/.test(line))
      .map((line) => line.trim());
    return {
      kind: 'permission',
      summary: 'Claude Code is waiting for tool permission approval',
      detail: tailLines.slice(-14).join('\n'),
      options,
    };
  }

  return null;
}

/**
 * Resolves the local Claude Code configuration root (`~/.claude` or `CLAUDE_CONFIG_DIR`).
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {string}
 */
export function resolveLocalClaudeConfigDir(env = process.env) {
  if (env?.CLAUDE_CONFIG_DIR) {
    return env.CLAUDE_CONFIG_DIR;
  }
  const home = env?.HOME || env?.USERPROFILE || os.homedir();
  return path.join(home, '.claude');
}

/**
 * Resolves the local transcript `.jsonl` path for a given workspace and session ID,
 * with fallback discovery across `~/.claude/projects/<slug>/<sessionId>.jsonl`.
 *
 * @param {string} workdir
 * @param {string} sessionId
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {string}
 */
export function resolveLocalTranscriptPath(workdir, sessionId, env = process.env) {
  const claudeDir = resolveLocalClaudeConfigDir(env);
  const expected = path.join(claudeDir, 'projects', projectSlug(workdir), `${sessionId}.jsonl`);
  if (fs.existsSync(expected)) {
    return expected;
  }
  const projectsDir = path.join(claudeDir, 'projects');
  if (fs.existsSync(projectsDir)) {
    try {
      for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
      // Ignore permission/read errors during fallback scan.
    }
  }
  return expected;
}

function extractUserText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text') return block.text || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractToolResultText(block) {
  const content = block?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === 'string' ? item : item?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Creates a mutable accumulator for folding Claude Code `.jsonl` transcript lines.
 *
 * @param {string | null} [sessionId=null]
 * @returns {object}
 */
export function createClaudeTranscriptState(sessionId = null) {
  return {
    sessionId,
    cwd: null,
    gitBranch: null,
    model: null,
    seenUuids: new Set(),
    turn: {
      turnCount: 0,
      open: false,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      interrupted: false,
    },
    turnOutput: '',
    turnCommentary: [],
    turnCostUsd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    },
    toolsById: new Map(),
  };
}

/**
 * Folds a single Claude Code `.jsonl` transcript line into `state` and returns
 * normalized events emitted by that record.
 *
 * @param {object} state
 * @param {string} rawLine
 * @param {number} [now=Date.now()]
 * @returns {{ state: object, events: Array<object> }}
 */
export function foldClaudeTranscriptLine(state, rawLine, now = Date.now()) {
  const events = [];
  if (!rawLine || !String(rawLine).trim()) {
    return { state, events };
  }

  let record;
  try {
    record = JSON.parse(rawLine);
  } catch {
    return { state, events };
  }

  const recordType = record?.type;
  if (recordType !== 'user' && recordType !== 'assistant' && recordType !== 'system') {
    return { state, events };
  }

  if (record.uuid) {
    if (state.seenUuids.has(record.uuid)) {
      return { state, events };
    }
    state.seenUuids.add(record.uuid);
  }

  const ts = record.timestamp ? Date.parse(record.timestamp) || now : now;
  if (record.sessionId) state.sessionId = record.sessionId;
  if (record.session_id) state.sessionId = record.session_id;
  if (record.cwd) state.cwd = record.cwd;
  if (record.gitBranch) state.gitBranch = record.gitBranch;

  const recordCost =
    record.costUSD ?? record.total_cost_usd ?? record.message?.costUSD ?? null;
  if (Number.isFinite(recordCost)) {
    state.turnCostUsd += Number(recordCost);
  }

  if (recordType === 'user') {
    const content = record.message?.content;
    let hasToolResult = false;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_result' && block.tool_use_id) {
          hasToolResult = true;
          const resultText = extractToolResultText(block);
          const isInterruptedResult = /^\[Request interrupted by user\b/i.test(
            resultText.trim(),
          );
          const existing = state.toolsById.get(block.tool_use_id) || {
            id: block.tool_use_id,
            name: 'tool',
          };
          existing.status = isInterruptedResult
            ? 'interrupted'
            : block.is_error
              ? 'error'
              : 'completed';
          existing.output = resultText;
          state.toolsById.set(block.tool_use_id, existing);
          events.push({ type: 'tool_result', tool: { ...existing } });
        }
      }
    }

    const text = extractUserText(record.message);
    const isInterruptText = /^\[Request interrupted by user\b/i.test(text.trim());
    if (isInterruptText) {
      for (const tool of state.toolsById.values()) {
        if (tool.status === 'running') {
          tool.status = 'interrupted';
        }
      }
      if (state.turn.open) {
        state.turn.open = false;
        state.turn.completedAt = ts;
        state.turn.interrupted = true;
      }
      events.push({ type: 'turn_interrupted', reason: text.trim(), timestamp: ts });
    } else if (!hasToolResult && (record.origin?.kind === 'human' || text.trim())) {
      state.turn.turnCount += 1;
      state.turn.open = true;
      state.turn.startedAt = ts;
      state.turn.completedAt = null;
      state.turn.durationMs = null;
      state.turn.interrupted = false;
      state.turnOutput = '';
      state.turnCommentary = [];
      events.push({ type: 'turn_open', text: text.trim(), timestamp: ts });
    }
    return { state, events };
  }

  if (recordType === 'assistant') {
    const msg = record.message || {};
    if (msg.model) {
      state.model = msg.model;
    }
    if (msg.usage && typeof msg.usage === 'object') {
      if (Number.isFinite(msg.usage.input_tokens)) {
        state.usage.inputTokens += msg.usage.input_tokens;
      }
      if (Number.isFinite(msg.usage.output_tokens)) {
        state.usage.outputTokens += msg.usage.output_tokens;
      }
      if (Number.isFinite(msg.usage.cache_read_input_tokens)) {
        state.usage.cacheReadTokens += msg.usage.cache_read_input_tokens;
      }
    }

    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking' && block.thinking) {
        const thought = String(block.thinking).trim();
        if (thought) {
          state.turnCommentary.push(thought);
          events.push({ type: 'thinking', text: thought });
        }
      } else if (block.type === 'text' && block.text) {
        state.turnOutput = state.turnOutput
          ? `${state.turnOutput}\n${block.text}`
          : String(block.text);
        events.push({ type: 'text', text: String(block.text) });
      } else if (block.type === 'tool_use') {
        const toolEntry = {
          id: block.id || `tool_${ state.toolsById.size + 1 }`,
          name: block.name || 'tool',
          input: block.input || {},
          status: 'running',
        };
        state.toolsById.set(toolEntry.id, toolEntry);
        events.push({ type: 'tool_use', toolCall: block, tool: { ...toolEntry } });
      }
    }
    return { state, events };
  }

  if (recordType === 'system' && record.subtype === 'turn_duration') {
    state.turn.open = false;
    state.turn.completedAt = ts;
    const duration = record.durationMs ?? record.duration_ms ?? null;
    if (Number.isFinite(duration)) {
      state.turn.durationMs = Number(duration);
    }
    events.push({
      type: 'turn_close',
      durationMs: state.turn.durationMs,
      timestamp: ts,
    });
  }

  return { state, events };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ClaudeCodeDriver {
  constructor(targetConfig = {}) {
    this.targetConfig = targetConfig;
    this.activeSessions = new Map();
    this.tmuxSessions = new Map();
  }

  async listModels() {
    return {
      targetId: this.targetConfig.id || 'claude-code',
      kind: 'claude-code',
      currentConfig: {
        model: this.targetConfig.model || null,
        effort: this.targetConfig.effort || null,
        provider: 'anthropic',
      },
      models: [
        {
          id: 'sonnet',
          model: 'sonnet',
          displayName: 'Claude Sonnet',
          description: 'Balanced intelligence and speed for everyday coding tasks.',
          isDefault: true,
          defaultEffort: 'medium',
          supportedEfforts: ['low', 'medium', 'high', 'max'],
          inputModalities: ['text', 'image'],
        },
        {
          id: 'opus',
          model: 'opus',
          displayName: 'Claude Opus',
          description: 'Frontier model for complex architecture and deep reasoning.',
          isDefault: false,
          defaultEffort: 'high',
          supportedEfforts: ['low', 'medium', 'high', 'max'],
          inputModalities: ['text', 'image'],
        },
        {
          id: 'haiku',
          model: 'haiku',
          displayName: 'Claude Haiku',
          description: 'Fast and lightweight model for quick tasks.',
          isDefault: false,
          defaultEffort: 'low',
          supportedEfforts: ['low', 'medium', 'high'],
          inputModalities: ['text', 'image'],
        },
      ],
    };
  }

  _transportConfig() {
    return this.targetConfig.transport;
  }

  _isSsh() {
    const t = this._transportConfig();
    return t?.type === 'ssh' || t?.kind === 'ssh';
  }

  _claudeCommand() {
    const configured = this.targetConfig.command || 'auto';
    return this._isSsh()
      ? configured === 'auto'
        ? 'claude'
        : configured
      : resolveExecutable(configured, 'claude-code');
  }

  _tmuxSessionName(snapshot) {
    const shortId = String(snapshot.sessionId || snapshot.taskId)
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 8);
    const prefix =
      this.targetConfig.tmuxPrefix ||
      this.targetConfig.driver?.tmuxPrefix ||
      'reins-cc';
    const name =
      snapshot.tmuxSession ||
      this.targetConfig.tmuxSession ||
      this.targetConfig.driver?.tmuxSession ||
      `${prefix}-${shortId}`;
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error(`Invalid tmux session name: ${name}`);
    }
    return name;
  }

  async _tmux(args, snapshot, env = {}) {
    const command = this.targetConfig.tmuxCommand || 'tmux';
    const prefixArgs = Array.isArray(this.targetConfig.tmuxArgs) ? this.targetConfig.tmuxArgs : [];
    return runStreamingProcess({
      command,
      args: [...prefixArgs, ...args],
      harnessKind: 'claude-code',
      cwd: snapshot.cwd,
      env: { ...(this.targetConfig.env || {}), ...env },
      transportConfig: this._transportConfig(),
      timeoutMs: 15000,
    });
  }

  async _transcriptExists(snapshot, sessionId, env = {}) {
    if (!sessionId) return false;
    if (!this._isSsh()) {
      const mergedEnv = { ...process.env, ...(this.targetConfig.env || {}), ...env };
      const localPath = resolveLocalTranscriptPath(snapshot.cwd || process.cwd(), sessionId, mergedEnv);
      return fs.existsSync(localPath);
    }
    const slug = projectSlug(snapshot.cwd || '/workspace');
    const script = [
      'claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
      `expected="$claude_dir/projects/${slug}/${sessionId}.jsonl"`,
      'if [ -f "$expected" ]; then exit 0; fi',
      `found=$(find "$claude_dir/projects" -name ${quotePosixShellArg(`${sessionId}.jsonl`)} -print -quit 2>/dev/null || true)`,
      '[ -n "$found" ]',
    ].join('; ');
    try {
      const res = await execRemoteCommand(this._transportConfig(), script, { timeoutMs: 8000 });
      return res.exitCode === 0;
    } catch {
      return false;
    }
  }

  async _readTranscriptLines(snapshot, sessionId, env = {}) {
    if (!sessionId) return [];
    if (!this._isSsh()) {
      const mergedEnv = { ...process.env, ...(this.targetConfig.env || {}), ...env };
      const localPath = resolveLocalTranscriptPath(snapshot.cwd || process.cwd(), sessionId, mergedEnv);
      if (!fs.existsSync(localPath)) return [];
      try {
        const raw = fs.readFileSync(localPath, 'utf8');
        return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      } catch {
        return [];
      }
    }

    const slug = projectSlug(snapshot.cwd || '/workspace');
    const script = [
      'claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
      `tpath="$claude_dir/projects/${slug}/${sessionId}.jsonl"`,
      'if [ ! -f "$tpath" ] && [ -d "$claude_dir/projects" ]; then',
      `  found=$(find "$claude_dir/projects" -name ${quotePosixShellArg(`${sessionId}.jsonl`)} -print -quit 2>/dev/null || true)`,
      '  if [ -n "$found" ]; then tpath="$found"; fi',
      'fi',
      'if [ -f "$tpath" ]; then cat "$tpath"; fi',
    ].join('\n');
    try {
      const res = await execRemoteCommand(this._transportConfig(), script, { timeoutMs: 10000 });
      if (res.exitCode !== 0 || !res.stdout) return [];
      return res.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    } catch {
      return [];
    }
  }

  async _removeTranscript(snapshot, sessionId, env = {}) {
    if (!sessionId) return;
    if (!this._isSsh()) {
      const mergedEnv = { ...process.env, ...(this.targetConfig.env || {}), ...env };
      const localPath = resolveLocalTranscriptPath(snapshot.cwd || process.cwd(), sessionId, mergedEnv);
      try {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      } catch {
        // Ignore cleanup errors.
      }
      return;
    }
    const slug = projectSlug(snapshot.cwd || '/workspace');
    const script = [
      'claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
      `rm -f "$claude_dir/projects/${slug}/${sessionId}.jsonl"`,
    ].join('; ');
    try {
      await execRemoteCommand(this._transportConfig(), script, { timeoutMs: 6000 });
    } catch {
      // Ignore cleanup errors.
    }
  }

  async _capturePaneLines(tmuxName, snapshot, env = {}) {
    const res = await this._tmux(
      ['capture-pane', '-p', '-S', '-120', '-t', `=${tmuxName}`],
      snapshot,
      env,
    );
    if (res.error || res.timedOut || res.exitCode !== 0) {
      return {
        ok: false,
        lines: [],
        dead: /noServer|can't find|no current target|not found/i.test(res.stderr || ''),
        stderr: res.stderr || res.error?.message || '',
      };
    }
    const lines = String(res.stdout || '').split(/\r?\n/);
    const dead = lines.some((l) => /Pane is dead \(status/i.test(stripAnsi(l)));
    return { ok: true, lines, dead, stderr: '' };
  }

  async _ensureInteractiveTmuxSession(snapshot, env, { hadPriorSessionId, runtime }) {
    const tmuxName = this._tmuxSessionName(snapshot);
    const existing = await this._tmux(['has-session', '-t', `=${tmuxName}`], snapshot, env);
    if (existing.error || existing.timedOut || (existing.exitCode !== 0 && existing.exitCode !== 1)) {
      throw new Error(
        existing.error?.message ||
          existing.stderr?.trim() ||
          `Unable to inspect tmux session "${tmuxName}".`,
      );
    }

    if (existing.exitCode === 1) {
      const hasTranscript = await this._transcriptExists(snapshot, snapshot.sessionId, env);
      const useResume = Boolean(hadPriorSessionId || hasTranscript);
      const baseArgs = sanitizeClaudeArgs(this.targetConfig.args || []);
      const claudeArgs = [
        ...baseArgs,
        useResume ? '--resume' : '--session-id',
        snapshot.sessionId,
      ];
      const effectiveModel = snapshot.model || this.targetConfig.model;
      const effectiveEffort = snapshot.effort || this.targetConfig.effort;
      if (effectiveModel && !claudeArgs.includes('--model')) {
        claudeArgs.push('--model', effectiveModel);
      }
      if (effectiveEffort && !claudeArgs.includes('--effort')) {
        claudeArgs.push('--effort', effectiveEffort);
      }
      if (!claudeArgs.includes('--permission-mode')) {
        claudeArgs.push('--permission-mode', PERMISSION_MODES[snapshot.reinPolicy] || 'default');
      }

      const cols = String(
        this.targetConfig.paneCols || this.targetConfig.driver?.paneCols || 140,
      );
      const rows = String(
        this.targetConfig.paneRows || this.targetConfig.driver?.paneRows || 45,
      );
      const claudeCommand = buildPosixCommandLine(
        this._claudeCommand(),
        claudeArgs,
        undefined,
        env,
      );
      const created = await this._tmux(
        [
          'new-session',
          '-d',
          '-s',
          tmuxName,
          '-c',
          snapshot.cwd || process.cwd(),
          '-x',
          cols,
          '-y',
          rows,
          claudeCommand,
        ],
        snapshot,
        env,
      );
      if (created.error || created.timedOut || created.exitCode !== 0) {
        throw new Error(
          created.error?.message ||
            created.stderr?.trim() ||
            `Unable to create interactive Claude Code tmux session "${tmuxName}".`,
        );
      }

      await this._tmux(
        ['set-option', '-t', `=${tmuxName}`, 'remain-on-exit', 'on'],
        snapshot,
        env,
      );
    }

    // Poll capture-pane until Claude Code TUI is ready at the composer prompt
    const readyTimeoutMs = Number(this.targetConfig.readyTimeoutMs ?? 20000);
    const pollIntervalMs = Number(this.targetConfig.pollIntervalMs ?? 80);
    const deadline = Date.now() + readyTimeoutMs;

    while (Date.now() < deadline && !runtime?.aborted) {
      const pane = await this._capturePaneLines(tmuxName, snapshot, env);
      if (pane.ok) {
        const attention = detectClaudeAttention(pane.lines, pane.dead);
        if (attention?.kind === 'dead') {
          throw new Error(`Claude Code tmux pane exited during startup: ${attention.detail}`);
        }
        if (attention?.kind === 'login') {
          throw new Error(`Claude Code requires interactive login: ${attention.detail}`);
        }
        if (attention?.kind === 'trust' && this.targetConfig.autoTrustFolder !== false) {
          await this._tmux(['send-keys', '-t', `=${tmuxName}`, 'Enter'], snapshot, env);
          await sleep(pollIntervalMs);
          continue;
        }
        if (claudePaneLooksReady(pane.lines) || attention?.kind === 'permission') {
          break;
        }
      }
      await sleep(pollIntervalMs);
    }

    return tmuxName;
  }

  async _submitPromptToTmux(tmuxName, framedPrompt, snapshot, env = {}) {
    const safeId = `${String(snapshot.taskId).replace(/[^A-Za-z0-9_-]/g, '')}-${Date.now()}`;
    const bufName = `reins-in-${safeId}`;
    const pasteDelayMs = Number(
      this.targetConfig.pasteDelayMs ?? (this._isSsh() ? 250 : 60),
    );

    if (this._isSsh()) {
      const remoteTmpFile = `/tmp/reins-cc-in-${safeId}.txt`;
      const b64 = Buffer.from(framedPrompt, 'utf8').toString('base64');
      await execRemoteCommand(
        this._transportConfig(),
        `printf '%s' ${quotePosixShellArg(b64)} | base64 -d > ${quotePosixShellArg(remoteTmpFile)}`,
        { timeoutMs: 10000 },
      );
      try {
        // Ignore exit code 1 from load-buffer caused by user ~/.tmux.conf xclip hooks
        await this._tmux(['load-buffer', '-b', bufName, remoteTmpFile], snapshot, env);
        const pasted = await this._tmux(
          ['paste-buffer', '-p', '-b', bufName, '-t', `=${tmuxName}`],
          snapshot,
          env,
        );
        if (pasted.error || pasted.timedOut || pasted.exitCode !== 0) {
          throw new Error(
            pasted.error?.message ||
              pasted.stderr?.trim() ||
              `Unable to bracket-paste prompt into tmux session "${tmuxName}".`,
          );
        }
        await this._tmux(['delete-buffer', '-b', bufName], snapshot, env);
      } finally {
        await execRemoteCommand(
          this._transportConfig(),
          `rm -f ${quotePosixShellArg(remoteTmpFile)}`,
          { timeoutMs: 5000 },
        ).catch(() => {});
      }
    } else {
      const localTmpFile = path.join(os.tmpdir(), `reins-cc-in-${safeId}.txt`);
      fs.writeFileSync(localTmpFile, framedPrompt, 'utf8');
      try {
        await this._tmux(['load-buffer', '-b', bufName, localTmpFile], snapshot, env);
        const pasted = await this._tmux(
          ['paste-buffer', '-p', '-b', bufName, '-t', `=${tmuxName}`],
          snapshot,
          env,
        );
        if (pasted.error || pasted.timedOut || pasted.exitCode !== 0) {
          throw new Error(
            pasted.error?.message ||
              pasted.stderr?.trim() ||
              `Unable to bracket-paste prompt into tmux session "${tmuxName}".`,
          );
        }
        await this._tmux(['delete-buffer', '-b', bufName], snapshot, env);
      } finally {
        try {
          if (fs.existsSync(localTmpFile)) fs.unlinkSync(localTmpFile);
        } catch {
          // Ignore temp file cleanup errors.
        }
      }
    }

    if (pasteDelayMs > 0) {
      await sleep(pasteDelayMs);
    }
    const entered = await this._tmux(
      ['send-keys', '-t', `=${tmuxName}`, 'Enter'],
      snapshot,
      env,
    );
    if (entered.error || entered.timedOut || entered.exitCode !== 0) {
      throw new Error(
        entered.error?.message ||
          entered.stderr?.trim() ||
          `Unable to submit Enter key to tmux session "${tmuxName}".`,
      );
    }
  }

  async runTurn(snapshot, { prompt, envVars = {}, timeoutMs = 3600000 }, onUpdate = () => {}) {
    const startedAt = Date.now();
    const transportConfig = this._transportConfig();
    const isSsh = this._isSsh();
    const framedPrompt = applyPresetPrompt(prompt, snapshot.preset);

    const hadPriorSessionId = Boolean(snapshot.sessionId);
    if (!snapshot.sessionId) {
      snapshot.sessionId = crypto.randomUUID();
    }

    const effectiveModel = snapshot.model || this.targetConfig.model;
    const effectiveEffort = snapshot.effort || this.targetConfig.effort;
    const env = { ...(this.targetConfig.env || {}), ...envVars };
    if (effectiveModel) env.DEEPSEEK_MODEL ||= effectiveModel;
    if (process.env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY ||= process.env.DEEPSEEK_API_KEY;
    if (process.env.DEEPSEEK_BASE_URL) env.DEEPSEEK_BASE_URL ||= process.env.DEEPSEEK_BASE_URL;

    const runtime = {
      aborted: false,
      snapshot,
      onUpdate,
      tmuxName: null,
      env,
      cliDurationMs: null,
    };
    this.activeSessions.set(snapshot.taskId, runtime);

    const emitUpdate = () => {
      snapshot.metrics.updatedAt = new Date().toISOString();
      snapshot.metrics.durationMs = runtime.cliDurationMs ?? Math.max(0, Date.now() - startedAt);
      snapshot.diagnostic = formatDiagnosticSummary(snapshot);
      onUpdate(snapshot);
    };
    runtime.emitUpdate = emitUpdate;

    const appendEvent = (event) => {
      snapshot.transcript.lastSeq += 1;
      snapshot.transcript.totalEvents += 1;
      snapshot.transcript.messages.push({
        seq: snapshot.transcript.lastSeq,
        timestamp: new Date().toISOString(),
        ...event,
      });
    };

    const baseCostUsd = snapshot.metrics.costUsd || 0;
    snapshot.status = 'running';
    snapshot.stopReason = undefined;
    snapshot.error = undefined;
    snapshot.attention = undefined;
    snapshot.output = '';
    snapshot.metrics.turnCount = (snapshot.metrics.turnCount || 0) + 1;
    appendEvent({ role: 'user', phase: 'input', text: framedPrompt });
    emitUpdate();

    try {
      const tmuxName = await this._ensureInteractiveTmuxSession(snapshot, env, {
        hadPriorSessionId,
        runtime,
      });
      runtime.tmuxName = tmuxName;
      snapshot.tmuxSession = tmuxName;
      this.tmuxSessions.set(snapshot.taskId, snapshot);

      // Snapshot existing transcript lines & UUIDs before submitting the current turn's prompt
      const transcriptState = createClaudeTranscriptState(snapshot.sessionId);
      const baselineLines = await this._readTranscriptLines(snapshot, snapshot.sessionId, env);
      for (const line of baselineLines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.uuid) transcriptState.seenUuids.add(parsed.uuid);
        } catch {
          // Ignore malformed prior lines.
        }
      }
      let processedLineCount = baselineLines.length;

      await this._submitPromptToTmux(tmuxName, framedPrompt, snapshot, env);

      const pollIntervalMs = Number(
        this.targetConfig.pollIntervalMs ?? (isSsh ? 250 : 60),
      );
      const deadline = Date.now() + timeoutMs;
      let turnClosed = false;
      let turnInterrupted = false;
      let lastAutoActionAt = 0;

      while (!runtime.aborted && !turnClosed && !turnInterrupted) {
        if (Date.now() >= deadline) {
          await this._tmux(['send-keys', '-t', `=${tmuxName}`, 'Escape'], snapshot, env).catch(
            () => {},
          );
          throw new Error(`Claude Code turn timed out after ${timeoutMs}ms.`);
        }

        const allLines = await this._readTranscriptLines(snapshot, snapshot.sessionId, env);
        const startIdx = allLines.length >= processedLineCount ? processedLineCount : 0;
        const newLines = allLines.slice(startIdx);
        processedLineCount = allLines.length;

        let transcriptChanged = false;
        for (const rawLine of newLines) {
          const { events } = foldClaudeTranscriptLine(transcriptState, rawLine);
          if (events.length === 0) continue;
          transcriptChanged = true;

          if (transcriptState.sessionId) {
            snapshot.sessionId = transcriptState.sessionId;
          }
          snapshot.output = transcriptState.turnOutput;
          if (transcriptState.turnCommentary.length > 0) {
            snapshot.commentary = transcriptState.turnCommentary.join('\n');
          }
          if (transcriptState.turnCostUsd > 0) {
            snapshot.metrics.costUsd = Number(
              (baseCostUsd + transcriptState.turnCostUsd).toFixed(6),
            );
          }
          if (
            transcriptState.usage.inputTokens > 0 ||
            transcriptState.usage.outputTokens > 0 ||
            transcriptState.usage.cacheReadTokens > 0
          ) {
            snapshot.metrics.tokens = { ...transcriptState.usage };
          }

          for (const ev of events) {
            if (ev.type === 'tool_use') {
              appendEvent({ role: 'tool', phase: 'tool_call', toolCall: ev.toolCall });
            } else if (ev.type === 'turn_close') {
              if (Number.isFinite(ev.durationMs)) {
                runtime.cliDurationMs = ev.durationMs;
              }
              turnClosed = true;
            } else if (ev.type === 'turn_interrupted') {
              turnInterrupted = true;
            }
          }
        }

        if (transcriptChanged) {
          emitUpdate();
        }
        if (turnClosed || turnInterrupted || runtime.aborted) {
          break;
        }

        const pane = await this._capturePaneLines(tmuxName, snapshot, env);
        if (pane.ok) {
          const attention = detectClaudeAttention(pane.lines, pane.dead);
          if (attention?.kind === 'dead') {
            throw new Error(`Claude Code tmux pane exited unexpectedly: ${attention.detail}`);
          }
          if (attention?.kind === 'trust' && this.targetConfig.autoTrustFolder !== false) {
            if (Date.now() - lastAutoActionAt > 400) {
              lastAutoActionAt = Date.now();
              await this._tmux(['send-keys', '-t', `=${tmuxName}`, 'Enter'], snapshot, env);
            }
          } else if (attention?.kind === 'permission') {
            if (snapshot.reinPolicy === 'free-rein') {
              if (Date.now() - lastAutoActionAt > 400) {
                lastAutoActionAt = Date.now();
                await this._tmux(['send-keys', '-t', `=${tmuxName}`, 'Enter'], snapshot, env);
              }
            } else if (snapshot.reinPolicy === 'plan-only') {
              if (Date.now() - lastAutoActionAt > 400) {
                lastAutoActionAt = Date.now();
                await this._tmux(['send-keys', '-t', `=${tmuxName}`, 'Escape'], snapshot, env);
              }
            } else if (snapshot.status !== 'attention_required') {
              snapshot.status = 'attention_required';
              snapshot.stopReason = 'attention-required';
              snapshot.attention = {
                requestId: `att_${crypto.randomBytes(4).toString('hex')}`,
                method: 'claude/permission_prompt',
                kind: attention.kind,
                summary: attention.summary,
                detail: attention.detail,
                options: attention.options,
              };
              emitUpdate();
            }
          } else if (snapshot.status === 'attention_required' && !attention) {
            snapshot.status = 'running';
            snapshot.stopReason = undefined;
            snapshot.attention = undefined;
            emitUpdate();
          }
        }

        await sleep(pollIntervalMs);
      }

      if (runtime.aborted || turnInterrupted) {
        snapshot.status = 'aborted';
        snapshot.stopReason = 'aborted';
        snapshot.attention = undefined;
      } else {
        if (snapshot.sessionMode === 'ephemeral') {
          await this._tmux(['kill-session', '-t', `=${tmuxName}`], snapshot, env).catch(() => {});
          await this._removeTranscript(snapshot, snapshot.sessionId, env);
          this.tmuxSessions.delete(snapshot.taskId);
          snapshot.tmuxSession = undefined;
          snapshot.resumeCommandHint = undefined;
        } else {
          snapshot.tmuxSession = tmuxName;
          this.tmuxSessions.set(snapshot.taskId, snapshot);
          snapshot.resumeCommandHint = buildResumeCommandHint({
            kind: 'claude-code',
            sessionId: snapshot.sessionId,
            sessionMode: snapshot.sessionMode,
            transportType: isSsh ? 'ssh' : 'local',
            sshHost: transportConfig?.host || transportConfig?.sshHost,
            tmuxSession: snapshot.tmuxSession,
          });
        }
        snapshot.attention = undefined;
        appendEvent({ role: 'assistant', phase: 'final_answer', text: snapshot.output });
        snapshot.status = 'completed';
        snapshot.stopReason = 'end_turn';
      }
    } catch (error) {
      snapshot.attention = undefined;
      snapshot.status = runtime.aborted ? 'aborted' : 'failed';
      snapshot.stopReason = runtime.aborted ? 'aborted' : 'error';
      if (!runtime.aborted) snapshot.error = error.message || String(error);
    } finally {
      this.activeSessions.delete(snapshot.taskId);
      emitUpdate();
    }

    return snapshot;
  }

  async steerLive(taskId, { action, message, snapshot } = {}) {
    const runtime = this.activeSessions.get(taskId);
    const session = runtime?.snapshot || this.tmuxSessions.get(taskId) || snapshot;

    if (action === 'reply') {
      if (!message || !String(message).trim()) {
        throw new Error('Steer action "reply" requires a non-empty message.');
      }
      if (runtime) {
        throw new Error('An active Claude Code turn cannot accept a concurrent live reply.');
      }
      return { handledLive: false };
    }

    if (action === 'interrupt') {
      await this.abort(taskId, session, { terminateSession: false });
      return { handledLive: true, snapshot: session };
    }

    if (action !== 'approve' && action !== 'reject') {
      return { handledLive: false };
    }

    const tmuxName = runtime?.tmuxName || session?.tmuxSession;
    if (!tmuxName) {
      return { handledLive: false };
    }

    const key = action === 'approve' ? 'Enter' : 'Escape';
    const result = await this._tmux(
      ['send-keys', '-t', `=${tmuxName}`, key],
      session,
      runtime?.env || {},
    );
    if (result.error || result.timedOut || result.exitCode !== 0) {
      throw new Error(
        result.error?.message ||
          result.stderr?.trim() ||
          `Unable to send "${key}" to Claude Code tmux session "${tmuxName}".`,
      );
    }

    if (runtime && runtime.snapshot.status === 'attention_required') {
      runtime.snapshot.status = 'running';
      runtime.snapshot.stopReason = undefined;
      runtime.snapshot.attention = undefined;
      runtime.emitUpdate();
    }

    return { handledLive: true, snapshot: session };
  }

  async abort(taskId, snapshot, { terminateSession = false } = {}) {
    const runtime = this.activeSessions.get(taskId);
    const session = runtime?.snapshot || this.tmuxSessions.get(taskId) || snapshot;
    const tmuxName =
      runtime?.tmuxName ||
      session?.tmuxSession ||
      (session?.sessionId ? this._tmuxSessionName(session) : null);

    if (runtime) {
      runtime.aborted = true;
      runtime.snapshot.status = 'aborted';
      runtime.snapshot.stopReason = 'aborted';
      runtime.snapshot.attention = undefined;
      runtime.emitUpdate();
    }

    if (!tmuxName) {
      return Boolean(runtime);
    }

    if (terminateSession) {
      const result = await this._tmux(
        ['kill-session', '-t', `=${tmuxName}`],
        session || { cwd: process.cwd() },
        runtime?.env || {},
      );
      if (
        result.error ||
        result.timedOut ||
        (result.exitCode !== 0 && !/noServer|can't find|not found/i.test(result.stderr || ''))
      ) {
        throw new Error(
          result.error?.message ||
            result.stderr?.trim() ||
            `Unable to kill Claude Code tmux session "${tmuxName}".`,
        );
      }
      this.tmuxSessions.delete(taskId);
      if (session) {
        session.sessionTerminated = true;
        session.tmuxSession = undefined;
        session.resumeCommandHint = null;
        session.status = 'aborted';
        session.stopReason = 'aborted';
      }
      return true;
    }

    const result = await this._tmux(
      ['send-keys', '-t', `=${tmuxName}`, 'Escape'],
      session || { cwd: process.cwd() },
      runtime?.env || {},
    );
    if (result.error || result.timedOut || result.exitCode !== 0) {
      throw new Error(
        result.error?.message ||
          result.stderr?.trim() ||
          `Unable to interrupt Claude Code tmux session "${tmuxName}".`,
      );
    }
    if (session) {
      session.status = 'aborted';
      session.stopReason = 'aborted';
    }
    return true;
  }
}
