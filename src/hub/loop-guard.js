/**
 * Reins H2H Loop Guard — Circular Delegation & Hop Depth Protection
 *
 * Prevents infinite delegation cycles (e.g., Harness A -> Harness B -> Harness A)
 * by tracking trace metadata across environment variables and H2H task requests.
 */

import crypto from 'node:crypto';

export const DEFAULT_MAX_HOPS = 4;

/**
 * Extracts the incoming H2H trace state from an explicit request trace object
 * or from the current process environment (`REINS_*` variables).
 *
 * @param {object} [requestTrace]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [configuredMaxHops]
 * @returns {{ traceId: string, hopCount: number, maxHops: number, callChain: string[] }}
 */
export function resolveIncomingTrace(requestTrace = {}, env = process.env, configuredMaxHops = DEFAULT_MAX_HOPS) {
  const traceId =
    requestTrace.traceId ||
    env.REINS_TRACE_ID ||
    `tr_${crypto.randomBytes(6).toString('hex')}`;

  const envHopCount = Number.parseInt(env.REINS_HOP_COUNT ?? '0', 10);
  const hopCount =
    typeof requestTrace.hopCount === 'number' && Number.isFinite(requestTrace.hopCount)
      ? requestTrace.hopCount
      : Number.isFinite(envHopCount)
        ? envHopCount
        : 0;

  const envMaxHops = Number.parseInt(env.REINS_MAX_HOPS ?? '', 10);
  const maxHops =
    typeof requestTrace.maxHops === 'number' && requestTrace.maxHops > 0
      ? requestTrace.maxHops
      : Number.isFinite(envMaxHops) && envMaxHops > 0
        ? envMaxHops
        : configuredMaxHops;

  let callChain = [];
  if (Array.isArray(requestTrace.callChain)) {
    callChain = requestTrace.callChain.map(String).filter(Boolean);
  } else if (typeof env.REINS_CALL_CHAIN === 'string' && env.REINS_CALL_CHAIN.trim()) {
    callChain = env.REINS_CALL_CHAIN.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    traceId,
    hopCount,
    maxHops,
    callChain,
  };
}

/**
 * Validates that delegating to `targetId` does not exceed `maxHops` or create a direct cycle,
 * and returns the next-hop trace state along with the child environment variables to inject.
 *
 * @param {object} options
 * @param {string} options.targetId
 * @param {object} [options.requestTrace]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.configuredMaxHops]
 * @param {boolean} [options.allowTargetReentry=false]
 * @returns {{ trace: { traceId: string, hopCount: number, maxHops: number, callChain: string[] }, envVars: Record<string, string> }}
 */
export function advanceTraceOrThrow({
  targetId,
  requestTrace,
  env = process.env,
  configuredMaxHops = DEFAULT_MAX_HOPS,
  allowTargetReentry = false,
}) {
  const current = resolveIncomingTrace(requestTrace, env, configuredMaxHops);
  const nextHopCount = current.hopCount + 1;

  if (nextHopCount > current.maxHops) {
    throw new Error(
      `H2H Loop Guard rejected delegation to "${targetId}": hopCount (${nextHopCount}) exceeds maxHops (${current.maxHops}). Call chain: [${current.callChain.join(' -> ')}]`,
    );
  }

  if (!allowTargetReentry && current.callChain.includes(targetId)) {
    throw new Error(
      `H2H Loop Guard rejected circular delegation to "${targetId}": target already appears in active call chain [${current.callChain.join(' -> ')}].`,
    );
  }

  const nextChain = [...current.callChain, targetId];
  const trace = {
    traceId: current.traceId,
    hopCount: nextHopCount,
    maxHops: current.maxHops,
    callChain: nextChain,
  };

  const envVars = {
    REINS_TRACE_ID: trace.traceId,
    REINS_HOP_COUNT: String(trace.hopCount),
    REINS_MAX_HOPS: String(trace.maxHops),
    REINS_CALL_CHAIN: trace.callChain.join(','),
  };

  return { trace, envVars };
}
