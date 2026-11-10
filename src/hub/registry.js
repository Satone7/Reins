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
 * Loads environment variables from a `.env` file into `process.env` without
 * overwriting already-defined environment variables.
 *
 * @param {string} [envPath]
 * @returns {Record<string, string>}
 */
export function loadEnvFile(envPath = path.join(REPO_ROOT, '.env')) {
  const loaded = {};
  if (!envPath || !fs.existsSync(envPath)) return loaded;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cleaned = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eqIdx = cleaned.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = cleaned.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const commentIdx = value.search(/\s+#/);
      if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
    }
    loaded[key] = value;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return loaded;
}

/**
 * Default built-in configuration used when no user config file is present.
 * Contains only vendor-neutral local targets; host-specific or remote SSH targets
 * belong in `~/.reins/config.yaml` or environment-specific config files.
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
      driver: 'agentapi',
      transport: { type: 'local' },
      command: 'auto',
      args: [],
      model: 'flash_lite',
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
      model: 'deepseek-flash',
      defaultCwd: process.cwd(),
      defaultPolicy: 'parent-rein',
      defaultSessionMode: 'persistent',
      description: 'Local DeepSeek Harness (ACP)',
    },
    'local-claude': {
      id: 'local-claude',
      kind: 'claude-code',
      driver: 'claude-print',
      transport: { type: 'local' },
      command: 'auto',
      args: [],
      defaultCwd: process.cwd(),
      defaultPolicy: 'parent-rein',
      defaultSessionMode: 'persistent',
      description: 'Local Claude Code CLI',
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

  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i];
    const cleaned = stripInlineComment(rawLine);
    if (!cleaned.trim()) continue;
    const indent = cleaned.match(/^ */)[0].length;
    const content = cleaned.trim();

    // Support YAML literal/folded block scalars (`|`, `|-`, `>`, `>-`)
    const blockMatch = content.match(/^(-?\s*[A-Za-z0-9_.-]+\s*):\s*([|>][-+]?)$/);
    if (blockMatch) {
      const keyPrefix = blockMatch[1];
      const blockStyle = blockMatch[2];
      const blockLines = [];
      let j = i + 1;
      while (j < rawLines.length) {
        const nextRaw = rawLines[j];
        if (!nextRaw.trim()) {
          blockLines.push({ empty: true, indent: Infinity, raw: '' });
          j += 1;
          continue;
        }
        const nextIndent = nextRaw.match(/^ */)[0].length;
        if (nextIndent <= indent) break;
        blockLines.push({ empty: false, indent: nextIndent, raw: nextRaw });
        j += 1;
      }
      // Trim trailing blank lines inside block scalar
      while (blockLines.length > 0 && blockLines[blockLines.length - 1].empty) {
        blockLines.pop();
      }
      const nonEmptyIndents = blockLines.filter((b) => !b.empty).map((b) => b.indent);
      const minBlockIndent = nonEmptyIndents.length > 0 ? Math.min(...nonEmptyIndents) : indent + 2;
      const strippedLines = blockLines.map((b) =>
        b.empty ? '' : b.raw.slice(minBlockIndent).trimEnd(),
      );
      const blockValue = blockStyle.startsWith('>')
        ? strippedLines.join('\n').replace(/([^\n])\n([^\n])/g, '$1 $2').trim()
        : strippedLines.join('\n');
      lines.push({
        indent,
        content: `${keyPrefix}:`,
        hasBlockValue: true,
        blockValue,
      });
      i = j - 1;
      continue;
    }

    lines.push({ indent, content });
  }

  function parseMapEntries(startIndex, minIndent) {
    const obj = {};
    let idx = startIndex;

    while (idx < lines.length && lines[idx].indent >= minIndent) {
      const line = lines[idx];
      const { indent, content } = line;
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

      if (line.hasBlockValue) {
        obj[key] = line.blockValue;
        idx += 1;
      } else if (rest) {
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
        const currentLine = lines[idx];
        const itemText = currentLine.content.slice(2).trim();
        const isQuotedScalar =
          (itemText.startsWith('"') && itemText.endsWith('"')) ||
          (itemText.startsWith("'") && itemText.endsWith("'"));
        const colonIdx = isQuotedScalar ? -1 : itemText.indexOf(':');
        const candidateKey = colonIdx !== -1 ? itemText.slice(0, colonIdx).trim() : '';
        const isObjectEntry = colonIdx !== -1 && /^[A-Za-z0-9_.-]+$/.test(candidateKey);

        if (isObjectEntry) {
          // List of objects (`- key: value` followed by indented fields)
          const itemObj = {};
          const firstKey = parseYamlScalar(candidateKey);
          const firstRest = itemText.slice(colonIdx + 1).trim();
          idx += 1;
          if (currentLine.hasBlockValue) {
            itemObj[firstKey] = currentLine.blockValue;
          } else if (firstRest) {
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
 * Normalizes target-level caller usage rules / prompt instructions (`rules`, `usageRules`,
 * `callerRules`, or `instructions`) into a clean multi-line prompt string.
 *
 * @param {object} raw
 * @returns {string | undefined}
 */
export function normalizeTargetRules(raw = {}) {
  const rawRules =
    raw.rules ??
    raw.usageRules ??
    raw.callerRules ??
    raw.instructions ??
    raw.callerPrompt;

  if (typeof rawRules === 'string') {
    const trimmed = rawRules.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(rawRules)) {
    const lines = rawRules
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    return lines.length > 0 ? lines.join('\n') : undefined;
  }
  return undefined;
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
    driverObj?.tmuxSession ||
    undefined;
  const tmuxPrefix =
    raw.tmuxPrefix ||
    driverObj?.tmuxPrefix ||
    undefined;
  const model =
    raw.model ||
    raw.defaultModel ||
    driverObj?.model ||
    driverObj?.defaultModel ||
    undefined;
  const effort =
    raw.effort ||
    raw.defaultEffort ||
    raw.reasoningEffort ||
    driverObj?.effort ||
    driverObj?.defaultEffort ||
    driverObj?.reasoningEffort ||
    undefined;
  const rules = normalizeTargetRules(raw);

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
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(tmuxSession ? { tmuxSession } : {}),
    ...(tmuxPrefix ? { tmuxPrefix } : {}),
    ...(rules ? { rules } : {}),
  };
}

/**
 * Converts either a map or an array of target entries into a normalized target map,
 * optionally merging global caller rules (`hub.rules` or top-level `rules`) into each target.
 *
 * @param {object | Array<object>} rawTargets
 * @param {string} [globalRules]
 * @returns {Record<string, object>}
 */
export function normalizeTargetsMap(rawTargets, globalRules) {
  const result = {};

  function applyGlobalRules(target) {
    if (!globalRules) return target;
    const combinedRules = target.rules
      ? `${globalRules}\n${target.rules}`
      : globalRules;
    return { ...target, rules: combinedRules };
  }

  for (const [id, def] of Object.entries(DEFAULT_CONFIG.targets)) {
    result[id] = applyGlobalRules(normalizeTargetConfig(id, def));
  }

  if (Array.isArray(rawTargets)) {
    for (const item of rawTargets) {
      if (item && typeof item === 'object' && item.id) {
        result[item.id] = applyGlobalRules(normalizeTargetConfig(item.id, item));
      }
    }
  } else if (rawTargets && typeof rawTargets === 'object') {
    for (const [id, item] of Object.entries(rawTargets)) {
      if (item && typeof item === 'object') {
        result[id] = applyGlobalRules(normalizeTargetConfig(id, item));
      }
    }
  }

  return result;
}

/**
 * Loads the active Reins configuration from disk or falls back to `DEFAULT_CONFIG`.
 *
 * @param {string} [configPath]
 * @param {object} [options]
 * @param {boolean} [options.ignoreUserConfig]
 * @returns {{ config: object, configSource: string }}
 */
export function loadConfig(configPath, options = {}) {
  loadEnvFile();
  const skipUserConfig =
    options.ignoreUserConfig === true || process.env.REINS_IGNORE_USER_CONFIG === '1';

  const candidates = [
    configPath,
    process.env.REINS_CONFIG,
    !skipUserConfig ? path.resolve(process.cwd(), 'config', 'reins.yaml') : null,
    !skipUserConfig ? path.resolve(process.cwd(), 'config', 'reins.json') : null,
    !skipUserConfig ? expandHome('~/.reins/config.yaml') : null,
    !skipUserConfig ? expandHome('~/.reins/config.json') : null,
    path.join(REPO_ROOT, 'config', 'reins.example.yaml'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = expandHome(candidate);
    if (fs.existsSync(resolved)) {
      const raw = fs.readFileSync(resolved, 'utf8');
      const parsed = resolved.endsWith('.json') ? JSON.parse(raw) : parseSimpleYaml(raw);
      const rawHub = parsed.hub || {};
      const globalRules = normalizeTargetRules(parsed) || normalizeTargetRules(rawHub);
      return {
        config: {
          version: parsed.version || DEFAULT_CONFIG.version,
          hub: {
            ...DEFAULT_CONFIG.hub,
            ...rawHub,
            maxHops: rawHub.maxHops ?? rawHub.loopGuard?.maxHops ?? DEFAULT_CONFIG.hub.maxHops,
            ...(globalRules ? { rules: globalRules } : {}),
          },
          targets: normalizeTargetsMap(parsed.targets, globalRules),
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
   * @param {boolean} [options.ignoreUserConfig]
   */
  constructor({ configPath, configOverride, ignoreUserConfig } = {}) {
    loadEnvFile();
    if (configOverride) {
      const globalRules =
        normalizeTargetRules(configOverride) || normalizeTargetRules(configOverride.hub || {});
      this.config = {
        ...configOverride,
        targets: normalizeTargetsMap(configOverride.targets, globalRules),
      };
      this.configSource = 'override';
    } else {
      const loaded = loadConfig(configPath, { ignoreUserConfig });
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
        ...(target.model ? { model: target.model } : {}),
        ...(target.effort ? { effort: target.effort } : {}),
        description: target.description || '',
        ...(target.rules ? { rules: target.rules } : {}),
        available,
        resolvedExecutable,
      };
    });
  }
}
