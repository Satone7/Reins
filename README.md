# Reins

> **Take the reins of all your local and remote AI coding harnesses.**  
> Official Reference Gateway & Mobile Command Center for the [**H2H (Harness-to-Harness) Protocol v0.1**](https://github.com/Satone7/h2h-protocol) (via Agent Skill + Atomic CLI Primitives & MCP).

---

## 1. Core Design Philosophy (开发理念：Agent 主导流程，项目提供文档与原子原语)

Reins is built around a strict separation between **Agent-hosted workflow orchestration** and **atomic runtime primitives**:

1. **Agent Hosts Long Workflows & Adapts Dynamically (长流程交由 Agent 主持并随机应变)**  
   Human users are **never** expected to memorize or manually run `reins` CLI commands or setup scripts in a terminal. All multi-step interactive workflows—including first-time initialization (`/reins init`), local/remote harness registration, SSH environment probing, task delegation, permission steering, and error recovery—are hosted directly by the AI Agent in the chat dialog.
2. **Workflow Documentation as Code (`skills/reins/SKILL.md`)**  
   Instead of hardcoding brittle interactive CLI wizards or rigid state machines in JavaScript, Reins defines conversational workflows, decision trees, and target-specific caller rules (`rules`) in [`skills/reins/SKILL.md`](./skills/reins/SKILL.md). This allows the hosting Agent to ask contextual questions, adapt to non-standard environments (e.g., custom SSH jump hosts, version differences, language/timezone preferences), and write clean configurations to `~/.reins/config.yaml`.
3. **Stateless, Atomic Primitives Only (`reins` CLI & MCP)**  
   The `reins` executable provides only non-interactive, structured JSON (`--json`) atomic primitives that the Agent invokes behind the scenes:
   - **Environment & Config Primitives**: `reins discover --json`, `reins probe-ssh <host> --json`, `reins sync-skills --json`, `reins targets --json`, `reins models <target> --json`
   - **H2H Task Lifecycle Primitives**: `reins delegate`, `reins status`, `reins steer`, `reins abort`

---

## 2. Why "Reins"?

In AI software engineering, tools such as OpenAI Codex, Antigravity (`agy`), DeepSeek Harness (`dsh`), and Claude Code are known as **Harnesses**.  
However, when multiple horses wearing different harnesses pull the same carriage without unified **reins** in the driver's hands, they operate in isolated silos and cannot collaborate.

**Reins** is the unified control plane and reference implementation of the open [**H2H Protocol (`Satone7/h2h-protocol`)**](https://github.com/Satone7/h2h-protocol) that connects them:
- **Pass / Hand over the reins**: Let any host Harness (e.g., Antigravity or Claude Code) dynamically onboard a project and delegate subtasks to another local or remote Harness (e.g., local `codex`, `dsh`, or remote `claude-code` over SSH) via the standardized [**H2H (Harness-to-Harness) Protocol**](https://github.com/Satone7/h2h-protocol) exposed through both **CLI + Agent Skill (`SKILL.md`)** and **MCP**.
- **Onboard projects & bind conversations**: Automatically canonicalize paths, pre-authorize workspace trust, register the repository as a first-class Project in the target Harness, and bind conversations directly under that project (`snapshot.project.binding = "bound"`) so the target Harness can actively inspect repository files and human developers see the session grouped under the project in the native UI.
- **Take the reins**: Inspect live progress, transcripts, and diffs at any time, and seamlessly resume H2H-created sessions directly inside each target Harness's native UI/CLI.
- **Free rein vs. Tight rein**: Configure sandboxed autonomous execution (`free-rein`, `auto-edit`), route permission prompts back to the parent Harness (`parent-rein`), or intercept high-risk actions (`tight-rein`).
- **Pull the reins**: Instantly interrupt a runaway turn (`reins abort`) while keeping the underlying session alive for follow-up steering.

---

## 3. Usage (使用指南)

### 3.1 Bootstrap the Skill Once (首次安装技能)
Clone the repository and sync the Reins skill to your local harnesses so your Agent can discover it:
```bash
node ./src/index.js sync-skills --json
```
*(Syncs `SKILL.md` into `~/.gemini/config/skills/reins/`, `~/.codex/skills/reins/`, `~/.dsh/skills/reins/`, and `~/.claude/skills/reins/`.)*

### 3.2 Agent-Hosted Initialization in Chat (对话式引导初始化)
You do **not** need to write `~/.reins/config.yaml` by hand or run a CLI wizard:
- **Automatic First-Run Trigger**: The first time you invoke `/reins` or ask your Agent to delegate a task (e.g., *"让 codex 帮我 review 一下当前改动"*), the Agent calls `reins targets --json`, detects `"initialized": false`, and automatically hosts the initialization dialog with you.
- **Manual Re-Initialization**: At any time, type **`/reins init`** in the chat dialog to re-run the initialization flow or add/modify targets.

During the dialog flow, the Agent will:
1. Call `reins discover --json` to auto-discover installed local harnesses (`local-codex`, `local-agy`, `local-dsh`, `local-claude`) and ask which ones you want to register.
2. Ask about your **thinking effort & model strategy** preference (e.g., *"质量优先，采用 max 思考强度，可能会消耗更多的 token"* vs. *"均衡，交由 Agent 临场判断"* vs. *"速度与成本优先"*).
3. Ask if you have any **special requirements (`rules`)** (e.g., preferred language, mandatory test execution after edits, read-only directories).
4. Ask if you want to register any **remote SSH harnesses**, automatically listing aliases from `~/.ssh/config`, probing remote binary/home paths via `reins probe-ssh <host> --json`, and adapting to your remote setup.
5. Write `~/.reins/config.yaml`, sync skills across your selected harnesses, and verify with `reins targets --json`.

### 3.3 Daily Cross-Harness Delegation in Chat (日常跨 Harness 协作)
Simply talk to your Agent in natural language:
- *"调用 local-codex 对 `src/hub/` 做一次对抗式代码审查"*
- *"让远程服务器上的 claude-code 帮我排查并修复这个 Linux 构建问题"*
- *"用 `/reins init` 帮我新增一台远程 SSH 上的 DSH target"*

### 3.4 Atomic CLI Primitives Reference (供 Agent 调用的原子脚本原语)
All CLI commands are stateless atomic primitives designed to be called by the Agent with `--json`:

```bash
# 1. Environment discovery, remote SSH probing, and skill synchronization
reins discover --json
reins probe-ssh <sshHost> --json
reins sync-skills codex,antigravity,dsh,claude-code --json

# 2. Target & model catalog inspection
reins targets --json
reins models <target> --json

# 3. Delegate a persistent multi-turn session or ephemeral one-shot task
reins delegate <target> --persistent --model <model> --effort <effort> --json --prompt-stdin <<'EOF'
Task instructions...
EOF
reins delegate <target> --ephemeral --preset review --json --prompt-stdin <<'EOF'
Review instructions...
EOF

# 4. Poll status, steer (approve / reject / reply), or abort
reins status <taskId> --wait 30 --json
reins steer <taskId> approve --wait 60 --json
reins steer <taskId> reply --wait 60 --json --prompt-stdin <<'EOF'
Follow-up instructions...
EOF
reins abort <taskId> [--kill] --json
```

---

## 4. Evolution Roadmap

### Phase 1: H2H (Harness-to-Harness) Dual-Surface Core (CLI/Skill + MCP)
- **Dual Isomorphic Northbound Surfaces** sharing the same `reins-hub` state pool and `H2HTaskSnapshot` JSON envelope:
  1. **Agent Skill + Atomic CLI (`skills/reins/SKILL.md` + `reins` CLI)**: Zero persistent context overhead via progressive skill disclosure; Agent hosts long workflows while CLI provides atomic execution primitives.
  2. **MCP Server (`reins-mcp`)**: Exposes `reins_targets`, `reins_delegate`, `reins_status`, `reins_steer`, and `reins_abort` over standard JSON-RPC MCP.
- **Unified Southbound `HarnessDriver` & `Transport` (`Local` / `SSH`)**:
  - Supports **OpenAI Codex (`codex`)**, **Antigravity (`antigravity`)**, **DeepSeek Harness (`dsh`)**, and **Claude Code (`claude-code`)** across local subprocesses and remote SSH.

### Phase 2: Daemonization (`reins-hub`) & Instant Mobile Push Notifications
- Persist cross-harness call trees, session state, and transcript streams in the resident **`reins-hub`** daemon.
- Built-in notification gateway (`reins-notify`) that pushes interactive notifications (`ntfy.sh` / `Bark` / Feishu / Webhook) on `task.attention_required`, `task.completed`, or `task.failed`, allowing one-tap remote Allow/Deny from a phone lock screen.

### Phase 3: Reins Mobile App
- Cross-platform mobile command center powered by `reins-hub` real-time state streams:
  - Global multi-host session dashboard and call-tree viewer;
  - Remote permission approval, multi-turn steering, and syntax-highlighted Git Diff review;
  - Direct task launch on any local or remote machine from your phone.

---

## 5. Repository Structure

```text
reins/
├── README.md                         # Project overview, design philosophy, and usage
├── package.json                      # Node.js (ESM) package manifest
├── .env.example                      # Developer environment template (DEEPSEEK_API_KEY)
├── Dockerfile.test                   # Self-contained OpenSSH + Tmux + Harness test container
├── docker-compose.test.yml           # Reproducible Docker test orchestration
├── config/
│   ├── reins.example.yaml            # Example configuration for local & remote harness targets
│   └── reins.test.yaml               # Standardized test configuration (unified model: deepseek-flash)
├── skills/
│   └── reins/
│       └── SKILL.md                  # Agent-hosted H2H & initialization workflow skill definition
├── research/
│   └── PROTOCOLS_AND_ECOSYSTEM.md    # Deep dive into MCP/A2A/ACP/AHP, Codex plugin, and DSH subagents
├── docs/
│   ├── ARCHITECTURE.md               # System architecture and phased implementation roadmap
│   └── H2H_PROTOCOL.md               # Reins H2H (Harness-to-Harness) Protocol Specification v0.2
├── src/
│   ├── index.js                      # Main entry point (CLI & SDK exports)
│   ├── protocol/                     # H2H protocol types, envelopes, and validators
│   ├── cli/                          # Northbound Surface 1: Atomic `reins` CLI primitives
│   ├── mcp/                          # Northbound Surface 2: `reins-mcp` stdio/HTTP MCP server
│   ├── hub/                          # Core state machine, registry, task router, and loop guard
│   ├── drivers/                      # Southbound Harness drivers (Codex, Antigravity, DSH, Claude)
│   ├── transports/                   # Cross-platform Local subprocess and Remote SSH transports
│   └── notify/                       # Mobile push notification and webhook bridges
└── tests/
    ├── reins-mvp.test.js             # Unit & H2H protocol conformance test suite (offline, decoupled)
    ├── docker-e2e.test.js            # Live E2E test suite powered by deepseek-flash & Docker SSH/Tmux
    └── docker/                       # Container entrypoint & DeepSeek-backed test harness agent
```

---

## 6. Reproducible Testing & Docker Verification (`deepseek-flash`)

Reins decouples developer-local machine configurations (`~/.reins/config.yaml`) from the verification environment so tests are 100% reproducible on any machine:

1. **Unit & Protocol Conformance Tests (Offline, Zero External Dependencies)**:
   ```bash
   npm test
   ```
   Automatically sets `REINS_IGNORE_USER_CONFIG=1` and verifies all drivers, transports, loop guards, atomic discovery primitives, and H2H protocol invariants against deterministic local fixtures.

2. **Live LLM & Docker SSH/Tmux Verification (`deepseek-flash`)**:
   All live verification targets in [`config/reins.test.yaml`](./config/reins.test.yaml) uniformly use **`deepseek-flash`** and read **`DEEPSEEK_API_KEY`** from your local `.env` file:
   ```bash
   # Step 1: Create your local developer .env file (gitignored) and fill in DEEPSEEK_API_KEY
   cp .env.example .env

   # Step 2: Run the full containerized test suite (OpenSSH + Tmux + deepseek-flash E2E)
   npm run test:docker

   # Or run local live E2E verification directly on the host
   npm run test:e2e
   ```

---

## 7. Quick Navigation (For Coding Agents)

> **Standalone Protocol Specification Repository**:  
> The vendor-neutral, bilingual (EN / 简体中文) H2H Protocol Specification and living Harness capability registry is maintained at **[`github.com/Satone7/h2h-protocol`](https://github.com/Satone7/h2h-protocol)** (local sibling workspace: `../h2h-protocol`).

When working on this repository in a new session, read the core documents in the following order:
1. **[`Satone7/h2h-protocol`](https://github.com/Satone7/h2h-protocol)** & **[`research/PROTOCOLS_AND_ECOSYSTEM.md`](./research/PROTOCOLS_AND_ECOSYSTEM.md)**: Understand the boundaries of existing protocols (MCP Tasks, A2A, ACP, AHP), how OpenAI's `codex-plugin-cc` and DSH's `@deepseek-ai/dsh-subagent*` work under the hood, and how H2H bridges their gaps.
2. **[`docs/H2H_PROTOCOL.md`](./docs/H2H_PROTOCOL.md)**: Review Reins' implementation of the H2H v0.1 primitives, Project Onboarding & Session Binding contract (`snapshot.project`), dual session lifecycle (`persistent` vs. `ephemeral`), `ReinPolicy` permission matrix, loop guard headers (`H2H_*` / `REINS_*`), and isomorphic MCP/CLI schemas.
3. **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)**: Review the module boundaries and the adaptation sequence (`codex` $\rightarrow$ `antigravity` $\rightarrow$ `dsh` $\rightarrow$ `claudecode`).
4. **[`config/reins.example.yaml`](./config/reins.example.yaml)**: Check target and policy configuration formats.
