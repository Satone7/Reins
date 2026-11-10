import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const logPath = process.env.MOCK_TMUX_LOG;
const sessionPathEnv = process.env.MOCK_TMUX_SESSION;
const stateDir = sessionPathEnv
  ? path.dirname(sessionPathEnv)
  : logPath
    ? path.dirname(logPath)
    : path.join(os.tmpdir(), 'reins-mock-tmux-default');

fs.mkdirSync(stateDir, { recursive: true });

if (logPath) {
  fs.appendFileSync(logPath, `${JSON.stringify(args)}\n`, 'utf8');
}

function parseSingleQuotedPosixWords(cmdString = '') {
  // Strip any leading `cd '...' && ` or `export ... && `
  const segments = String(cmdString).split(' && ');
  const lastSegment = segments[segments.length - 1] || '';
  const tokens = [];
  const regex = /'((?:[^']|'"'"')*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(lastSegment)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1].replaceAll(`'"'"'`, "'"));
    } else if (match[2] !== undefined) {
      tokens.push(match[2]);
    }
  }
  return tokens;
}

function normalizeTargetName(rawTarget = '') {
  return String(rawTarget).replace(/^=/, '').replace(/:$/, '');
}

function sessionStateFile(targetName) {
  const clean = normalizeTargetName(targetName);
  if (sessionPathEnv && !fs.existsSync(path.join(stateDir, `${clean}.session.json`))) {
    // Also mirror to MOCK_TMUX_SESSION for tests that inspect its existence
  }
  return path.join(stateDir, `${clean}.session.json`);
}

function loadSession(targetName) {
  const file = sessionStateFile(targetName);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (sessionPathEnv && fs.existsSync(sessionPathEnv)) {
    try {
      return JSON.parse(fs.readFileSync(sessionPathEnv, 'utf8'));
    } catch {
      return { name: normalizeTargetName(targetName), pane: 'Claude Code v2.1.302\n❯ \n  ⏸ manual mode on\n' };
    }
  }
  return null;
}

function saveSession(targetName, data) {
  const file = sessionStateFile(targetName);
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(file, text, 'utf8');
  if (sessionPathEnv) {
    fs.writeFileSync(sessionPathEnv, text, 'utf8');
  }
}

function removeSession(targetName) {
  const file = sessionStateFile(targetName);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  if (sessionPathEnv && fs.existsSync(sessionPathEnv)) fs.unlinkSync(sessionPathEnv);
}

const subcmd = args[0];

if (subcmd === 'has-session') {
  const tIdx = args.indexOf('-t');
  const target = tIdx >= 0 ? args[tIdx + 1] : '';
  const session = loadSession(target);
  process.exit(session ? 0 : 1);
}

if (subcmd === 'new-session') {
  const sIdx = args.indexOf('-s');
  const cIdx = args.indexOf('-c');
  const name = sIdx >= 0 ? args[sIdx + 1] : 'reins-cc';
  const cwd = cIdx >= 0 ? args[cIdx + 1] : process.cwd();
  const claudeCommand = args.at(-1) || '';
  const tokens = parseSingleQuotedPosixWords(claudeCommand);
  if (tokens.includes('-p') || tokens.includes('--print')) {
    process.stderr.write('Mock tmux rejected forbidden `claude -p` / `--print` flag!\n');
    process.exit(2);
  }
  if (process.env.MOCK_CLAUDE_LOG && tokens.length > 1) {
    // Log the arguments passed to the claude script (excluding node executable and script path if node)
    const scriptArgs =
      tokens[1] && tokens[1].endsWith('.mjs') ? tokens.slice(2) : tokens.slice(1);
    fs.appendFileSync(process.env.MOCK_CLAUDE_LOG, `${JSON.stringify(scriptArgs)}\n`, 'utf8');
  }
  const initialPane =
    process.env.MOCK_CLAUDE_SCENARIO === 'dead-on-start'
      ? 'Claude Code failed to start\nPane is dead (status 1)\n'
      : 'Claude Code v2.1.302\n❯ \n  ⏸ manual mode on · /effort\n';
  saveSession(name, {
    name,
    cwd,
    claudeCommand,
    tokens,
    pane: initialPane,
    pendingPrompt: '',
    awaitingPermission: false,
  });
  process.exit(0);
}

if (subcmd === 'set-option') {
  process.exit(0);
}

if (subcmd === 'capture-pane') {
  const tIdx = args.indexOf('-t');
  const target = tIdx >= 0 ? args[tIdx + 1] : '';
  const session = loadSession(target);
  if (!session) {
    process.stderr.write(`can't find session: ${target}\n`);
    process.exit(1);
  }
  process.stdout.write(session.pane || 'Claude Code v2.1.302\n❯ \n  ⏸ manual mode on\n');
  process.exit(0);
}

if (subcmd === 'load-buffer') {
  const bIdx = args.indexOf('-b');
  const bufName = bIdx >= 0 ? args[bIdx + 1] : 'default';
  const filePath = args.at(-1);
  const content = fs.readFileSync(filePath, 'utf8');
  fs.writeFileSync(path.join(stateDir, `buf-${bufName}.txt`), content, 'utf8');
  process.exit(0);
}

if (subcmd === 'paste-buffer') {
  const bIdx = args.indexOf('-b');
  const tIdx = args.indexOf('-t');
  const bufName = bIdx >= 0 ? args[bIdx + 1] : 'default';
  const target = tIdx >= 0 ? args[tIdx + 1] : '';
  const bufFile = path.join(stateDir, `buf-${bufName}.txt`);
  const content = fs.existsSync(bufFile) ? fs.readFileSync(bufFile, 'utf8') : '';
  const session = loadSession(target);
  if (!session) {
    process.stderr.write(`can't find session: ${target}\n`);
    process.exit(1);
  }
  session.pendingPrompt = content;
  saveSession(target, session);
  process.exit(0);
}

if (subcmd === 'delete-buffer') {
  const bIdx = args.indexOf('-b');
  const bufName = bIdx >= 0 ? args[bIdx + 1] : 'default';
  const bufFile = path.join(stateDir, `buf-${bufName}.txt`);
  if (fs.existsSync(bufFile)) fs.unlinkSync(bufFile);
  process.exit(0);
}

if (subcmd === 'send-keys') {
  const tIdx = args.indexOf('-t');
  const target = tIdx >= 0 ? args[tIdx + 1] : '';
  const key = args.at(-1);
  const session = loadSession(target);
  if (!session) {
    process.stderr.write(`can't find session: ${target}\n`);
    process.exit(1);
  }

  const tokens = Array.isArray(session.tokens) ? session.tokens : [];
  const exe = tokens[0] || process.execPath;
  const baseArgs = tokens.slice(1);

  if (key === 'Enter' && session.awaitingPermission) {
    session.awaitingPermission = false;
    session.pane = 'Claude Code v2.1.302\n❯ \n  ⏸ manual mode on\n';
    saveSession(target, session);
    if (tokens.length > 0) {
      spawnSync(exe, [...baseArgs, '--tmux-permission-decision', 'approve'], {
        cwd: session.cwd || process.cwd(),
        env: process.env,
        windowsHide: true,
      });
    }
    process.exit(0);
  }

  if (key === 'Escape') {
    session.awaitingPermission = false;
    session.pane = 'Claude Code v2.1.302\n❯ \n  ⏸ manual mode on\n';
    saveSession(target, session);
    if (tokens.length > 0) {
      spawnSync(exe, [...baseArgs, '--tmux-permission-decision', 'reject'], {
        cwd: session.cwd || process.cwd(),
        env: process.env,
        windowsHide: true,
      });
    }
    process.exit(0);
  }

  if (key === 'Enter' && session.pendingPrompt) {
    const promptText = session.pendingPrompt;
    session.pendingPrompt = '';
    if (process.env.MOCK_CLAUDE_SCENARIO === 'permission') {
      session.awaitingPermission = true;
      session.pane = [
        'Claude Code v2.1.302',
        'Bash(rm -rf /tmp/reins-test)',
        'Do you want to proceed?',
        '❯ 1. Yes',
        '  2. Yes, and don\'t ask again',
        '  3. No',
        'Esc to cancel · Enter to confirm',
      ].join('\n');
    } else if (process.env.MOCK_CLAUDE_SCENARIO === 'hang') {
      session.pane = 'Claude Code v2.1.302\n✻ Thinking… (esc to interrupt)\n';
    } else {
      session.pane = 'Claude Code v2.1.302\n❯ \n  ⏸ manual mode on\n';
    }
    saveSession(target, session);

    if (tokens.length > 0) {
      spawnSync(exe, [...baseArgs, '--tmux-turn-prompt', promptText], {
        cwd: session.cwd || process.cwd(),
        env: process.env,
        windowsHide: true,
      });
    }
    process.exit(0);
  }

  process.exit(0);
}

if (subcmd === 'kill-session') {
  const tIdx = args.indexOf('-t');
  const target = tIdx >= 0 ? args[tIdx + 1] : '';
  removeSession(target);
  process.exit(0);
}

process.stderr.write(`Unexpected tmux command: ${args.join(' ')}\n`);
process.exit(2);
