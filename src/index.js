#!/usr/bin/env node

/**
 * Reins — H2H (Harness-to-Harness) MCP Server & Remote Control Hub
 *
 * Entry point placeholder.
 * See:
 *   - docs/ARCHITECTURE.md
 *   - docs/H2H_PROTOCOL.md
 *   - research/PROTOCOLS_AND_ECOSYSTEM.md
 */

export const VERSION = '0.1.0';

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  console.log(`Reins v${VERSION} — Take the reins of your local and remote AI harnesses.`);
  console.log('Run Mode: Initialization skeleton ready. See docs/ARCHITECTURE.md for Milestone 1 implementation plan.');
}
