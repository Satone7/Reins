import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);

if (args.includes('-p') || args.includes('--print') || args.includes('--output-format')) {
  process.stderr.write('Error: claude -p / --print / --output-format is strictly forbidden.\n');
  process.exit(2);
}

function projectSlug(workdir) {
  return String(workdir || '').replace(/[^A-Za-z0-9]/g, '-');
}

function resolveTranscriptFile(cwd, sessionId) {
  const claudeDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.claude');
  const dir = path.join(claudeDir, 'projects', projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

const resumeIdx = args.indexOf('--resume');
const sessionIdIdx = args.indexOf('--session-id');
const sessionId =
  resumeIdx >= 0
    ? args[resumeIdx + 1]
    : sessionIdIdx >= 0
      ? args[sessionIdIdx + 1]
      : 'claude_mock_12345678';

const promptIdx = args.indexOf('--tmux-turn-prompt');
const decisionIdx = args.indexOf('--tmux-permission-decision');
const cwd = process.cwd();
const transcriptPath = resolveTranscriptFile(cwd, sessionId);

if (decisionIdx >= 0) {
  const decision = args[decisionIdx + 1];
  if (decision === 'approve') {
    appendJsonl(transcriptPath, {
      type: 'user',
      uuid: crypto.randomUUID(),
      sessionId,
      cwd,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_perm_1',
            content: 'Permission granted and command succeeded.',
          },
        ],
      },
    });
    appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      sessionId,
      cwd,
      costUSD: 0.012,
      message: {
        model: 'sonnet',
        role: 'assistant',
        usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 2 },
        content: [{ type: 'text', text: 'Approved final reply' }],
      },
    });
    appendJsonl(transcriptPath, {
      type: 'system',
      uuid: crypto.randomUUID(),
      sessionId,
      subtype: 'turn_duration',
      durationMs: 123,
    });
  } else {
    appendJsonl(transcriptPath, {
      type: 'user',
      uuid: crypto.randomUUID(),
      sessionId,
      cwd,
      message: {
        role: 'user',
        content: '[Request interrupted by user for tool use]',
      },
    });
  }
  process.exit(0);
}

const promptText = promptIdx >= 0 ? args[promptIdx + 1] : 'Interactive prompt';
const scenario = process.env.MOCK_CLAUDE_SCENARIO || 'normal';

appendJsonl(transcriptPath, {
  type: 'user',
  uuid: crypto.randomUUID(),
  sessionId,
  cwd,
  origin: { kind: 'human' },
  message: {
    role: 'user',
    content: promptText,
  },
});

if (scenario === 'permission') {
  appendJsonl(transcriptPath, {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    sessionId,
    cwd,
    message: {
      model: 'sonnet',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Checking permissions first' },
        {
          type: 'tool_use',
          id: 'tool_perm_1',
          name: 'Bash',
          input: { command: 'rm -rf /tmp/reins-test' },
        },
      ],
    },
  });
  process.exit(0);
}

if (scenario === 'hang') {
  appendJsonl(transcriptPath, {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    sessionId,
    cwd,
    message: {
      model: 'sonnet',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Working on long running step' }],
    },
  });
  process.exit(0);
}

appendJsonl(transcriptPath, {
  type: 'assistant',
  uuid: crypto.randomUUID(),
  sessionId,
  cwd,
  costUSD: 0.012,
  message: {
    model: 'sonnet',
    role: 'assistant',
    usage: { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 1 },
    content: [
      { type: 'thinking', thinking: 'Analyzing repository context' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: 'README.md' } },
      { type: 'text', text: 'Final reply' },
    ],
  },
});

appendJsonl(transcriptPath, {
  type: 'system',
  uuid: crypto.randomUUID(),
  sessionId,
  subtype: 'turn_duration',
  durationMs: 123,
});
