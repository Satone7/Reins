# Reins

> **Take the reins of all your local and remote AI coding harnesses.**  
> Cross-host AI Coding Harness Interop Gateway (H2H Protocol via MCP & CLI/Skill) and Mobile Command Center.

---

## 1. Why "Reins"?

In AI software engineering, tools such as OpenAI Codex, Antigravity (`agy`), DeepSeek Harness (`dsh`), and Claude Code are known as **Harnesses**.  
However, when multiple horses wearing different harnesses pull the same carriage without unified **reins** in the driver's hands, they operate in isolated silos and cannot collaborate.

**Reins** is the unified control plane that connects them:
- **Pass / Hand over the reins**: Let any host Harness (e.g., Antigravity or Claude Code) dynamically delegate subtasks to another local or remote Harness (e.g., local `codex`, `dsh`, or remote `claude-code` over SSH) via the standardized **H2H (Harness-to-Harness) Protocol** exposed through both **MCP** and **CLI + Agent Skill (`SKILL.md`)**.
- **Take the reins**: Inspect live progress, transcripts, and diffs from your terminal or mobile device at any time, and seamlessly resume H2H-created sessions directly inside each target Harness's native UI/CLI.
- **Free rein vs. Tight rein**: Configure sandboxed autonomous execution (`free-rein`, `auto-edit`), route permission prompts back to the parent Harness (`parent-rein`), or intercept high-risk actions and push interactive approval cards to your mobile phone (`tight-rein`).
- **Pull the reins**: Instantly interrupt a runaway turn (`reins abort`) while keeping the underlying session alive for follow-up steering.

---

## 2. Core Objectives & Evolution Roadmap

### Phase 1: H2H (Harness-to-Harness) Dual-Surface Core (CLI/Skill + MCP)
- **Dual Isomorphic Northbound Surfaces** sharing the same `reins-hub` state pool and `H2HTaskSnapshot` JSON envelope:
  1. **CLI + Agent Skill (`reins` CLI + `skills/reins/SKILL.md`)**: Zero persistent context overhead via progressive skill disclosure; provides `reins targets|delegate|status|steer|abort|hub` commands for both AI agents and human developers.
  2. **MCP Server (`reins-mcp`)**: Exposes `reins_targets`, `reins_delegate`, `reins_status`, `reins_steer`, and `reins_abort` over standard JSON-RPC MCP.
- **Unified Southbound `HarnessDriver` & `Transport` (`Local` / `SSH`)**:
  - **Adaptation Priority Order**:
    1. **OpenAI Codex (`codex`)** — via official `codex app-server --stdio` JSON-RPC 2.0 (supporting both `persistent` first-class sessions and `ephemeral` one-shot sessions, plus interactive approval interception).
    2. **Antigravity (`antigravity`)** — via local/remote CLI & headless/ACP integration.
    3. **DeepSeek Harness (`dsh`)** — via native `acp` (`dsh --profile acp`) and `dsh-sdk` (`dsh --profile sdk`).
    4. **Claude Code (`claudecode`)** — via interactive `SSH + Tmux + JSONL` (`claude-tmux`) and `claude-sdk`.

### Phase 2: Daemonization (`reins-hub`) & Instant Mobile Push Notifications
- Persist cross-harness call trees, session state, and transcript streams in the resident **`reins-hub`** daemon.
- Built-in notification gateway (`reins-notify`) that pushes interactive notifications (`ntfy.sh` / `Bark` / Feishu / Webhook) on `task.attention_required`, `task.completed`, or `task.failed`, allowing one-tap remote Allow/Deny from a phone lock screen.

### Phase 3: Reins Mobile App
- Cross-platform mobile command center powered by `reins-hub` real-time state streams:
  - Global multi-host session dashboard and call-tree viewer;
  - Remote permission approval, multi-turn steering, and syntax-highlighted Git Diff review;
  - Direct task launch on any local or remote machine from your phone.

---

## 3. Repository Structure

```text
reins/
├── README.md                         # Project overview and vision
├── package.json                      # Node.js (ESM) package manifest
├── config/
│   └── reins.example.yaml            # Example configuration for local & remote harness targets
├── skills/
│   └── reins/
│       └── SKILL.md                  # Standard H2H CLI Agent Skill definition
├── research/
│   └── PROTOCOLS_AND_ECOSYSTEM.md    # Deep dive into MCP/A2A/ACP/AHP, Codex plugin, and DSH subagents
├── docs/
│   ├── ARCHITECTURE.md               # System architecture and phased implementation roadmap
│   └── H2H_PROTOCOL.md               # Reins H2H (Harness-to-Harness) Protocol Specification v0.2
└── src/
    ├── index.js                      # Main entry point (CLI & SDK exports)
    ├── protocol/                     # H2H protocol types, envelopes, and validators
    ├── cli/                          # Northbound Surface 1: `reins` CLI commands
    ├── mcp/                          # Northbound Surface 2: `reins-mcp` stdio/HTTP MCP server
    ├── hub/                          # Core state machine, registry, task router, and loop guard
    ├── drivers/                      # Southbound Harness drivers (Codex, Antigravity, DSH, Claude)
    ├── transports/                   # Cross-platform Local subprocess and Remote SSH transports
    └── notify/                       # Mobile push notification and webhook bridges
```

---

## 4. Quick Navigation (For Coding Agents)

When working on this repository in a new session, read the core documents in the following order:
1. **[`research/PROTOCOLS_AND_ECOSYSTEM.md`](./research/PROTOCOLS_AND_ECOSYSTEM.md)**: Understand the boundaries of existing protocols (MCP Tasks, A2A, ACP, AHP), how OpenAI's `codex-plugin-cc` and DSH's `@deepseek-ai/dsh-subagent*` work under the hood, and how Reins bridges their gaps.
2. **[`docs/H2H_PROTOCOL.md`](./docs/H2H_PROTOCOL.md)**: Review the H2H v0.2 primitives, dual session lifecycle (`persistent` vs. `ephemeral`), `ReinPolicy` permission matrix, workspace handoff contracts, loop guard headers, and isomorphic MCP/CLI schemas.
3. **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)**: Review the module boundaries and the adaptation sequence (`codex` $\rightarrow$ `antigravity` $\rightarrow$ `dsh` $\rightarrow$ `claudecode`).
4. **[`config/reins.example.yaml`](./config/reins.example.yaml)**: Check target and policy configuration formats.
