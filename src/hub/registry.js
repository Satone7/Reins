/**
 * Reins Target Registry & Configuration Loader
 *
 * Loads H2H target definitions from YAML/JSON configuration files or built-in defaults,
 * supporting both map-style (`targets: { id: {...} }`) and list-style (`targets: [ { id, ... } ]`)
 * target declarations as used in `config/reins.example.yaml`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExecutable } from '../transports/local.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Default built-in configuration used when no user config file is present.
 */
export const DEFAULT_CONFIG = Object.freeze({
  version: '0.2.0',
  hub: {
    host: '127.0.0.1',
    port: 19420,
    stateDir: '~/.reins',
    maxHops: 4,
    defaultTimeoutSec: 600,
  },
  targets: {
    'local-codex': {
      id: 'local-codex',
      kind: 'codex',
      driver: 'codex-app-server',
      transport: { type: 'local' },
      command: 'auto',
      args: ['app-server', '--stdio'],
      defaultCwd: process.cwd(),
      defaultPolicy: 'auto-edit',
      defaultSessionMode: 'persistent',
      description: 'Local OpenAI Codex (app-server)',
    },
    'local-agy': {
      id: 'local-agy',
      kind: 'antigravity',
      driver: 'antigravity-cli',
      transport: { type: 'local' },
      command: 'agy',
      args: [],
      defaultCwd: process.cwd(),
      defaultPolicy: 'parent-rein',
      defaultSessionMode: 'persistent',
      description: 'Local Antigravity (AGY)',
    },
    'local-dsh': {
      id: 'local-dsh',
      kind: 'dsh',
      driver: 'acp',
      transport: { type: 'local' },
      command: 'npx',
      args: ['@deepseek-ai/dsh', '--profile', 'acp'],
      defaultCwd: process.cwd(),
      defaultPolicy: 'parent-rein',
      defaultSessionMode: 'persistent',
      description: 'Local DeepSeek Harness (ACP)',
    },
    'faex1-dsh': {
      id: 'faex1-dsh',
      kind: 'dsh',
      driver: 'acp',
      transport: {
        type: 'ssh',
        host: 'faex1',
        port: 22,
      },
      command: '/home/pren/n/bin/node',
      args: ['/home/pren/projects/deepseek-harness/packages/cli/dist/index.js', '--acp'],
      defaultCwd: '/home/pren/projects/reins',
      defaultPolicy: 'auto-edit',
      defaultSessionMode: 'persistent',
      description: 'Remote DeepSeek Harness on Ubuntu server faex1 via ACP over SSH',
    },
    'faex1-claude': {
      id: 'faex1-claude',
      kind: 'claude-code',
      driver: 'claude-tmux',
      transport: {
        type: 'ssh',
        host: 'faex1',
        port: 22,
      },
      command: '/home/pren/n/bin/claude',
      tmuxSession: 'reins-cc',
      defaultCwd: '/home/pren/projects/reins',
      defaultPolicy: 'tight-rein',
      defaultSessionMode: 'persistent',
      description: 'FAEX1 Remote Claude Code (Interactive Tmux + JSONL Driver)',
    },
  },
});

/**
 * Expands leading `~` or `~/` to the current user's home directory.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function expandHome(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Parses a scalar value from a simple YAML line.
 *
 * @param {string} raw
 * @returns {any}
 */
function parseYamlScalar(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseYamlScalar(item));
  }
  return trimmed;
}

/**
 * Strips inline comments outside quotes from a YAML line.
 *
 * @param {string} line
 * @returns {string}
 */
function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

/**
 * Lightweight zero-dependency YAML parser supporting nested maps, lists of scalars,
 * and lists of nested objects (`- id: foo` blocks) as used in `config/reins.example.yaml`.
 *
 * @param {string} text
 * @returns {object}
 */
export function parseSimpleYaml(text) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];

  for (const rawLine of rawLines) {
    const cleaned = stripInlineComment(rawLine);
    if (!cleaned.trim()) continue;
    const indent = cleaned.match(/^ */)[0].length;
    lines.push({ indent, content: cleaned.trim() });
  }

  function parseMapEntries(startIndex, minIndent) {
    const obj = {};
    let idx = startIndex;

    while (idx < lines.length && lines[idx].indent >= minIndent) {
      const { indent, content } = lines[idx];
      if (content.startsWith('- ')) {
        break;
      }
      const colonIdx = content.indexOf(':');
      if (colonIdx === -1) {
        idx += 1;
        continue;
      }
      const key = parseYamlScalar(content.slice(0, colonIdx));
      const rest = content.slice(colonIdx + 1).trim();

      if (rest) {
        obj[key] = parseYamlScalar(rest);
        idx += 1;
      } else if (idx + 1 < lines.length && lines[idx + 1].indent > indent) {
        const [nestedVal, nextIdx] = parseBlock(idx + 1, lines[idx + 1].indent);
        obj[key] = nestedVal;
        idx = nextIdx;
      } else {
        obj[key] = {};
        idx += 1;
      }
    }
    return [obj, idx];
  }

  function parseBlock(startIndex, blockIndent) {
    let idx = startIndex;
    if (idx >= lines.length) return [{}, idx];

    if (lines[idx].content.startsWith('- ')) {
      const arr = [];
      const listIndent = lines[idx].indent;
      while (
        idx < lines.length &&
        lines[idx].indent === listIndent &&
        lines[idx].content.startsWith('- ')
      ) {
        const itemText = lines[idx].content.slice(2).trim();
        const colonIdx = itemText.indexOf(':');
        if (colonIdx !== -1) {
          // List of objects (`- key: value` followed by indented fields)
          const itemObj = {};
          const firstKey = parseYamlScalar(itemText.slice(0, colonIdx));
          const firstRest = itemText.slice(colonIdx + 1).trim();
          idx += 1;
          if (firstRest) {
            itemObj[firstKey] = parseYamlScalar(firstRest);
          } else if (idx < lines.length && lines[idx].indent > listIndent) {
            const [nested, nextIdx] = parseBlock(idx, lines[idx].indent);
            itemObj[firstKey] = nested;
            idx = nextIdx;
          }
          if (idx < lines.length && lines[idx].indent > listIndent && !lines[idx].content.startsWith('- ')) {
            const [moreFields, nextIdx] = parseMapEntries(idx, lines[idx].indent);
            Object.assign(itemObj, moreFields);
            idx = nextIdx;
          }
          arr.push(itemObj);
        } else {
          arr.push(parseYamlScalar(itemText));
          idx += 1;
        }
      }
      return [arr, idx];
    }

    return parseMapEntries(idx, blockIndent);
  }

  const [parsed] = parseBlock(0, 0);
  return parsed;
}

/**
 * Normalizes a single target configuration object from either schema style into
 * the canonical internal target representation.
 *
 * @param {string} id
 * @param {object} raw
 * @returns {object}
 */
export function normalizeTargetConfig(id, raw = {}) {
  const kind = raw.kind || raw.harnessType || 'codex';
  const driverObj = typeof raw.driver === 'object' && raw.driver !== null ? raw.driver : null;
  const driver =
    driverObj?.mode ||
    (typeof raw.driver === 'string' ? raw.driver : null) ||
    (kind === 'codex' ? 'codex-app-server' : `${kind}-driver`);

  const command =
    raw.command ||
    driverObj?.command ||
    driverObj?.binaryPath ||
    'auto';

  const args = Array.isArray(raw.args)
    ? raw.args
    : Array.isArray(driverObj?.args)
      ? driverObj.args
      : Array.isArray(driverObj?.extraArgs)
        ? driverObj.extraArgs
        : kind === 'codex'
          ? ['app-server', '--stdio']
          : [];

  const rawTransport = raw.transport || {};
  const transportType = rawTransport.type || rawTransport.kind || 'local';
  const sshHost = rawTransport.host || rawTransport.sshHost;
  const transport = {
    ...rawTransport,
    type: transportType,
    ...(sshHost ? { host: sshHost } : {}),
  };

  const defaultCwd =
    raw.defaultCwd ||
    raw.workspace?.defaultWorkdir ||
    process.cwd();

  const defaultPolicy =
    raw.defaultPolicy ||
    raw.reinPolicy ||
    'parent-rein';

  const defaultSessionMode =
    raw.defaultSessionMode ||
    'persistent';

  const description =
    raw.description ||
    raw.label ||
    '';

  const tmuxSession =
    raw.tmuxSession ||
    driverObj?.tmuxPrefix ||
    undefined;

  return {
    ...raw,
    id,
    kind,
    driver,
    command,
    args,
    transport,
    defaultCwd,
    defaultPolicy,
    defaultSessionMode,
    description,
    ...(tmuxSession ? { tmuxSession } : {}),
  };
}

/**
 * Converts either a map or an array of target entries into a normalized target map.
 *
 * @param {object | Array<object>} rawTargets
 * @returns {Record<string, object>}
 */
export function normalizeTargetsMap(rawTargets) {
  const result = {};

  for (const [id, def] of Object.entries(DEFAULT_CONFIG.targets)) {
    result[id] = normalizeTargetConfig(id, def);
  }

  if (Array.isArray(rawTargets)) {
    for (const item of rawTargets) {
      if (item && typeof item === 'object' && item.id) {
        result[item.id] = normalizeTargetConfig(item.id, item);
      }
    }
  } else if (rawTargets && typeof rawTargets === 'object') {
    for (const [id, item] of Object.entries(rawTargets)) {
      if (item && typeof item === 'object') {
        result[id] = normalizeTargetConfig(id, item);
      }
    }
  }

  return result;
}

/**
 * Loads the active Reins configuration from disk or falls back to `DEFAULT_CONFIG`.
 *
 * @param {string} [configPath]
 * @returns {{ config: object, configSource: string }}
 */
export function loadConfig(configPath) {
  const candidates = [
    configPath,
    process.env.REINS_CONFIG,
    path.resolve(process.cwd(), 'config', 'reins.yaml'),
    path.resolve(process.cwd(), 'config', 'reins.json'),
    expandHome('~/.reins/config.yaml'),
    expandHome('~/.reins/config.json'),
    path.join(REPO_ROOT, 'config', 'reins.example.yaml'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = expandHome(candidate);
    if (fs.existsSync(resolved)) {
      const raw = fs.readFileSync(resolved, 'utf8');
      const parsed = resolved.endsWith('.json') ? JSON.parse(raw) : parseSimpleYaml(raw);
      const rawHub = parsed.hub || {};
      return {
        config: {
          version: parsed.version || DEFAULT_CONFIG.version,
          hub: {
            ...DEFAULT_CONFIG.hub,
            ...rawHub,
            maxHops: rawHub.maxHops ?? rawHub.loopGuard?.maxHops ?? DEFAULT_CONFIG.hub.maxHops,
          },
          targets: normalizeTargetsMap(parsed.targets),
        },
        configSource: resolved,
      };
    }
  }

  return {
    config: {
      version: DEFAULT_CONFIG.version,
      hub: { ...DEFAULT_CONFIG.hub },
      targets: normalizeTargetsMap(DEFAULT_CONFIG.targets),
    },
    configSource: 'builtin-defaults',
  };
}

/**
 * Registry of configured H2H targets.
 */
export class TargetRegistry {
  /**
   * @param {object} [options]
   * @param {string} [options.configPath]
   * @param {object} [options.configOverride]
   */
  constructor({ configPath, configOverride } = {}) {
    if (configOverride) {
      this.config = {
        ...configOverride,
        targets: normalizeTargetsMap(configOverride.targets),
      };
      this.configSource = 'override';
    } else {
      const loaded = loadConfig(configPath);
      this.config = loaded.config;
      this.configSource = loaded.configSource;
    }
  }

  /**
   * Returns a single target definition by ID, or throws if unknown.
   *
   * @param {string} targetId
   * @returns {object}
   */
  getTargetOrThrow(targetId) {
    const target = this.config.targets?.[targetId];
    if (!target) {
      const known = Object.keys(this.config.targets || {}).join(', ');
      throw new Error(`Unknown H2H target "${targetId}". Registered targets: ${known || '(none)'}`);
    }
    return {
      id: targetId,
      ...target,
    };
  }

  /**
   * Lists all registered H2H targets along with transport and binary resolution metadata.
   *
   * @returns {object[]}
   */
  listTargets() {
    const entries = Object.entries(this.config.targets || {});
    return entries.map(([id, target]) => {
      const transportType = target.transport?.type || 'local';
      let resolvedExecutable;
      let available = true;

      if (transportType === 'local') {
        resolvedExecutable = resolveExecutable(target.command || 'auto', target.kind);
        available = Boolean(
          resolvedExecutable &&
            (fs.existsSync(resolvedExecutable) || resolvedExecutable.includes(path.sep)),
        );
      }

      return {
        id,
        kind: target.kind || 'codex',
        driver: target.driver,
        transport: target.transport || { type: 'local' },
        defaultCwd: target.defaultCwd || process.cwd(),
        defaultPolicy: target.defaultPolicy || 'parent-rein',
        defaultSessionMode: target.defaultSessionMode || 'persistent',
        description: target.description || '',
        available,
        resolvedExecutable,
      };
    });
  }
}
