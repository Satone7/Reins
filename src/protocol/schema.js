/**
 * Reins H2H (Harness-to-Harness) Protocol v0.2 — Schema, Policies, and Snapshot Builders
 *
 * Implements the canonical data structures, policy mappings, session lifecycle
 * resolvers, and diagnostic formatters defined in docs/H2H_PROTOCOL.md.
 */

export const H2H_PROTOCOL_VERSION = '0.2.0';

export const HARNESS_KINDS = Object.freeze([
  'claude-code',
  'codex',
  'dsh',
  'antigravity',
  'generic-acp',
  'generic-cli',
]);

export const SESSION_MODES = Object.freeze([
  'persistent',
  'ephemeral',
]);

export const REIN_POLICIES = Object.freeze([
  'free-rein',
  'auto-edit',
  'parent-rein',
  'tight-rein',
  'plan-only',
]);

export const TASK_PRESETS = Object.freeze([
  'task',
  'review',
  'adversarial-review',
  'rescue',
]);

export const TASK_STATUSES = Object.freeze([
  'queued',
  'running',
  'attention_required',
  'completed',
  'failed',
  'aborted',
]);

export const STOP_REASONS = Object.freeze([
  'end_turn',
  'max_turns',
  'max_tokens',
  'aborted',
  'error',
]);

export const STEER_ACTIONS = Object.freeze([
  'reply',
  'approve',
  'reject',
  'interrupt',
]);

export const REASONING_EFFORTS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

/**
 * Resolves the effective session lifecycle mode (`persistent` vs `ephemeral`).
 *
 * Heuristics when not explicitly specified by the caller:
 * - `review` and `adversarial-review` presets default to `ephemeral` so one-shot
 *   inspections do not clutter the user's primary session history.
 * - `rescue` defaults to `persistent` so the user can inspect and continue the fix.
 * - Standard `task` delegates fall back to the target's configured `defaultSessionMode`
 *   (or `persistent` if unspecified).
 *
 * @param {object} options
 * @param {string} [options.requestedMode]
 * @param {string} [options.preset]
 * @param {string} [options.targetDefaultMode]
 * @returns {'persistent' | 'ephemeral'}
 */
export function resolveSessionMode({ requestedMode, preset = 'task', targetDefaultMode } = {}) {
  if (requestedMode && SESSION_MODES.includes(requestedMode)) {
    return requestedMode;
  }
  if (preset === 'review' || preset === 'adversarial-review') {
    return 'ephemeral';
  }
  if (preset === 'rescue') {
    return 'persistent';
  }
  if (targetDefaultMode && SESSION_MODES.includes(targetDefaultMode)) {
    return targetDefaultMode;
  }
  return 'persistent';
}

/**
 * Resolves the effective ReinPolicy for a delegated task.
 *
 * @param {object} options
 * @param {string} [options.requestedPolicy]
 * @param {string} [options.preset]
 * @param {string} [options.targetDefaultPolicy]
 * @returns {'free-rein' | 'auto-edit' | 'parent-rein' | 'tight-rein' | 'plan-only'}
 */
export function resolveReinPolicy({ requestedPolicy, preset = 'task', targetDefaultPolicy } = {}) {
  if (requestedPolicy && REIN_POLICIES.includes(requestedPolicy)) {
    return requestedPolicy;
  }
  if (preset === 'review' || preset === 'adversarial-review') {
    return 'plan-only';
  }
  if (targetDefaultPolicy && REIN_POLICIES.includes(targetDefaultPolicy)) {
    return targetDefaultPolicy;
  }
  return 'parent-rein';
}

/**
 * Maps an H2H ReinPolicy to OpenAI Codex `app-server` approval and sandbox parameters.
 *
 * @param {string} reinPolicy
 * @returns {{ approvalPolicy: string, sandbox: string }}
 */
export function mapReinPolicyToCodex(reinPolicy) {
  switch (reinPolicy) {
    case 'free-rein':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'auto-edit':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    case 'parent-rein':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'tight-rein':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    case 'plan-only':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
}

/**
 * Applies preset framing to the user/caller prompt when a specialized task preset is selected.
 *
 * @param {string} prompt
 * @param {string} [preset='task']
 * @returns {string}
 */
export function applyPresetPrompt(prompt, preset = 'task') {
  const trimmed = String(prompt ?? '').trim();
  if (!trimmed) {
    throw new Error('Delegated prompt must be a non-empty string.');
  }

  switch (preset) {
    case 'review':
      return [
        '[Reins H2H Preset: Code Review (Read-Only)]',
        'Perform a thorough, objective code review for the following request.',
        'Do not modify files. Report concrete findings with severity, file path, line numbers, and actionable recommendations.',
        '',
        trimmed,
      ].join('\n');

    case 'adversarial-review':
      return [
        '[Reins H2H Preset: Adversarial Review (Read-Only)]',
        'Act as a skeptical adversarial reviewer. Actively challenge architectural assumptions, probe edge cases, race conditions, failure modes, security boundaries, and cross-platform hazards.',
        'Do not modify files. Provide falsifiable critiques with exact file locations and failure scenarios.',
        '',
        trimmed,
      ].join('\n');

    case 'rescue':
      return [
        '[Reins H2H Preset: Rescue & Root-Cause Recovery]',
        'Diagnose the root cause of the failure or stalled state described below, implement a minimal and well-verified fix, and summarize both the root cause and verification steps.',
        '',
        trimmed,
      ].join('\n');

    case 'task':
    default:
      return trimmed;
  }
}

/**
 * Builds the native CLI command hint that a human user can run to take over a persistent session.
 *
 * @param {object} options
 * @param {string} options.kind
 * @param {string} [options.sessionId]
 * @param {string} [options.sessionMode]
 * @param {string} [options.transportType]
 * @param {string} [options.sshHost]
 * @param {string} [options.tmuxSession]
 * @returns {string | undefined}
 */
export function buildResumeCommandHint({
  kind,
  sessionId,
  sessionMode,
  transportType = 'local',
  sshHost,
  tmuxSession,
}) {
  if (sessionMode === 'ephemeral' || !sessionId) {
    return undefined;
  }

  let baseCmd;
  switch (kind) {
    case 'codex':
      baseCmd = `codex resume ${sessionId}`;
      break;
    case 'claude-code':
      if (tmuxSession) {
        baseCmd = `tmux attach -t ${tmuxSession}`;
      } else {
        baseCmd = `claude --resume ${sessionId}`;
      }
      break;
    case 'dsh':
      baseCmd = `dsh --session ${sessionId}`;
      break;
    case 'antigravity':
      baseCmd = `agy --conversation ${sessionId}`;
      break;
    default:
      baseCmd = undefined;
  }

  if (!baseCmd) {
    return undefined;
  }
  if (transportType === 'ssh' && sshHost) {
    return `ssh -t ${sshHost} "${baseCmd}"`;
  }
  return baseCmd;
}

/**
 * Formats a safe, structured diagnostic summary suitable for logs and parent-agent inspection
 * without leaking full prompt/transcript payloads.
 *
 * @param {object} snapshot
 * @returns {string}
 */
export function formatDiagnosticSummary(snapshot) {
  const parts = [
    `taskId=${snapshot.taskId}`,
    `target=${snapshot.targetId}(${snapshot.kind})`,
    `status=${snapshot.status}`,
    `mode=${snapshot.sessionMode}`,
  ];
  if (snapshot.model) {
    parts.push(`model=${snapshot.model}`);
  }
  if (snapshot.effort) {
    parts.push(`effort=${snapshot.effort}`);
  }
  if (snapshot.sessionId) {
    parts.push(`sessionId=${snapshot.sessionId}`);
  }
  if (snapshot.stopReason) {
    parts.push(`stopReason=${snapshot.stopReason}`);
  }
  if (typeof snapshot.metrics?.durationMs === 'number') {
    parts.push(`durationMs=${snapshot.metrics.durationMs}`);
  }
  if (snapshot.error) {
    parts.push(`error=${ JSON.stringify(String(snapshot.error).slice(0, 240)) }`);
  }
  if (snapshot.resumeCommandHint) {
    parts.push(`resume=${ JSON.stringify(snapshot.resumeCommandHint) }`);
  }
  return `[Reins H2H] ${parts.join(' | ')}`;
}

/**
 * Creates a fresh H2HTaskSnapshot object adhering to H2H Protocol v0.2.
 *
 * @param {object} params
 * @returns {object}
 */
export function createInitialTaskSnapshot({
  taskId,
  targetId,
  kind,
  sessionMode = 'persistent',
  reinPolicy = 'parent-rein',
  preset = 'task',
  cwd,
  model,
  effort,
  sessionId,
  transportType = 'local',
  sshHost,
  trace,
}) {
  const now = new Date().toISOString();
  const snapshot = {
    protocolVersion: H2H_PROTOCOL_VERSION,
    taskId,
    targetId,
    kind,
    sessionId: sessionId || undefined,
    sessionMode,
    reinPolicy,
    preset,
    cwd,
    model: model || undefined,
    effort: effort || undefined,
    resumeCommandHint: buildResumeCommandHint({
      kind,
      sessionId,
      sessionMode,
      transportType,
      sshHost,
    }),
    status: 'queued',
    stopReason: undefined,
    output: '',
    commentary: '',
    error: undefined,
    diagnostic: '',
    attention: undefined,
    transcript: {
      totalEvents: 0,
      lastSeq: 0,
      messages: [],
    },
    metrics: {
      startedAt: now,
      updatedAt: now,
      durationMs: 0,
      turnCount: 0,
      costUsd: undefined,
      tokens: undefined,
    },
    trace: trace || undefined,
  };
  snapshot.diagnostic = formatDiagnosticSummary(snapshot);
  return snapshot;
}
