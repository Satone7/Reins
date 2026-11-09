# Protocol & Open-Source Ecosystem Research: From A2A / ACP / MCP to H2H (Harness-to-Harness)

> **Purpose**: Survey 2025–2026 AI agent interop protocols, OpenAI's official cross-harness integrations (`openai/codex-plugin-cc` & `codex app-server`), DeepSeek Harness (`dsh`) subagent packages (`@deepseek-ai/dsh-subagent*`), and the `dsh-claude-vps` remote bridge, establishing the exact compatibility design and architectural niche for the **Reins H2H Protocol**.

---

## 1. The Four Major Open Protocols: Why Do We Still Need H2H?

Four major open protocols currently exist around AI agent interoperability (**MCP**, **A2A**, **ACP**, and **AHP**), each operating at a different abstraction layer. **None of them directly solves cross-host, cross-vendor AI Coding Harness delegation with shared workspace context, native session lifecycle governance, and interactive permission handoff.**

| Protocol | Maintainer | Connection Topology | Core Primitives | Why Not Use It Directly as H2H? | How Reins Uses & Extends It |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **MCP**<br>*(Model Context Protocol)* | Anthropic<br>(Industry Standard) | **Harness $\leftrightarrow$ Tool / Data**<br>(Agent calls external tools and resources) | `tools/list`, `tools/call`, and async extension **`io.modelcontextprotocol/tasks`** (`working`, `input_required`, `completed`) | MCP is a client-to-tool protocol; it lacks target host routing, Git workspace synchronization, multi-harness call-chain loop guards, and terminal permission dialog interception. | **Northbound Surface 2 (`reins-mcp`)**: Every mainstream Harness supports MCP Client connections, so Reins exposes itself as a standard MCP Server (alongside its CLI + `SKILL.md` surface). |
| **A2A**<br>*(Agent2Agent Protocol)* | Google $\rightarrow$<br>Linux Foundation | **Cloud Agent $\leftrightarrow$ Cloud Agent**<br>(Cross-org black-box agent collaboration) | `Agent Card` (JSON capability declaration), `Task` lifecycle, Artifact exchange, HTTP + SSE | Designed for stateless cloud microservice agents. **Lacks primitives for local filesystems, Git branches/patches, SSH tunnels, and interactive PTY/Tmux sessions.** | **Conceptual Model**: Reins adapts A2A's `Agent Card` into `HarnessCard` and aligns with its asynchronous task state machine. |
| **ACP**<br>*(Agent Client Protocol)* | Zed Industries &<br>JetBrains | **IDE / Editor $\leftrightarrow$ Coding Harness**<br>(Code editor drives a local agent) | NDJSON stdio / JSON-RPC 2.0: `initialize`, `session/new`, `session/resume`, `session/prompt`, `session/update`, `session/request_permission`, `session/cancel` | ACP is a 1-to-1 local editor-to-agent protocol. It does not route across remote SSH hosts or prevent cross-harness recursion loops. | **Southbound Driver (`acp`)**: Directly compatible with `@agentclientprotocol/sdk` messages, permission callbacks, and `StopReason` vocabulary. |
| **AHP**<br>*(Agent Host Protocol)* | Microsoft<br>(VS Code Team) | **Agent Host Daemon $\leftrightarrow$ Multi-UI**<br>(Background daemon syncs state to multiple UIs) | Channel (`ahp-root://`), immutable Actions, and Reducer state tree synchronization | Focused on decoupling VS Code UI state from a single host process rather than cross-vendor harness orchestration. | **Mobile Sync Reference**: `reins-hub` uses a similar single-daemon, multi-client (CLI + MCP + Mobile App) real-time event subscription architecture. |

---

## 2. Deep Dive into Existing Cross-Harness Implementations

To ensure maximum compatibility with existing ecosystems, we inspected the source code and wire protocols of **OpenAI's official Claude Code plugin**, **Codex's native app-server**, **DeepSeek Harness (`dsh`) subagent packages**, and **`dsh-claude-vps`**.

### 2.1 OpenAI's Official Cross-Harness Stack: `openai/codex-plugin-cc`, `codex mcp-server`, and `codex app-server`

#### (1) `openai/codex-plugin-cc` (Official Codex Plugin for Claude Code)
- **Mechanism**: Uses Claude Code Slash Commands and Skills to invoke a companion CLI broker (`codex-companion.mjs`) that manages background jobs and local state files.
- **Core Primitives**:
  - Delegation: `task` / `/codex:rescue` (delegate coding or debugging), `/codex:review` (read-only code review), `/codex:adversarial-review` (skeptical challenge review).
  - Async Job Control: `status [job-id] --json`, `result [job-id] --json`, `cancel [job-id] --json`.
  - Context Transfer: `/codex:transfer` serializes the active context into a persistent Codex thread and outputs `codex resume <thread-id>` for the human developer.
- **Job Tracking Schema**:
  `{ id, status/phase: 'running' | 'completed' | 'cancelled' | 'failed', pid, completedAt, codex/stdout, errorMessage }`.

#### (2) `codex mcp-server` (Built-in MCP Server Mode)
- Exposes two MCP tools:
  - `codex`: Starts a new session with `prompt`, `cwd`, `model`, `sandbox` (`read-only` | `workspace-write` | `danger-full-access`), and `approval-policy` (`never` | `on-request` | `untrusted`).
  - `codex-reply`: Continues an existing session via `conversationId` / `threadId` and `prompt`.

#### (3) `codex app-server --stdio` (Bidirectional JSON-RPC 2.0 Wire Protocol)
This is Codex's authoritative programmatic control protocol (also used by IDE extensions and DSH's `subagent-codex`):
- **Lifecycle Handshake**:
  1. `initialize` (`clientInfo`, `capabilities`) $\rightarrow$ `initialized` notification;
  2. `thread/start` (`cwd`, `ephemeral`, `model`, `approvalPolicy`, `approvalsReviewer`, `sandbox`) or `thread/resume` (`threadId`) $\rightarrow$ returns `thread.id`;
  3. `turn/start` (`threadId`, `input: [{ type: 'text', text, text_elements: [] }]`) $\rightarrow$ returns `turn.id`;
  4. Streaming Notifications: `turn/started` $\rightarrow$ `item/completed` (containing `agentMessage` with `phase: 'commentary' | 'final_answer' | null`) $\rightarrow$ `turn/completed` (`status: 'completed' | 'interrupted' | 'failed'`, `error.codexErrorInfo`);
  5. Cancellation: `turn/interrupt` (`{ threadId, turnId }`).
- **Reverse Server-to-Client Approval Requests**:
  During a turn, `codex app-server` sends JSON-RPC requests to the host client awaiting a decision:
  - `item/commandExecution/requestApproval` (decisions: `accept` / `decline` / `cancel`)
  - `item/fileChange/requestApproval`
  - `item/permissions/requestApproval`
  - `item/tool/requestUserInput`
  - `mcpServer/elicitation/request`

---

### 2.2 DeepSeek Harness (`dsh`) Subagent Architecture (`@deepseek-ai/dsh-subagent*`)

From our source-level inspection of `deepseek-harness/packages/subagent/`, DSH defines a clean delegation seam (`ctx.subagents`):

#### (1) Model-Facing Tool Surface (`tool-subagent` + `tool-subagent-control`)
1. **Delegation Tool (`subagent_<provider>`)**:
   - Input: `{ description, prompt, run_in_background?, provider?, model?, reasoning_effort? }`.
   - Two lifecycle modes (`backgroundMode`):
     - `one-shot`: Waits in foreground by default (`{ kind: 'foreground', runId, output }`), or returns `{ kind: 'background', jobId }` when `run_in_background: true`.
     - `continuable`: Starts a persistent background child agent immediately (`{ kind: 'continuable', subagentId }`) that remains available for follow-up turns.
2. **Send Message / Steer (`send_message`)**:
   - Input: `{ agent_id, message }` $\rightarrow$ `{ messageId }`.
   - **Key Semantic**: If the target child is currently `running`, the message **steers** its nearest step boundary; if the child is `idle` or `ready`, it **starts a new turn**.
3. **Interrupt Turn (`interrupt_agent`)**:
   - Input: `{ agent_id }` $\rightarrow$ `{ accepted: true }`.
   - **Key Semantic**: Stops **only the current turn**, keeping the child session intact for later `send_message` follow-ups.
4. **List Subagents (`list_agents`)**:
   - Input: `{ scope: 'children' | 'descendants' }` $\rightarrow$ `[{ kind: 'child', id, label, status: 'running' | 'idle' | 'ready', parent?, depth? }]`.

#### (2) Result & Safe Diagnostic Contract (`SubagentResult`)
DSH enforces a strict separation in its terminal result structure that Reins adopts directly:
- **`output`**: `ContentBlock[]` — Contains only the child's final non-empty assistant answer (e.g., Codex `phase: 'final_answer'`).
- **`structured?`**: `unknown` — Validated JSON output when `outputSchema` is requested.
- **`diagnostic?`**: `string` — Structured, credential-safe failure and permission facts (e.g., `product: Codex; stage: turn; category: access-policy`), strictly separated from `output` and capped at 4096 bytes.
- **`stopReason`**: `'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'` (extended in Reins with `'running'` and `'attention-required'`).

#### (3) Limitations of DSH's Built-In Product Providers (Where Reins Advances the State of the Art)
- DSH's `subagent-codex` and `subagent-claude-code` are hardcoded as **local-only, one-shot only (`ephemeral: true` / `persistSession: false`), and strictly unattended**.
- Whenever Codex emits `item/commandExecution/requestApproval` or Claude Code invokes `canUseTool`, DSH's providers **hardcode an automatic refusal (`decline` / `deny` / `cancel`)** with `"the provider does not grant interactive approval"`.
- Furthermore, when remote Claude Code environments disallow `-p` headless execution, `@anthropic-ai/claude-agent-sdk` cannot be used—requiring the interactive **`SSH + Tmux + JSONL` driver** verified in `../dsh-claude-vps`.

---

## 3. How Reins H2H Unifies and Elevates the Ecosystem

| Dimension | `openai/codex-plugin-cc` | DSH `subagent-codex` / `claude-code` | `dsh-claude-vps` | **Reins H2H Protocol (This Project)** |
| :--- | :--- | :--- | :--- | :--- |
| **Northbound Surface** | CLI + Skill (`codex-companion.mjs`) | Internal DSH Tools only | Internal DSH Tools only | **Both CLI + `SKILL.md` AND Standard MCP Server (`reins-mcp`)** |
| **Execution Transport** | Local only | Local only | Remote SSH only | **Unified `Local` + `SSH` Transports** |
| **Session Lifecycle** | Persistent (`codex resume`) | Ephemeral one-shot only | Persistent (`--resume` / tmux) | **Dual Mode: `persistent` (First-Class User Session) & `ephemeral` (Burn-After-Reading)** |
| **Permission Handling** | Pre-configured sandbox only | **Hardcoded `decline` / `deny`** | Manual tmux keys (`claude_vps_key`) | **5-Tier `ReinPolicy` (`free-rein`, `auto-edit`, `parent-rein`, `tight-rein`, `plan-only`)** |
| **Mobile Control** | None | None | None | **H2M Event Stream (`ntfy.sh` / Bark Action Buttons + Reins Mobile App)** |
