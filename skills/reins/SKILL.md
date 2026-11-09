---
name: reins
description: Delegate coding, debugging, or review tasks across local and remote AI coding harnesses (Claude Code, OpenAI Codex, DeepSeek Harness, ACP agents) via the Reins H2H CLI, and configure Reins targets, SSH connections, ReinPolicies, or target-specific caller usage rules (`~/.reins/config.yaml`). Use this skill whenever the user asks to call another harness/subagent (e.g. "ask codex to review", "let remote claude handle this", "ask dsh"), get a second opinion, run cross-harness code review, manage remote harness sessions, or add/edit Reins target configurations and caller rules.
---

# Reins — Cross-Harness (H2H) Delegation & Control Skill

Reins lets you hand over tasks to other local or remote AI coding harnesses (`claude-code`, `codex`, `dsh`, `acp`), monitor their progress, answer permission prompts (`attention_required`), steer multi-turn sessions, abort runaway turns, or configure local/remote harness targets and caller usage rules using the `reins` CLI (`node ./src/index.js` if `reins` is not on `PATH`).

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
# 1. Discover available local & remote harness targets, active sessions, and caller rules
reins targets --json

# 1b. Query selectable models and reasoning effort levels for a target (e.g. local-codex)
reins models local-codex --json

# 2. Delegate a substantial/multi-turn task as a first-class persistent session (optionally choosing --model and --effort)
reins delegate <target> --persistent --model gpt-6.1-sol --effort high --json --prompt-stdin <<'EOF'
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

# 5. Poll status / wait up to 30s for a background or in-progress task to settle
reins status <taskId> --wait 30 --json

# 6. Steer a task:
#    (a) Approve or deny an interactive permission prompt (when status == "attention_required")
reins steer <taskId> approve --wait 60 --json
reins steer <taskId> reject --wait 60 --json

#    (b) Send a follow-up turn or mid-turn steering instruction
reins steer <taskId> reply --wait 60 --json --prompt-stdin <<'EOF'
The unit test failed on Windows paths; please fix the path separator handling.
EOF

# 7. Abort the current turn (keeps session resumable) or kill the session completely
reins abort <taskId> --json
reins abort <taskId> --kill --json
```

---

## 3. Standard H2H Workflow for Agents

### Step 1: Discover Targets & Obey Target-Specific Caller Rules (`target.rules`)
Run `reins targets --json` (or call `reins_targets`) first to discover available target IDs (`local-codex`, `local-agy`, `local-dsh`, `remote-dsh`, `remote-claude`, or custom targets in `~/.reins/config.yaml`) and check whether the target defines a **`rules`** field.

> **Mandatory Caller Rule Compliance (`target.rules`)**:  
> Users can configure custom caller usage rules (`rules` in `reins.yaml` / `~/.reins/config.yaml`) on any local or remote target. When `target.rules` is present on a target, **you MUST strictly obey every instruction in `target.rules`** when composing `--prompt` / `prompt` and follow-up `reins steer` messages (for example: required language/persona, timezone discipline, remote SSH/tunnel workspace access conventions, or local scaffolding guidelines).

### Step 2: Delegate Safely (Avoid Shell Quoting Traps)
- **Bash / Zsh**: Use `--prompt-stdin <<'EOF' ... EOF` or `--prompt-file <path>`.
- **PowerShell (Windows)**: Pipe a single-quoted Here-String into `--prompt-stdin` or write to a scratch file and pass `--prompt-file`:
  ```powershell
  @'
  Please inspect the failing test and propose a minimal fix.
  '@ | reins delegate local-codex --wait --json --prompt-stdin
  ```

### Step 3: Handle the Returned `H2HTaskSnapshot`
Inspect `status` and `stopReason` in the JSON output:
- **`status: "completed"`**:
  Read `output` for the subagent's final answer. For `persistent` sessions, you can send follow-up instructions to the same `taskId` via `reins steer <taskId> reply`.
- **`status: "running"`**:
  The task is still running in the background. Call `reins status <taskId> --json` until it settles, or do other work in parallel.
- **`status: "attention_required"`**:
  The target harness paused for a permission dialog or user question (`attention.summary`, `attention.params`).
  - Under `parent-rein`, evaluate whether the requested action is safe and run `reins steer <taskId> approve --json` or `reject`.
  - Under `tight-rein`, quote `attention.summary` verbatim to the user, ask for their decision, and then run `reins steer`.
- **`status: "failed"`**:
  Read `diagnostic` and `error` for failure details and `output` for any partial assistant output before the failure.

---

## 4. Managing & Editing Reins Configuration (`~/.reins/config.yaml`)

When the user asks you to **add a new local/remote harness target**, **modify an existing target's SSH/driver/workdir/policy**, or **update a target's caller usage rules (`rules`)**:

### 4.1 Configuration File Resolution Order
Reins loads configuration from the first existing path below:
1. `--config <path>` CLI flag or `REINS_CONFIG` environment variable
2. Workspace-local `./config/reins.yaml` (or `./config/reins.json`)
3. **User global `~/.reins/config.yaml`** — **Default file to edit for machine-wide targets and rules**
4. Repository template `./config/reins.example.yaml`

### 4.2 Target & Caller Rules YAML Schema
Edit `~/.reins/config.yaml` (creating it if needed) using the following structure under `targets:`:

```yaml
targets:
  - id: <target-id>                  # Unique ID (e.g. remote-claude, remote-dsh, local-codex)
    label: <Human-readable label>
    harnessType: claude-code         # codex | antigravity | dsh | claude-code
    transport:
      kind: ssh                      # local | ssh
      sshHost: <ssh-config-alias>    # Host alias in ~/.ssh/config or user@host
      connectTimeoutSec: 20
    driver:
      mode: claude-tmux              # codex-app-server | agentapi | acp | dsh-headless | claude-tmux | claude-print
      binaryPath: /usr/local/bin/claude
      tmuxPrefix: reins-cc
    workspace:
      defaultWorkdir: /workspace/project
      allowedSyncModes: [remote-native, context-only]
    reinPolicy: tight-rein           # free-rein | auto-edit | parent-rein | tight-rein | plan-only
    rules: |
      Write multi-line natural-language caller rules/instructions here.
      Any agent discovering or delegating to this target via Reins will see this `rules` block
      and must follow these constraints when composing prompts and steering sessions.
```

### 4.3 Verify Configuration Changes
After editing `~/.reins/config.yaml`, always run:
```bash
reins targets
```
to confirm the YAML parses cleanly and the target's `Caller Rules` and metadata appear as expected.
