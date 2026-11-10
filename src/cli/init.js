/**
 * Reins Atomic Discovery & Skill Sync Primitives (for Agent-Guided Workflows)
 *
 * Provides pure, non-interactive atomic functions for calling AI agents:
 * - `discoverLocalHarnesses`: Detects installed local harnesses (`codex`, `antigravity`, `dsh`, `claude-code`)
 * - `discoverSshHosts`: Parses concrete SSH host aliases from `~/.ssh/config`
 * - `probeRemoteSshHost`: Probes a remote SSH host for `$HOME` and installed harness/tmux binaries
 * - `inspectExistingConfig`: Reads existing `~/.reins/config.yaml` local & remote target summary
 * - `syncLocalHarnessSkills`: Syncs `SKILL.md` into selected local harnesses' global skill directories
 *
 * All multi-turn interactive initialization flows (`/reins init` and first-run onboarding)
 * are hosted and adapted dynamically by the Agent in the chat dialog as described in `SKILL.md`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandHome,
  parseSimpleYaml,
} from '../hub/registry.js';
import {
  findOnPath,
  resolveWindowsAppxCodexPath,
} from '../transports/local.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Normalizes a file path to forward slashes for cross-platform config output.
 *
 * @param {string} p
 * @returns {string}
 */
export function toPosixDisplayPath(p) {
  if (!p || typeof p !== 'string') return p;
  return p.replace(/\\/g, '/');
}

/**
 * Atomic helper: auto-discovers installed local AI coding harnesses on the current machine.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.homedir]
 * @param {string} [options.platform]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(binary: string) => string | null} [options.findBinary]
 * @param {() => string | null} [options.findWindowsAppxCodex]
 * @returns {Array<object>}
 */
export function discoverLocalHarnesses(options = {}) {
  const cwd = toPosixDisplayPath(options.cwd || process.cwd());
  const home = options.homedir || os.homedir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const lookupBinary = options.findBinary || findOnPath;
  const lookupAppxCodex = options.findWindowsAppxCodex || resolveWindowsAppxCodexPath;

  // 1. OpenAI Codex (`local-codex`)
  const codexHome = path.join(home, '.codex');
  const codexHomeExists = fs.existsSync(codexHome);
  const codexOnPath = lookupBinary('codex');
  const codexAppx = !codexOnPath && platform === 'win32' ? lookupAppxCodex() : null;
  const codexBinary = codexOnPath || codexAppx || null;
  const codexDetected = Boolean(codexBinary);
  const codexSource = codexOnPath
    ? 'PATH'
    : codexAppx
      ? 'Windows Store Appx'
      : codexHomeExists
        ? '~/.codex exists (binary not found)'
        : 'not-found';

  // 2. Antigravity (`local-agy`)
  const agyHome = path.join(home, '.gemini', 'antigravity');
  const agyHomeExists = fs.existsSync(agyHome);
  const winAgyExe =
    platform === 'win32' && env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, 'Programs', 'antigravity', 'Antigravity.exe')
      : null;
  const agyOnPath = lookupBinary('agy');
  const agyBinary =
    agyOnPath ||
    (winAgyExe && fs.existsSync(winAgyExe) ? winAgyExe : null) ||
    null;
  const agyDetected = Boolean(agyBinary || agyHomeExists);
  const agyDriverMode = 'agy-cli';
  const agySource = agyOnPath
    ? 'PATH'
    : agyBinary
      ? 'App Install'
      : agyHomeExists
        ? '~/.gemini/antigravity'
        : 'not-found';

  // 3. DeepSeek Harness (`local-dsh`)
  const dshHome = path.join(home, '.dsh');
  const dshHomeExists = fs.existsSync(dshHome);
  const dshOnPath = lookupBinary('dsh');
  const npxOnPath = lookupBinary('npx');
  const dshDetected = Boolean(dshOnPath || (dshHomeExists && npxOnPath));
  const dshBinary = dshOnPath || (dshHomeExists && npxOnPath ? `${npxOnPath} (@deepseek-ai/dsh)` : null);
  const dshSource = dshOnPath
    ? 'PATH (dsh)'
    : dshHomeExists && npxOnPath
      ? '~/.dsh + npx @deepseek-ai/dsh'
      : npxOnPath
        ? 'npx available (not yet initialized in ~/.dsh)'
        : 'not-found';

  // 4. Claude Code (`local-claude`)
  const claudeHome = path.join(home, '.claude');
  const claudeHomeExists = fs.existsSync(claudeHome);
  const claudeOnPath = lookupBinary('claude');
  const claudeFallbackCandidates = [
    path.join(home, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude'),
    path.join(home, '.claude', 'local', platform === 'win32' ? 'claude.exe' : 'claude'),
    platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'npm', 'claude.cmd') : null,
  ].filter(Boolean);
  const claudeFallback = claudeFallbackCandidates.find((p) => fs.existsSync(p)) || null;
  const claudeBinary = claudeOnPath || claudeFallback || null;
  const claudeDetected = Boolean(claudeBinary);
  const claudeSource = claudeOnPath
    ? 'PATH'
    : claudeFallback
      ? 'Local bin'
      : claudeHomeExists
        ? '~/.claude exists (claude CLI not on PATH)'
        : 'not-found';

  return [
    {
      id: 'local-codex',
      kind: 'codex',
      label: 'Local OpenAI Codex (app-server)',
      detected: codexDetected,
      binaryPath: codexBinary,
      homeDir: codexHome,
      homeExists: codexHomeExists,
      detectionSource: codexSource,
      suggestedTarget: {
        id: 'local-codex',
        label: 'Local OpenAI Codex (app-server)',
        harnessType: 'codex',
        transport: { kind: 'local' },
        driver: {
          mode: 'codex-app-server',
          command: 'auto',
          args: ['app-server', '--stdio'],
        },
        workspace: {
          defaultWorkdir: cwd,
          allowedSyncModes: ['remote-native', 'context-only'],
        },
        reinPolicy: 'auto-edit',
        tags: ['coding', 'review', 'adversarial-review', 'rescue'],
      },
    },
    {
      id: 'local-agy',
      kind: 'antigravity',
      label: 'Local Antigravity (AGY)',
      detected: agyDetected,
      binaryPath: agyBinary,
      homeDir: agyHome,
      homeExists: agyHomeExists,
      detectionSource: agySource,
      suggestedTarget: {
        id: 'local-agy',
        label: 'Local Antigravity (AGY)',
        harnessType: 'antigravity',
        transport: { kind: 'local' },
        driver: {
          mode: agyDriverMode,
          command: 'auto',
          args: [],
        },
        model: 'flash_lite',
        workspace: {
          defaultWorkdir: cwd,
          allowedSyncModes: ['remote-native', 'context-only'],
        },
        reinPolicy: 'parent-rein',
        tags: ['coding', 'planning', 'orchestration'],
      },
    },
    {
      id: 'local-dsh',
      kind: 'dsh',
      label: 'Local DeepSeek Harness (ACP)',
      detected: dshDetected,
      binaryPath: dshBinary,
      homeDir: dshHome,
      homeExists: dshHomeExists,
      detectionSource: dshSource,
      suggestedTarget: {
        id: 'local-dsh',
        label: 'Local DeepSeek Harness (ACP)',
        harnessType: 'dsh',
        transport: { kind: 'local' },
        driver: {
          mode: 'acp',
          command: dshOnPath ? 'dsh' : 'npx',
          args: dshOnPath ? ['--profile', 'acp'] : ['@deepseek-ai/dsh', '--profile', 'acp'],
        },
        workspace: {
          defaultWorkdir: cwd,
          allowedSyncModes: ['remote-native', 'context-only'],
        },
        reinPolicy: 'parent-rein',
        tags: ['coding', 'automation', 'plugin-dev'],
      },
    },
    {
      id: 'local-claude',
      kind: 'claude-code',
      label: 'Local Claude Code CLI',
      detected: claudeDetected,
      binaryPath: claudeBinary,
      homeDir: claudeHome,
      homeExists: claudeHomeExists,
      detectionSource: claudeSource,
      suggestedTarget: {
        id: 'local-claude',
        label: 'Local Claude Code CLI (tmux)',
        harnessType: 'claude-code',
        transport: { kind: 'local' },
        driver: {
          mode: 'claude-tmux',
          command: 'auto',
          tmuxPrefix: 'reins-cc',
          args: [],
        },
        workspace: {
          defaultWorkdir: cwd,
          allowedSyncModes: ['remote-native', 'context-only'],
        },
        reinPolicy: 'parent-rein',
        tags: ['coding', 'architecture', 'code-review'],
      },
    },
  ];
}

/**
 * Atomic helper: discovers concrete SSH host aliases from `~/.ssh/config`.
 *
 * @param {string} [sshConfigPath]
 * @returns {Array<{ alias: string, hostName?: string, user?: string, port?: number }>}
 */
export function discoverSshHosts(sshConfigPath = expandHome('~/.ssh/config')) {
  if (!sshConfigPath || !fs.existsSync(sshConfigPath)) {
    return [];
  }
  let text = '';
  try {
    text = fs.readFileSync(sshConfigPath, 'utf8');
  } catch {
    return [];
  }

  const hosts = [];
  let currentEntries = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const cleaned = rawLine.replace(/#.*$/, '').trim();
    if (!cleaned) continue;
    const match = cleaned.match(/^([A-Za-z0-9]+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const val = match[2].trim();

    if (key === 'host') {
      const patterns = val
        .split(/\s+/)
        .filter((p) => p && !p.includes('*') && !p.includes('?') && !p.startsWith('!'));
      currentEntries = patterns.map((alias) => {
        const entry = { alias };
        hosts.push(entry);
        return entry;
      });
    } else if (currentEntries.length > 0) {
      if (key === 'hostname') {
        for (const e of currentEntries) e.hostName = val;
      } else if (key === 'user') {
        for (const e of currentEntries) e.user = val;
      } else if (key === 'port') {
        const p = Number.parseInt(val, 10);
        if (Number.isInteger(p)) {
          for (const e of currentEntries) e.port = p;
        }
      }
    }
  }

  return hosts;
}

/**
 * Atomic helper: probes a remote SSH host in BatchMode to detect `$HOME` and
 * installed harness/tmux binaries (`claude`, `dsh`, `codex`, `agy`, `tmux`).
 *
 * @param {string} sshHost
 * @param {object} [options]
 * @param {number} [options.timeoutSec=6]
 * @returns {{ sshHost: string, ok: boolean, home?: string, binaries?: Record<string, string>, tmux?: string | null, error?: string }}
 */
export function probeRemoteSshHost(sshHost, { timeoutSec = 6 } = {}) {
  if (!sshHost || typeof sshHost !== 'string' || sshHost.startsWith('-') || /\s/.test(sshHost)) {
    return { sshHost: String(sshHost || ''), ok: false, error: 'Invalid SSH host' };
  }
  const probeScript = [
    'export PATH="$HOME/.local/bin:$HOME/n/bin:$HOME/.nvm/current/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"',
    'echo "HOME=$HOME"',
    'for bin in claude dsh codex agy tmux; do',
    '  p=$(command -v "$bin" 2>/dev/null || true)',
    '  if [ -n "$p" ]; then echo "BIN_$bin=$p"; fi',
    'done',
  ].join('; ');

  const res = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeoutSec}`, sshHost, probeScript],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: (timeoutSec + 2) * 1000,
    },
  );

  if (res.status !== 0) {
    const errText = (res.stderr || res.error?.message || 'SSH probe failed').trim();
    return { sshHost, ok: false, error: errText };
  }

  const binaries = {};
  let home = '/workspace';
  for (const line of String(res.stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('HOME=')) {
      home = trimmed.slice(5).trim() || home;
    } else if (trimmed.startsWith('BIN_')) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 4) {
        const name = trimmed.slice(4, eqIdx);
        const val = trimmed.slice(eqIdx + 1).trim();
        if (val) binaries[name] = val;
      }
    }
  }

  return {
    sshHost,
    ok: true,
    home,
    binaries,
    tmux: binaries.tmux || null,
  };
}

/**
 * Atomic helper: inspects an existing Reins configuration file (if present) and splits
 * its targets into local vs. remote SSH targets.
 *
 * @param {string} [configPath='~/.reins/config.yaml']
 * @returns {{ exists: boolean, path: string, parsed: object | null, localTargets: object[], remoteTargets: object[] }}
 */
export function inspectExistingConfig(configPath = '~/.reins/config.yaml') {
  const resolved = expandHome(configPath);
  if (!resolved || !fs.existsSync(resolved)) {
    return {
      exists: false,
      path: resolved,
      parsed: null,
      localTargets: [],
      remoteTargets: [],
    };
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = resolved.endsWith('.json') ? JSON.parse(raw) : parseSimpleYaml(raw);
    const rawTargets = parsed?.targets;
    const targetList = [];

    if (Array.isArray(rawTargets)) {
      for (const item of rawTargets) {
        if (item && typeof item === 'object' && item.id) {
          targetList.push(item);
        }
      }
    } else if (rawTargets && typeof rawTargets === 'object') {
      for (const [id, item] of Object.entries(rawTargets)) {
        if (item && typeof item === 'object') {
          targetList.push({ id, ...item });
        }
      }
    }

    const localTargets = [];
    const remoteTargets = [];
    for (const t of targetList) {
      const transportKind = t.transport?.kind || t.transport?.type || 'local';
      if (transportKind === 'ssh') {
        remoteTargets.push(t);
      } else {
        localTargets.push(t);
      }
    }

    return {
      exists: true,
      path: resolved,
      parsed,
      localTargets,
      remoteTargets,
    };
  } catch {
    return {
      exists: true,
      path: resolved,
      parsed: null,
      localTargets: [],
      remoteTargets: [],
    };
  }
}

/**
 * Atomic helper: installs/syncs `skills/reins/SKILL.md` into the user-global skill
 * directories of the specified local harnesses (`antigravity`, `codex`, `dsh`, `claude-code`).
 *
 * @param {Array<string | object>} [targetsOrKinds]
 * @param {object} [options]
 * @param {string} [options.homedir]
 * @returns {string[]} Paths of synced SKILL.md files
 */
export function syncLocalHarnessSkills(
  targetsOrKinds = ['antigravity', 'codex', 'dsh', 'claude-code'],
  { homedir = os.homedir() } = {},
) {
  const canonicalSkillPath = path.join(REPO_ROOT, 'skills', 'reins', 'SKILL.md');
  if (!fs.existsSync(canonicalSkillPath)) return [];

  const cliEntryPosix = toPosixDisplayPath(path.join(REPO_ROOT, 'src', 'index.js'));
  const rawSkill = fs.readFileSync(canonicalSkillPath, 'utf8');
  const globalSkillContent = rawSkill.replace(
    /node \.\/src\/index\.js/g,
    `node ${cliEntryPosix}`,
  );

  const skillPathByKind = {
    antigravity: path.join(homedir, '.gemini', 'config', 'skills', 'reins', 'SKILL.md'),
    'local-agy': path.join(homedir, '.gemini', 'config', 'skills', 'reins', 'SKILL.md'),
    agy: path.join(homedir, '.gemini', 'config', 'skills', 'reins', 'SKILL.md'),
    codex: path.join(homedir, '.codex', 'skills', 'reins', 'SKILL.md'),
    'local-codex': path.join(homedir, '.codex', 'skills', 'reins', 'SKILL.md'),
    dsh: path.join(homedir, '.dsh', 'skills', 'reins', 'SKILL.md'),
    'local-dsh': path.join(homedir, '.dsh', 'skills', 'reins', 'SKILL.md'),
    'claude-code': path.join(homedir, '.claude', 'skills', 'reins', 'SKILL.md'),
    'local-claude': path.join(homedir, '.claude', 'skills', 'reins', 'SKILL.md'),
    claude: path.join(homedir, '.claude', 'skills', 'reins', 'SKILL.md'),
  };

  const synced = [];
  const seen = new Set();
  for (const item of targetsOrKinds) {
    const key =
      typeof item === 'string'
        ? item.trim().toLowerCase()
        : (item?.kind || item?.harnessType || item?.id || '').toLowerCase();
    const dest = skillPathByKind[key];
    if (!dest || seen.has(dest)) continue;
    seen.add(dest);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, globalSkillContent, 'utf8');
      synced.push(dest);
    } catch {
      // Ignore non-writable paths.
    }
  }
  return synced;
}

/**
 * Builds the complete atomic discovery snapshot for an Agent to host the initialization
 * or configuration flow in the chat dialog.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.configPath='~/.reins/config.yaml']
 * @param {Array<object>} [options.discoveredHarnesses]
 * @param {Array<object>} [options.discoveredSshHosts]
 * @returns {object}
 */
export function buildAtomicDiscoverySnapshot({
  cwd = process.cwd(),
  homedir = os.homedir(),
  configPath = '~/.reins/config.yaml',
  sshConfigPath,
  discoveredHarnesses,
  discoveredSshHosts,
} = {}) {
  const localHarnesses = discoveredHarnesses || discoverLocalHarnesses({ cwd, homedir });
  const sshHosts =
    discoveredSshHosts ||
    discoverSshHosts(sshConfigPath || path.join(homedir, '.ssh', 'config'));
  const existing = inspectExistingConfig(configPath);

  return {
    initialized: existing.exists,
    configPath: existing.path,
    existingLocalTargets: existing.localTargets,
    existingRemoteTargets: existing.remoteTargets,
    localHarnesses,
    sshHosts,
  };
}
