# Reins System Architecture & Roadmap

> **Cross-Platform Runtime**: Windows, macOS, Linux, and Docker (`docker-compose.test.yml`)  
> **Tech Stack**: Node.js (ESM, `>=20`), zero bloated runtime dependencies, pure-function core state transitions, and built-in test runner (`node --test`).

---

## 1. High-Level Topology (Dual Northbound: CLI/Skill + MCP)

Reins uses a layered architecture: **Isomorphic Dual Northbound Surfaces (CLI + SKILL.md & MCP Server) $\rightarrow$ Core Daemon (`reins-hub`) $\rightarrow$ Pluggable Southbound Drivers & Transports**:

```text
  ┌─────────────────────────────────┐       ┌─────────────────────────────────┐
  │   MCP Host Harnesses            │       │   Skill + Shell Harnesses       │
  │ (AGY / Claude / DSH / Cursor)   │       │ (AGY / Claude Code / Codex / Hu)│
  └────────────────┬────────────────┘       └────────────────┬────────────────┘
                   │ (JSON-RPC MCP Tool Call)                │ (SKILL.md -> Shell Exec)
                   ▼                                         ▼
    ┌──────────────────────────────┐          ┌──────────────────────────────┐
    │      reins-mcp (Adapter)     │          │      reins CLI (Command)     │
    │  reins_targets / delegate /  │          │  reins targets / delegate /  │
    │  status / steer / abort      │          │  status / steer / abort      │
    └──────────────┬───────────────┘          └──────────────┬───────────────┘
                   │ (Local HTTP / Auto-Spawn / Embedded)    │
                   └────────────────────┬────────────────────┘
                                        ▼
╔═══════════════════════════════════════════════════════════════════════════╗
║                           reins-hub (Core Daemon)                         ║
║                                                                           ║
║  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  ║
║  │ Target Registry │  │ Task & Session   │  │ Rein Policy & Loop Guard │  ║
║  │ (Local & SSH)   │  │ State Machine    │  │ (5 Policies / Max Hops)  │  ║
║  └─────────────────┘  └──────────────────┘  └──────────────────────────┘  ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │ Event Bus & Mobile Gateway (REST + SSE/WebSocket + Push Notifier)   │  ║
║  └──────────────────────────────────┬──────────────────────────────────┘  ║
╚═════════════════════════════════════╪═════════════════════════════════════╝
            │                         │                         │
   ┌────────┴────────┐                │                ┌────────┴────────┐
   ▼                 ▼                ▼                ▼                 ▼
[Local Drivers]  [Remote SSH Drivers] │         [Push Channels]   [Reins Mobile App]
1. CodexDriver   • RemoteCodexDriver  │         • ntfy.sh / Bark  • Multi-host Task Board
2. AgyDriver     • RemoteAgy/Dsh      │         • Feishu / Slack  • 1-Tap Mobile Approval
3. DshDriver     • ClaudeTmuxDriver   │                           • Live Transcript & Diff
4. ClaudeDriver    (SSH + Tmux)       │
```

---

## 2. Core Module Responsibilities

### 2.1 `src/protocol/` —— H2H Protocol Envelopes & Validation
- **`schema.js`**: Defines and validates `HarnessCard`, `H2HTaskSnapshot`, `ReinPolicy`, `SessionMode` (`persistent` | `ephemeral`), `Preset` (`task` | `review` | `adversarial-review` | `rescue`), and structured `diagnostic` formatting.

### 2.2 `src/hub/` —— Core State Machine & Router
- **`registry.js`**: Loads and validates `reins.yaml` (with automatic local discovery for installed harnesses such as Windows Store / CLI `codex`), tracking target health and active task counts.
- **`task-manager.js`**: Manages the full H2H task lifecycle (`queued` $\rightarrow$ `starting` $\rightarrow$ `working` $\rightarrow$ `attention_required` $\rightarrow$ `completed` / `failed` / `aborted`) and maps Reins `taskId` to native harness `sessionId` / `threadId`.
- **`loop-guard.js`**: Enforces and injects `REINS_TRACE_ID`, `REINS_HOP_COUNT`, `REINS_MAX_HOPS`, and `REINS_CALL_CHAIN` to prevent infinite cross-harness recursion.
- **`server.js`**: Lightweight local HTTP + SSE server (default `127.0.0.1:19420`) enabling multiple `reins` CLI invocations, `reins-mcp` stdio processes, and mobile clients to share a single live session pool.

### 2.3 Dual Northbound Surfaces: `src/cli/` + `skills/reins/` & `src/mcp/`
1. **`src/cli/` + `skills/reins/SKILL.md` (Northbound Surface 1: CLI + Agent Skill)**:
   - Provides `reins targets`, `reins delegate`, `reins status`, `reins steer`, `reins abort`, and `reins hub start|status|stop`.
   - **Zero Persistent Context Overhead**: Host agents load `skills/reins/SKILL.md` on demand and invoke `reins` via standard shell commands.
   - **Shell-Safe Prompt Input & Dual Output**: Supports `--prompt-stdin` and `--prompt-file` to eliminate multi-line/CJK shell-quoting issues on both PowerShell and Bash; outputs strict `H2HTaskSnapshot` JSON with `--json` or compact human-readable summaries by default.
2. **`src/mcp/` (Northbound Surface 2: Standard MCP Server)**:
   - Supports both **Embedded Mode** and **Hub Client Mode**.
   - Exposes the 5 H2H tools defined in `docs/H2H_PROTOCOL.md`: `reins_targets`, `reins_delegate`, `reins_status`, `reins_steer`, and `reins_abort`.

### 2.4 `src/transports/` —— Cross-Platform Transport Abstraction
- **`local.js`**: Spawns local child processes across Windows and Ubuntu/POSIX, including Windows executable resolution (PATH + WindowsApps Appx discovery for `codex.exe` + `.cmd` shims) and whole-process-tree termination (`taskkill /PID <pid> /T /F` on Windows, process-group signals on POSIX).
- **`ssh.js`**: Executes commands and bidirectional stdio streams over `ssh -o BatchMode=yes`, encoding dynamic payloads in Base64 to prevent remote shell-escaping vulnerabilities.

### 2.5 `src/drivers/` —— Southbound Harness Drivers (Adaptation Order)
Every driver implements the unified driver contract: `startSession()`, `sendTurn()`, `steerSession()`, `abortTurn()`, `disposeSession()`.

1. **Priority 1: `codex-app-server.js` (OpenAI Codex Driver — MVP Target)**:
   - Drives `codex app-server --stdio` over JSON-RPC 2.0 (`initialize` $\rightarrow$ `thread/start` or `thread/resume` $\rightarrow$ `turn/start` $\rightarrow$ `turn/interrupt`).
   - Supports both **`persistent` mode** (`ephemeral: false`, saved to `~/.codex/sessions` so users can run `codex resume <threadId>`) and **`ephemeral` mode** (`ephemeral: true`, clean one-shot execution).
   - Intercepts `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and `item/tool/requestUserInput` into `attention_required` state for parent-agent or mobile approval.
2. **Priority 2: `antigravity-driver.js` (Antigravity `agy` Driver)**:
   - Drives local or remote Antigravity CLI / headless & ACP workflows.
3. **Priority 3: `dsh-driver.js` (DeepSeek Harness `dsh` Driver)**:
   - Drives `dsh --profile acp` (via Agent Client Protocol NDJSON stdio) and `dsh --profile sdk`, supporting both user-default `~/.dsh` persistent sessions and isolated ephemeral runs.
4. **Priority 4: `claude-code-driver.js` (Interactive `claude-tmux` Driver)**:
   - Drives Claude Code strictly interactively inside a detached `tmux` session (`claude --session-id <uuid>` / `claude --resume <uuid>`, never `claude -p` or `--print`).
   - Uses `tmux load-buffer` + `tmux paste-buffer -p` (bracketed paste) + `tmux send-keys Enter` for prompt delivery, tails `~/.claude/projects/<slug>/<uuid>.jsonl` for structured output/thinking/tool events, and inspects `tmux capture-pane -p` for readiness and interactive permission/trust dialogs (reusing verified rules from `../dsh-claude-vps`).

---

## 3. Phased Implementation Roadmap (Dogfooding Workflow)

### Milestone 1A: Codex MVP (Core Protocol + CLI/Skill + MCP + `CodexAppServerDriver`)
- [ ] Translate all documentation and comments into English.
- [ ] Implement `src/protocol/`, `src/transports/local.js`, `src/drivers/codex-app-server.js`, `src/hub/`, `src/cli/`, and `src/mcp/`.
- [ ] Verify end-to-end on local Windows `codex.exe` (`codex-cli 0.167.0`) with unit and live integration tests (`ephemeral` review/query + `persistent` multi-turn session + `reins steer` + `reins abort`).

### Milestone 1B: Dogfooding via Local Codex — Adapt Remaining Harnesses in Order
Once Milestone 1A is live, **use Reins itself (`reins delegate local-codex ...`)** to co-develop and verify the remaining drivers in exact priority order:
1. **[x / Step 1] `codex`** (`CodexAppServerDriver` — local & SSH)
2. **[Step 2] `antigravity`** (`AntigravityDriver` — local & SSH)
3. **[Step 3] `dsh`** (`DshAcpDriver` / `DshSdkDriver` — local & SSH)
4. **[Step 4] `claudecode`** (`ClaudeTmuxDriver` / `ClaudeSdkDriver` — local & remote SSH + Tmux)

### Milestone 2: Resident Hub HTTP/SSE Daemon, `git-patch` Sync & Mobile Push (`ntfy` / `Bark`)
### Milestone 3: Reins Mobile App
