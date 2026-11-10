---
name: reins
description: Delegate coding, debugging, or review tasks across local and remote AI coding harnesses (Claude Code, OpenAI Codex, DeepSeek Harness, ACP agents) via the Reins H2H CLI, and initialize or configure Reins targets, SSH connections, ReinPolicies, or caller usage rules (`~/.reins/config.yaml`). Trigger this skill whenever the user invokes `/reins`, `/reins init`, asks to initialize Reins, asks to call another harness/subagent (e.g. "ask codex to review", "let remote claude handle this", "ask dsh"), get a second opinion, run cross-harness code review, manage remote harness sessions, or add/edit Reins target configurations and caller rules.
---

# Reins — Cross-Harness (H2H) Delegation & Agent-Hosted Initialization Skill

Reins lets you hand over tasks to other local or remote AI coding harnesses (`claude-code`, `codex`, `dsh`, `antigravity`), monitor their progress, answer permission prompts (`attention_required`), steer multi-turn sessions, abort runaway turns, or host the interactive initialization and configuration of `~/.reins/config.yaml` using the atomic `reins` CLI primitives (`node ./src/index.js` if `reins` is not on `PATH`).

> **Core Principle — Agent Hosts Long Workflows, CLI Provides Only Atomic Primitives**:  
> Never ask the human user to run `reins` CLI commands or scripts themselves. All multi-step flows (such as initialization, target configuration, delegation, and steering) are **hosted and adapted dynamically by you (the Agent) in the chat dialog**, calling Reins' atomic CLI primitives (`discover`, `probe-ssh`, `sync-skills`, `targets`, `models`, `delegate`, `status`, `steer`, `abort`) behind the scenes.

---

## 1. Agent-Hosted Initialization Flow (Auto-Trigger When Unconfigured & Manual `/reins init`)

### 1.1 When to Enter the Init Flow
You must host the initialization flow in the chat dialog in either of these two situations:
1. **Automatic First-Run Trigger**:
   When the user asks to use Reins and `reins targets --json` (or `reins_targets`) returns **`"initialized": false`** (`"needsInit": true`, meaning `~/.reins/config.yaml` does not exist yet). Pause the delegation, guide the user through initializing Reins in the chat dialog first, and then immediately proceed with their original task.
2. **Manual Trigger (`/reins init`)**:
   When the user enters **`/reins init`** (or asks to initialize / reconfigure Reins) in the chat dialog, even if `~/.reins/config.yaml` already exists.

---

### 1.2 How to Host the Initialization Dialog (Adapt Dynamically)

#### Step 1: Call the Atomic Discovery Primitive
Run in the background:
```bash
reins discover --json
```
*(If you already called `reins targets --json` and `"initialized": false`, the `discovery` object is already included in that response.)*

This atomic command returns:
- `localHarnesses`: Detection results (`detected`, `binaryPath`, `detectionSource`, `suggestedTarget`) for `local-codex`, `local-agy`, `local-dsh`, and `local-claude`.
- `sshHosts`: SSH host aliases parsed from `~/.ssh/config`.
- `existingLocalTargets` & `existingRemoteTargets`: Currently configured targets if `~/.reins/config.yaml` already exists.

#### Step 2: Local Harness Selection, Thinking Strategy & Special Requirements
Using your interactive question tool (`ask_question` / `AskUserQuestion`) or natural chat dialog, present the discovered local harnesses and ask the user:
1. **注册哪些本地 Harness**：
   展示本机扫描到的 Harness（标明哪些已检测到及对应路径），默认推荐注册所有已检测到的本地 Harness（如 `local-codex`、`local-agy`、`local-dsh`、`local-claude`），让用户选择需要注册哪些。
2. **思考强度与调度偏好**：
   询问用户偏好的模型与思考强度策略，例如：
   - **质量优先，采用 `max` 思考强度，可能会消耗更多的 token**（推荐：优先选用各 Harness 的旗舰模型如 Claude `opus`、Codex 旗舰模型，并开启 `max`/`xhigh`/`ultra` 最高思考强度）
   - **均衡，交由 Agent 临场判断**（由主控 Agent 根据任务复杂度动态匹配旗舰/轻量模型与 `high`/`medium`/`low` 思考强度）
   - **速度与成本优先**（默认采用轻量高吞吐模型与 `low`/`medium` 思考强度以节省 Token）
   - **保持各 Harness 原生默认配置**
3. **是否有特殊要求 (`rules`)**：
   询问用户是否有全局或针对特定本地 Harness 的特殊要求（例如：中文总结汇报与注释、纯英文 Prompt 与文档、完成修改后必须运行测试、禁止自动 `git commit/push`、特定时区或目录限制等），并根据用户的回答灵活转化为 `hub.rules` 或目标级 `rules`。

#### Step 3: Remote SSH Harness Registration (After Local Harnesses Are Settled)
处理完本地 Harness 后，继续在对话框中询问用户：**是否需要注册远程 Harness（通过 SSH 连接远程服务器/开发机/VPS 上的 Claude Code、DSH、Codex 等）？**
- 若是重新执行 `/reins init` 且已有 `existingRemoteTargets`，先展示现有远程目标并询问是保留、在此基础上新增，还是重新配置。
- 若用户需要添加远程 Harness：
  1. 可列出 `sshHosts`（来自 `~/.ssh/config`）供用户选择，或让用户直接提供 `user@host` / SSH 别名。
  2. 在后台调用原子探测命令自动检查远端环境：
     ```bash
     reins probe-ssh <sshHost> --json
     ```
     该命令会返回远端 `$HOME` 以及已安装的 `claude`、`dsh`、`codex`、`agy`、`tmux` 路径。
  3. 结合探测结果与用户沟通，随机应变地确认远端要注册的 Harness 类型（如 `claude-code` 配合 `claude-tmux` 持久会话，或 `dsh` 配合 `dsh-headless`）、默认工作目录 (`defaultWorkdir`)、权限策略 (`reinPolicy`) 以及是否有该远端专属的特殊要求（如纯英文 Prompt、特定时区、隐藏 VPS 上下文、通过远端隧道访问代码库等）。

#### Step 4: Write `~/.reins/config.yaml`, Sync Skills & Verify
1. 根据对话收集到的配置，直接生成并写入 `~/.reins/config.yaml`（参见第 5.2 节 YAML 结构；若原文件存在可先备份）。
2. 调用原子命令同步本地已注册 Harness 的 Skill 文件并校验注册表：
   ```bash
   reins sync-skills --json
   reins targets --json
   ```
3. 向用户简明汇报初始化结果；若是首次调用时自动触发的初始化，紧接着继续执行用户原本的任务。

---

## 2. Choosing Session Mode: `persistent` (First-Class) vs. `ephemeral` (One-Shot)

Before delegating, choose the appropriate session lifecycle so you neither lose important multi-turn work nor clutter the user's native Harness session history (`claude --resume`, `codex resume`, DSH session list) with noisy micro-tasks:

| Mode | CLI Flag | When to Use (Recommended) | Native Harness Behavior |
| :--- | :--- | :--- | :--- |
| **`persistent`** *(First-Class User Session)* | `--persistent` *(default for `--preset task` & `rescue`)* | **Substantial, iterative, or multi-turn engineering work**: feature implementation, multi-file refactoring, deep debugging, or tasks the human user may want to inspect and continue themselves in the target Harness. | Saved directly to the user's default session store (`~/.claude/projects`, `~/.codex/sessions`, `~/.dsh`). Visible in native session lists and resumable via `reins steer`, `claude --resume`, or `codex resume`. |
| **`ephemeral`** *(Burn-After-Reading / One-Shot)* | `--ephemeral` *(or `--one-shot`; default for `--preset review` & `adversarial-review`)* | **Granular, export, or one-off tasks**: data export/formatting, quick file summaries, single-pass code reviews, isolated helper generation, or high-frequency parallel queries that would otherwise dilute the user's valuable session history. | Runs with native ephemeral/isolated settings (`ephemeral: true` in Codex, `persistSession: false` in Claude SDK, isolated home in DSH) and cleans up immediately upon completion without polluting the user's session list. |

---

## 3. Atomic CLI Primitives Reference (For Agent Execution)

Always pass `--json` when calling `reins` so you receive structured JSON output.

```bash
# 0. Atomic discovery & skill-sync primitives (used by the Agent during init/configuration)
reins discover --json
reins probe-ssh <sshHost> --json
reins sync-skills codex,antigravity,dsh,claude-code --json

# 1. Discover available local & remote harness targets, initialization status, and caller rules
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

## 4. Standard H2H Workflow for Agents

### Step 1: Discover Targets, Check `initialized`, & Obey Target-Specific Caller Rules (`target.rules`)
Run `reins targets --json` (or call `reins_targets`) first:
- **If `"initialized": false`**: Stop and host **Section 1 (Agent-Hosted Initialization Flow)** in the chat dialog first!
- **If `"initialized": true`**: Inspect the registered target IDs (`local-codex`, `local-agy`, `local-dsh`, `remote-dsh`, `remote-claude`, or custom targets in `~/.reins/config.yaml`) and check whether the target defines a **`rules`** field.

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

## 5. Managing & Editing Reins Configuration (`~/.reins/config.yaml`)

When initializing Reins or when the user asks you to **add a new local/remote harness target**, **modify an existing target's SSH/driver/workdir/policy**, or **update caller usage rules (`rules`)**:

### 5.1 Configuration File Resolution Order
Reins loads configuration from the first existing path below:
1. `--config <path>` CLI flag or `REINS_CONFIG` environment variable
2. Workspace-local `./config/reins.yaml` (or `./config/reins.json`)
3. **User global `~/.reins/config.yaml`** — **Default file to create/edit for machine-wide targets and rules**
4. Repository template `./config/reins.example.yaml` *(fallback only; indicates `initialized: false`)*

### 5.2 Target & Caller Rules YAML Schema
Write or edit `~/.reins/config.yaml` directly using the following structure under `hub:` and `targets:`:

```yaml
hub:
  host: 127.0.0.1
  port: 19420
  stateDir: ~/.reins
  loopGuard:
    maxHops: 3
    allowSelfCall: false
  rules: |
    Write global caller rules here (automatically merged into every target).
    For example, for "质量优先，采用 max 思考强度":
    [Global Caller Rule — Quality-First Model & Max Reasoning Effort]
    When delegating coding, architecture, debugging, or review tasks via Reins, always prioritize reasoning quality over latency:
    - First inspect selectable models and supported reasoning effort levels via `reins models <target> --json` if not already known.
    - Explicitly select the target's strongest flagship model (e.g., `opus` for Claude Code, or the top frontier coding model in Codex) and prefer `--effort max` (or the highest effort level listed in `supportedEfforts`, such as `max` / `xhigh` / `ultra`) unless the user explicitly asks for a lightweight/fast run.

targets:
  - id: <target-id>                  # Unique ID (e.g. local-codex, local-agy, remote-claude)
    label: <Human-readable label>
    harnessType: claude-code         # codex | antigravity | dsh | claude-code
    model: opus                      # Optional default model override
    effort: max                      # Optional default reasoning effort (low | medium | high | xhigh | max | ultra)
    transport:
      kind: ssh                      # local | ssh
      sshHost: <ssh-config-alias>    # Host alias in ~/.ssh/config or user@host (omit for local)
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
      Write target-specific natural-language caller rules/instructions here.
      Any agent discovering or delegating to this target via Reins will see this `rules` block
      and must follow these constraints when composing prompts and steering sessions.
```

### 5.3 Verify Configuration Changes
After writing or editing `~/.reins/config.yaml`, always run:
```bash
reins targets --json
```
to confirm `"initialized": true` and verify that all registered targets and their `rules` parse cleanly.
