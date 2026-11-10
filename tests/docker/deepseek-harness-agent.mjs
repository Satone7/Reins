#!/usr/bin/env node
/**
 * Unified DeepSeek-backed Harness Test Agent for Reins Docker & E2E Verification.
 *
 * Speaks the wire protocols of DSH (`--profile headless --json` and `--profile acp`)
 * and interactive Claude Code (`--session-id <id>` / `--resume <id>` inside `tmux` with
 * `~/.claude/projects/<slug>/<sessionId>.jsonl` transcript output), routing all LLM turns
 * to `deepseek-flash` via `DEEPSEEK_API_KEY`.
 */

import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

dns.setDefaultResultOrder('ipv4first');

const SESSION_DIR = path.join(os.tmpdir(), 'reins-deepseek-test-sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

function loadHistory(sessionId) {
  const file = path.join(SESSION_DIR, `${sessionId}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function saveHistory(sessionId, messages) {
  const file = path.join(SESSION_DIR, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(messages, null, 2), 'utf8');
}

function projectSlug(workdir) {
  return String(workdir || '').replace(/[^A-Za-z0-9]/g, '-');
}

function resolveClaudeTranscriptPath(cwd, sessionId) {
  const claudeDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.claude');
  const dir = path.join(claudeDir, 'projects', projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}

function appendTranscriptRecord(filePath, record) {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function callDeepSeekFlash(messages, requestedModel) {
  const apiKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'Missing DEEPSEEK_API_KEY environment variable. Please copy `.env.example` to `.env` and set DEEPSEEK_API_KEY before running tests.',
    );
  }
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model =
    requestedModel ||
    process.env.DEEPSEEK_MODEL ||
    process.env.REINS_TEST_MODEL ||
    'deepseek-flash';

  async function postCompletion(targetModel) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: targetModel,
            messages: [
              {
                role: 'system',
                content:
                  'You are a concise coding harness assistant running in the Reins H2H test environment. Reply directly and concisely.',
              },
              ...messages,
            ],
            temperature: 0,
            max_tokens: 256,
          }),
        });
        const text = await response.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
        return { ok: response.ok, status: response.status, data, text };
      } catch (err) {
        lastErr = err;
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    }
    throw lastErr;
  }

  let res = await postCompletion(model);
  if (
    !res.ok &&
    model === 'deepseek-flash' &&
    /Model Not Exist|model_not_found|invalid.*model/i.test(res.text)
  ) {
    res = await postCompletion('deepseek-chat');
  }

  if (!res.ok) {
    throw new Error(`DeepSeek API error (${res.status}): ${res.text.slice(0, 400)}`);
  }

  const reply = res.data?.choices?.[0]?.message?.content?.trim() || '';
  const usage = res.data?.usage || { prompt_tokens: 10, completion_tokens: 5 };
  return {
    reply,
    model,
    usage: {
      inputTokens: usage.prompt_tokens ?? 10,
      outputTokens: usage.completion_tokens ?? 5,
      cacheReadTokens: usage.prompt_cache_hit_tokens ?? 0,
    },
  };
}

async function runAcpMode(defaultModel) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const sessions = new Map();

  function send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    const { id, method, params } = msg;
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          serverInfo: { name: 'reins-deepseek-test-acp', version: '0.1.0', model: defaultModel },
          capabilities: { loadSession: true },
        },
      });
      return;
    }

    if (method === 'session/new') {
      const sessionId = `dsh_acp_${Date.now().toString(36)}`;
      sessions.set(sessionId, []);
      send({ jsonrpc: '2.0', id, result: { sessionId } });
      return;
    }

    if (method === 'session/load') {
      const sessionId = params?.sessionId || `dsh_acp_${Date.now().toString(36)}`;
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, loadHistory(sessionId));
      }
      send({ jsonrpc: '2.0', id, result: { sessionId } });
      return;
    }

    if (method === 'session/prompt') {
      const sessionId = params?.sessionId || 'dsh_acp_default';
      const promptBlocks = Array.isArray(params?.prompt) ? params.prompt : [];
      const promptText = promptBlocks.map((b) => b?.text || '').join('\n').trim();
      const history = sessions.get(sessionId) || loadHistory(sessionId);
      history.push({ role: 'user', content: promptText });
      try {
        const { reply } = await callDeepSeekFlash(history, defaultModel);
        history.push({ role: 'assistant', content: reply });
        sessions.set(sessionId, history);
        saveHistory(sessionId, history);

        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: reply },
            },
          },
        });
        send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: err.message || String(err) },
        });
      }
    }
  });
}

async function executeClaudeInteractiveTurn({ sessionId, model, promptText, cwd }) {
  const transcriptPath = resolveClaudeTranscriptPath(cwd, sessionId);
  const history = loadHistory(sessionId);
  history.push({ role: 'user', content: promptText });

  appendTranscriptRecord(transcriptPath, {
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

  const startedAt = Date.now();
  const { reply, usage } = await callDeepSeekFlash(history, model);
  history.push({ role: 'assistant', content: reply });
  saveHistory(sessionId, history);

  appendTranscriptRecord(transcriptPath, {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    sessionId,
    cwd,
    costUSD: 0.0001,
    message: {
      model,
      role: 'assistant',
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
      },
      content: [{ type: 'text', text: reply }],
    },
  });

  appendTranscriptRecord(transcriptPath, {
    type: 'system',
    uuid: crypto.randomUUID(),
    sessionId,
    subtype: 'turn_duration',
    durationMs: Math.max(1, Date.now() - startedAt),
  });

  return reply;
}

async function runClaudeMode(argv, defaultModel) {
  if (argv.includes('-p') || argv.includes('--print') || argv.includes('--output-format')) {
    throw new Error('claude -p / --print / --output-format is strictly forbidden.');
  }

  const resumeIdx = argv.indexOf('--resume');
  const sessionIdIdx = argv.indexOf('--session-id');
  const modelIdx = argv.indexOf('--model');
  const promptIdx = argv.indexOf('--tmux-turn-prompt');

  const sessionId =
    resumeIdx !== -1 && argv[resumeIdx + 1]
      ? argv[resumeIdx + 1]
      : sessionIdIdx !== -1 && argv[sessionIdIdx + 1]
        ? argv[sessionIdIdx + 1]
        : `claude_ds_${Date.now().toString(36)}`;
  const model = modelIdx !== -1 && argv[modelIdx + 1] ? argv[modelIdx + 1] : defaultModel;
  const cwd = process.cwd();

  // Direct turn execution invoked by mock-tmux.mjs on Windows/host tests
  if (promptIdx !== -1) {
    const promptText = argv[promptIdx + 1] || '';
    await executeClaudeInteractiveTurn({ sessionId, model, promptText, cwd });
    return;
  }

  // Interactive PTY/tmux mode (used inside real Linux/Docker tmux session)
  process.stdout.write(`Claude Code v2.1.302 (${model})\n❯ \n  ⏸ manual mode on · /effort\n`);

  let inputBuffer = '';
  let debounceTimer = null;
  let runningTurn = false;

  async function flushTurnIfReady() {
    if (runningTurn) return;
    const cleaned = inputBuffer
      .replace(/\x1b\[200~/g, '')
      .replace(/\x1b\[201~/g, '')
      .trim();
    if (!cleaned) return;
    inputBuffer = '';
    runningTurn = true;
    try {
      process.stdout.write('\n✻ Thinking… (esc to interrupt)\n');
      const reply = await executeClaudeInteractiveTurn({
        sessionId,
        model,
        promptText: cleaned,
        cwd,
      });
      process.stdout.write(`\n${reply}\n❯ \n  ⏸ manual mode on · /effort\n`);
    } catch (err) {
      process.stderr.write(`${err.message || String(err)}\n`);
    } finally {
      runningTurn = false;
    }
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    inputBuffer += chunk;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (/[\r\n]/.test(chunk) && !inputBuffer.includes('\x1b[200~')) {
      debounceTimer = setTimeout(flushTurnIfReady, 80);
    } else {
      debounceTimer = setTimeout(flushTurnIfReady, 200);
    }
  });

  setInterval(() => {}, 60000);
}

async function runDshHeadlessMode(argv, defaultModel) {
  const sessionIdx = argv.indexOf('--session-id');
  const modelIdx = argv.indexOf('--model');
  const sessionId =
    sessionIdx !== -1 && argv[sessionIdx + 1]
      ? argv[sessionIdx + 1]
      : `dsh_ds_${Date.now().toString(36)}`;
  const model = modelIdx !== -1 && argv[modelIdx + 1] ? argv[modelIdx + 1] : defaultModel;
  const promptText = argv.at(-1) || '';

  const history = loadHistory(sessionId);
  history.push({ role: 'user', content: promptText });

  const { reply, usage } = await callDeepSeekFlash(history, model);
  history.push({ role: 'assistant', content: reply });
  saveHistory(sessionId, history);

  process.stdout.write(`${JSON.stringify({ type: 'session', sessionId, model })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'text', text: reply })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'final', text: reply })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'status', phase: 'step_end', usage })}\n`);
  process.stdout.write(
    `${JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'complete' } })}\n`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const invokedAs = path.basename(process.argv[1] || '');
  const defaultModel =
    process.env.DEEPSEEK_MODEL || process.env.REINS_TEST_MODEL || 'deepseek-flash';

  try {
    if (argv.includes('--profile') && argv[argv.indexOf('--profile') + 1] === 'acp') {
      await runAcpMode(defaultModel);
      return;
    }
    if (
      invokedAs.includes('claude') ||
      argv.includes('--permission-mode') ||
      argv.includes('--tmux-turn-prompt') ||
      argv.includes('--resume')
    ) {
      await runClaudeMode(argv, defaultModel);
      return;
    }
    await runDshHeadlessMode(argv, defaultModel);
  } catch (err) {
    process.stderr.write(`${err.message || String(err)}\n`);
    process.exit(1);
  }
}

main();
