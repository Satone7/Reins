---
name: reins
description: Delegate coding, debugging, or review tasks across local and remote AI coding harnesses (Claude Code, OpenAI Codex, DeepSeek Harness, ACP agents) via the Reins H2H CLI. Use this skill whenever the user asks to call another harness/subagent (e.g. "ask codex to review", "let remote claude on faex1/vps handle this", "ask dsh"), get a second opinion, run cross-harness code review, or manage remote harness sessions.
---

# Reins — Cross-Harness (H2H) Delegation & Control Skill

Reins lets you hand over tasks to other local or remote AI coding harnesses (`claude-code`, `codex`, `dsh`, `acp`), monitor their progress, answer permission prompts (`attention_required`), steer multi-turn sessions, or abort runaway turns using the `reins` CLI.

> **Dual-Surface Note**: If the `reins_*` MCP tools (`reins_targets`, `reins_delegate`, `reins_status`, `reins_steer`, `reins_abort`) are already mounted in your toolset, you may call them directly. Otherwise, use the `reins` CLI commands documented below—both talk to the exact same `reins-hub` state pool and return the same `H2HTaskSnapshot` JSON structure.

---

## 1. Choosing Session Mode: `persistent` (First-Class) vs. `ephemeral` (One-Shot)

Before delegating, choose the appropriate session lifecycle so you neither lose important multi-turn work nor clutter the user's native Harness session history (`claude --resume`, `codex resume`, DSH session list) with noisy micro-tasks:

| Mode | CLI Flag | When to Use (Recommended) | Native Harness Behavior |
| :--- | :--- | :--- | :--- |
| **`persistent`** *(First-Class User Session)* | `--persistent` *(default for `--preset task` & `rescue`)* | **Substantial, iterative, or multi-turn engineering work**: feature implementation, multi-file refactoring, deep debugging, or tasks the human user may want to inspect and continue themselves in the target Harness. | Saved directly to the user's default session store (`~/.claude/projects`, `~/.codex/sessions`, `~/.dsh`). Visible in native session lists and resumable via `reins steer`, `claude --resume`, or `codex resume`. |
| **`ephemeral`** *(Burn-After-Reading / One-Shot)* | `--ephemeral` *(or `--one-shot`; default for `--preset review` & `adversarial-review`)* | **Granular, export, or one-off tasks**: data export/formatting, quick file summaries, single-pass code reviews, isolated helper generation, or high-frequency parallel queries that would otherwise dilute the user's valuable session history. | Runs with native ephemeral/isolated settings (`ephemeral: true` in Codex, `persistSession: false` in Claude SDK, isolated home in DSH) and cleans up immediately upon completion without polluting the user's session list. |

---

## 2. Quick Reference Commands

Always pass `--json` when calling `reins` programmatically so you receive the structured `H2HTaskSnapshot` envelope.

```bash
# 1. Discover available local & remote harness targets and active sessions
reins targets --json

# 2. Delegate a substantial/multi-turn task as a first-class persistent session
reins delegate <target> --persistent --desc "Short task summary" --wait 60 --json --prompt-stdin <<'EOF'
Your multi-line task instructions here...
EOF

# 3. Delegate a one-shot export / micro-task / review as an ephemeral session (no session list clutter)
reins delegate <target> --ephemeral --desc "Export API table" --json --prompt-stdin <<'EOF'
Extract all exported functions in src/hub/ as a Markdown table.
EOF

# 4. Delegate a read-only code review (defaults to --ephemeral and --policy plan-only)
reins delegate <target> --preset review --json --prompt-stdin <<'EOF'
Review the recent changes in src/hub/ for race conditions and edge cases.
EOF

# 4. Poll status / wait up to 30s for a background or in-progress task to settle
reins status <taskId> --wait 30 --json

# 5. Steer a task:
#    (a) Approve or deny an interactive permission prompt (when status == "attention_required")
reins steer <taskId> approve --wait 60 --json
reins steer <taskId> approve_session --wait 60 --json
reins steer <taskId> deny --message "Do not delete the build directory" --json

#    (b) Send a follow-up turn or mid-turn steering instruction
reins steer <taskId> reply --wait 60 --json --message-stdin <<'EOF'
The unit test failed on Windows paths; please fix the path separator handling.
EOF

# 6. Abort the current turn (keeps session resumable) or kill the session completely
reins abort <taskId> --json
reins abort <taskId> --kill --json
```

---

## 2. Standard H2H Workflow for Agents

### Step 1: Discover Targets
Run `reins targets --json` first if you are unsure which target IDs exist (e.g., `faex1-claude`, `vps-claude`, `local-codex`, `local-dsh`).

### Step 2: Delegate Safely (Avoid Shell Quoting Traps)
- **Bash / Zsh**: Use `--prompt-stdin <<'EOF' ... EOF` or `--prompt-file <path>`.
- **PowerShell (Windows)**: Pipe a single-quoted Here-String into `--prompt-stdin` or write to a scratch file and pass `--prompt-file`:
  ```powershell
  @'
  Please inspect the failing test and propose a minimal fix.
  '@ | reins delegate local-codex --desc "Fix failing test" --wait 60 --json --prompt-stdin
  ```

### Step 3: Handle the Returned `H2HTaskSnapshot`
Inspect `status` and `stopReason` in the JSON output:
- **`status: "completed"` (`stopReason: "completed"`)**:
  Read `output[0].text` for the subagent's final answer. Because sessions are `continuable: true` by default, you can later send follow-up instructions to the same `taskId` via `reins steer <taskId> reply`.
- **`status: "working"` (`timedOutWaiting: true`)**:
  The task is still running in the background. Call `reins status <taskId> --wait 30 --json` until it settles, or do other work in parallel.
- **`status: "attention_required"` (`stopReason: "attention-required"`)**:
  The target harness paused for a permission dialog or user question (`attention.title`, `attention.summary`, `attention.rawDetail`, `attention.options`).
  - Under `parent-rein`, evaluate whether the requested action is safe and run `reins steer <taskId> approve --json` or `deny`.
  - Under `tight-rein`, quote `attention.summary` and `attention.rawDetail` verbatim to the user, ask for their decision (or let them approve on their mobile notification), and then run `reins steer`.
- **`status: "failed"`**:
  Read `diagnostic` for structured failure facts (`stage`, `category`, `exitCode`) and `output` for any partial assistant output before the failure.
