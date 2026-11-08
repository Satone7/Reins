/**
 * Reins H2H (Harness-to-Harness) Protocol v0.2 — Schema, Policies, and Snapshot Builders
 *
 * Implements the canonical data structures, policy mappings, session lifecycle
 * resolvers, and diagnostic formatters defined in docs/H2H_PROTOCOL.md.
 */

export const H2H_PROTOCOL_ID = 'h2h/v0.1';
export const H2H_PROTOCOL_VERSION = '0.1.0';

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
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
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

export const MAX_DIAGNOSTIC_UTF8_BYTES = 4096;

/**
 * Truncates a string so its UTF-8 byte length does not exceed `maxBytes`.
 *
 * @param {string} text
 * @param {number} [maxBytes=MAX_DIAGNOSTIC_UTF8_BYTES]
 * @returns {string}
 */
export function truncateUtf8Bytes(text, maxBytes = MAX_DIAGNOSTIC_UTF8_BYTES) {
  const str = String(text ?? '');
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) {
    return str;
  }
  const suffix = '...';
  const targetBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let buf = Buffer.from(str, 'utf8').subarray(0, targetBytes);
  // Trim any incomplete multi-byte UTF-8 sequence at the tail
  while (buf.length > 0 && (buf[buf.length - 1] & 0b11000000) === 0b10000000) {
    buf = buf.subarray(0, buf.length - 1);
  }
  if (buf.length > 0 && (buf[buf.length - 1] & 0b10000000) !== 0) {
    buf = buf.subarray(0, buf.length - 1);
  }
  return `${buf.toString('utf8')}${suffix}`;
}

/**
 * Formats a safe, structured diagnostic summary suitable for logs and parent-agent inspection
 * without leaking full prompt/transcript payloads, bounded to 4,096 UTF-8 bytes.
 *
 * @param {object} snapshot
 * @returns {string}
 */
export function formatDiagnosticSummary(snapshot) {
  const targetKind = snapshot.targetKind || snapshot.kind || 'unknown';
  const parts = [
    `taskId=${snapshot.taskId}`,
    `target=${snapshot.targetId}(${targetKind})`,
    `status=${snapshot.status}`,
    `mode=${snapshot.sessionMode}`,
  ];
  if (snapshot.project?.binding) {
    parts.push(`projectBinding=${snapshot.project.binding}`);
  }
  if (snapshot.project?.id) {
    parts.push(`projectId=${snapshot.project.id}`);
  }
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
    parts.push(`error=${JSON.stringify(String(snapshot.error).slice(0, 240))}`);
  }
  if (snapshot.resumeCommandHint) {
    parts.push(`resume=${JSON.stringify(snapshot.resumeCommandHint)}`);
  }
  return truncateUtf8Bytes(`[Reins H2H] ${parts.join(' | ')}`, MAX_DIAGNOSTIC_UTF8_BYTES);
}

/**
 * Creates a fresh H2HTaskSnapshot object adhering to H2H Protocol v0.1.
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
  project,
  model,
  effort,
  sessionId,
  transportType = 'local',
  sshHost,
  trace,
}) {
  const now = new Date().toISOString();
  const resumeHint = buildResumeCommandHint({
    kind,
    sessionId,
    sessionMode,
    transportType,
    sshHost,
  });
  const defaultBinding = sessionMode === 'ephemeral' ? 'not-required' : 'pending';
  const defaultMechanism =
    sessionMode === 'ephemeral'
      ? null
      : kind === 'codex'
        ? 'native-id'
        : 'native-path';

  const snapshot = {
    protocol: H2H_PROTOCOL_ID,
    protocolVersion: H2H_PROTOCOL_VERSION,
    taskId,
    targetId,
    kind,
    targetKind: kind,
    sessionId: sessionId || null,
    sessionMode,
    reinPolicy,
    preset,
    cwd,
    ...(project?.id || project?.root
      ? {
          projectSelector: {
            ...(project.id ? { id: project.id } : {}),
            ...(project.root ? { root: project.root } : {}),
          },
        }
      : {}),
    project: {
      id: project?.id ?? null,
      root: project?.root ?? null,
      binding: project?.binding ?? defaultBinding,
      mechanism: project?.mechanism !== undefined ? project.mechanism : defaultMechanism,
    },
    model: model || null,
    effort: effort || null,
    resumeCommandHint: resumeHint || null,
    status: 'queued',
    stopReason: null,
    output: '',
    commentary: '',
    error: null,
    diagnostic: '',
    attention: undefined,
    transcript: {
      totalEvents: 0,
      lastSeq: 0,
      messages: [],
    },
    metrics: {
      createdAt: now,
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

/**
 * Normalizes a mutable H2HTaskSnapshot in-place so all required nullable fields
 * and project-binding invariants conform to `schema/h2h-v0.1.schema.json`.
 *
 * @param {object} snapshot
 * @returns {object}
 */
export function normalizeSnapshotEnvelope(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  snapshot.protocol = snapshot.protocol || H2H_PROTOCOL_ID;
  snapshot.protocolVersion = snapshot.protocolVersion || H2H_PROTOCOL_VERSION;
  snapshot.targetKind = snapshot.targetKind || snapshot.kind || 'unknown';
  snapshot.kind = snapshot.kind || snapshot.targetKind;
  snapshot.sessionId = snapshot.sessionId ?? null;
  snapshot.model = snapshot.model ?? null;
  snapshot.effort = snapshot.effort ?? null;
  snapshot.resumeCommandHint = snapshot.resumeCommandHint ?? null;
  snapshot.stopReason = snapshot.stopReason ?? null;
  snapshot.error = snapshot.error ?? null;
  snapshot.output = typeof snapshot.output === 'string' ? snapshot.output : String(snapshot.output ?? '');

  if (!snapshot.project || typeof snapshot.project !== 'object') {
    snapshot.project = {
      id: null,
      root: snapshot.kind === 'codex' ? null : snapshot.cwd || null,
      binding: snapshot.sessionMode === 'ephemeral' ? 'not-required' : 'pending',
      mechanism:
        snapshot.sessionMode === 'ephemeral'
          ? null
          : snapshot.kind === 'codex'
            ? 'native-id'
            : 'native-path',
    };
  } else {
    snapshot.project.id = snapshot.project.id ?? null;
    snapshot.project.root =
      snapshot.project.root ??
      (snapshot.kind === 'codex' && snapshot.project.binding === 'pending'
        ? null
        : snapshot.cwd || null);
    if (snapshot.sessionMode === 'ephemeral') {
      snapshot.project.id = null;
      snapshot.project.binding = 'not-required';
      snapshot.project.mechanism = null;
    } else if (
      snapshot.kind !== 'codex' &&
      snapshot.project.binding === 'pending' &&
      snapshot.sessionId &&
      (snapshot.status === 'running' ||
        snapshot.status === 'completed' ||
        snapshot.status === 'attention_required')
    ) {
      snapshot.project.binding = 'bound';
      snapshot.project.mechanism = snapshot.project.mechanism || 'native-path';
    }
  }

  if (snapshot.metrics && typeof snapshot.metrics === 'object') {
    snapshot.metrics.createdAt =
      snapshot.metrics.createdAt || snapshot.metrics.startedAt || new Date().toISOString();
    snapshot.metrics.startedAt = snapshot.metrics.startedAt || snapshot.metrics.createdAt;
  }

  snapshot.diagnostic = formatDiagnosticSummary(snapshot);
  return snapshot;
}
