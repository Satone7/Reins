# Reins — H2H (Harness-to-Harness) Protocol Implementation Architecture (`h2h/v0.1`)

> **Canonical Open Specification**: [**`github.com/Satone7/h2h-protocol`**](https://github.com/Satone7/h2h-protocol) (`h2h/v0.1`, bilingual EN / 简体中文)  
> **Status**: v0.1 Reference Implementation (Aligned with OpenAI `codex-plugin-cc` / `codex app-server`, DeepSeek Harness `@deepseek-ai/dsh-subagent*`, ACP, and `dsh-claude-vps`)  
> **Scope**: Defines how **Reins** implements the [H2H Protocol v0.1](https://github.com/Satone7/h2h-protocol) for capability discovery, project onboarding & session binding (`snapshot.project`), task delegation, multi-turn steering/resumption, interactive permission governance, and mobile notification synchronization across local and remote AI Coding Harnesses.

---

## 1. Design Goals & Ecosystem Compatibility Principles

Reins H2H synthesizes existing cross-harness communication patterns into a **unified, cross-platform (Windows + Ubuntu), transport-agnostic (Local + SSH) superset specification**:

1. **Full Compatibility with DeepSeek Harness (`@deepseek-ai/dsh-subagent*`) Contracts**:
   - Preserves DSH's strict separation between **`output`** (final assistant response blocks) and **`diagnostic`** (structured, credential-safe failure and permission facts), as well as the canonical `stopReason` vocabulary (`completed` | `aborted` | `error` | `max-tokens` | `refusal`).
   - Supports both lifecycle paradigms from `tool-subagent` and `tool-subagent-control`, aligning with `subagent`, `send_message`, `interrupt_agent`, and `list_agents`.
   - **Beyond DSH's Unattended Limitation**: Overcomes DSH's restriction where `subagent-codex` and `subagent-claude-code` only run locally in one-shot unattended mode and hard-reject every runtime approval request (`declined`/`denied`).
2. **Dialectical Dual-Mode Session Governance (`persistent` First-Class vs. `ephemeral` One-Shot)**:
   - Balances **human resumability** against **session list signal-to-noise ratio**:
     - **`persistent` Mode (First-Class User Session)**: Used for substantial feature work, multi-file refactoring, deep debugging, and iterative multi-turn tasks. Sessions are persisted directly in the target Harness's **default user session store** (`~/.codex/sessions`, `~/.claude/projects`, `~/.dsh`), making them immediately visible and resumable by the human user in native clients (`codex resume`, `claude --resume`, DSH UI, or `tmux attach`).
     - **`ephemeral` Mode (Burn-After-Reading / One-Shot Session)**: Used for granular queries, data/summary exports, single-pass code reviews, and high-frequency micro-tasks. Drivers use native ephemeral/isolated flags (`ephemeral: true` in Codex, `persistSession: false` in Claude SDK, isolated home in DSH) so micro-tasks **never dilute or clutter the user's valuable session history**.
3. **Full Compatibility with OpenAI Codex Official Protocols (`codex-plugin-cc` / `codex app-server` / `codex mcp-server`)**:
   - Drives local or remote Codex via **`codex app-server --stdio`** JSON-RPC 2.0 (`initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, and reverse `item/*/requestApproval` interception).
   - Compatible with `codex-plugin-cc` workflow presets (`task`, `review`, `adversarial-review`, `rescue`) and session handoff (`codex resume <threadId>`).
4. **Full Compatibility with `dsh-claude-vps` Interactive Tmux + JSONL Protocol**:
   - Supports driving interactive Claude Code over `SSH + Tmux Bracketed Paste + JSONL Transcript Watcher + Capture-Pane Dialog Detection`, including `attachTmux` and `resumeSessionId`.
5. **Full Compatibility with ACP (`@agentclientprotocol/sdk`)**:
   - Supports `initialize` $\rightarrow$ `session/new` / `session/resume` / `session/list` $\rightarrow$ `session/prompt` and `session/request_permission`.

---

## 2. Core Terminology & Cross-Harness Mapping

Reins exposes **two 100% isomorphic Northbound Surfaces**—**CLI + Agent Skill (`reins <subcommand>` + `skills/reins/SKILL.md`)** and **MCP Server (`reins-mcp`)**:

| Reins Concept | MCP Tool (`reins-mcp`) | CLI Subcommand (`reins` + `SKILL.md`) | DSH Equivalent (`dsh-subagent`) | OpenAI Equivalent (`codex-plugin-cc` / `mcp`) | `dsh-claude-vps` Equivalent | Description |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Target & Models** | `reins_targets` (`includeModels`) | `reins targets [--json]`<br>`reins models [targetId] [--json]` | `list_agents` / `providerName` | `/codex:setup` / `model/list` + `config/read` | `claude_vps_status` (targets) | Discover configured local/remote Harness targets, active/resumable sessions, and selectable models + reasoning efforts. |
| **Hand Over** | `reins_delegate` | `reins delegate <target> [options]` | `subagent_<provider>` | `codex` / `task` / `review` | `claude_vps_start` + `claude_vps_send` | Delegate a task to a target Harness (with optional `--model` and `--effort` selection). |
| **Inspect** | `reins_status` | `reins status [taskId] [options]` | `list_agents` / `job_output` | `status` / `result` | `claude_vps_status` + `claude_vps_read` | Query task status, incremental transcript (`sinceSeq`), pending approval dialogs, and final output. |
| **Steer** | `reins_steer` | `reins steer <taskId> <action> [msg]` | `send_message` | `codex-reply` / Approval RPC | `claude_vps_send` / `claude_vps_key` | **Unified Control Primitive**:<br>1. When `attention_required`: approve/deny permission prompts (`approve` / `approve_session` / `deny`);<br>2. When `completed`/`idle`: send follow-up turn (`reply`, optionally switching `--model` / `--effort`);<br>3. When `working`: inject mid-turn steering instruction. |
| **Pull the Reins** | `reins_abort` | `reins abort <taskId> [--kill]` | `interrupt_agent` / `job_kill` | `cancel` / `turn/interrupt` | `claude_vps_interrupt` / `stop` | Interrupt the active turn (keeps underlying session resumable by default unless `--kill` / `terminateSession: true` is passed). |

---

## 3. Target Capability Declaration: `HarnessCard`

Every target registered in `reins.yaml` exposes a standardized `HarnessCard`:

```json
{
  "id": "local-codex",
  "label": "Local OpenAI Codex (app-server)",
  "harnessType": "codex",
  "transport": {
    "kind": "local",
    "platform": "win32"
  },
  "driver": {
    "mode": "codex-app-server",
    "command": "auto",
    "capabilities": {
      "persistentSession": true,
      "ephemeralSession": true,
      "interactiveApproval": true,
      "midTurnSteer": true,
      "modelSelection": true,
      "outputSchema": true,
      "attachExisting": true
    }
  },
  "workspace": {
    "defaultWorkdir": "/workspace/reins",
    "allowedSyncModes": ["remote-native", "context-only"]
  },
  "reinPolicy": "auto-edit",
  "tags": ["coding", "review", "adversarial-review", "rescue"],
  "status": {
    "availability": "online",
    "activeTasks": 0
  }
}
```

---

## 4. `ReinPolicy` & Native Permission Mapping Matrix

Reins defines **5 standard `ReinPolicy` levels** and automatically translates them into each Harness's native permission and sandbox parameters:

| H2H `ReinPolicy` | Policy Semantics | **Codex (`codex-app-server`)** Mapping | **Claude Code (`claude-tmux` / `claude-sdk`)** Mapping | **ACP (`acp` / `dsh`)** Mapping | Hub Runtime Approval Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`free-rein`** | Unattended full access (for isolated sandboxes/containers) | `approvalPolicy: 'never'`,<br>`sandbox: 'danger-full-access'`<br>(or auto-reply `accept`) | `--permission-mode bypassPermissions`<br>(or auto-key `1. Yes`) | Auto-select `allow_always` / `allow_once` | **Auto-approves** without suspending the task; records approval fact in `diagnostic`. |
| **`auto-edit`** | Autonomous workspace edits & safe commands; gates risky operations | `approvalPolicy: 'on-request'`,<br>`approvalsReviewer: 'auto_review'`,<br>`sandbox: 'workspace-write'` | `--permission-mode acceptEdits` | Auto-allow `read`/`edit`/`search`; gate others | Routine workspace operations run automatically; out-of-bounds requests transition to `attention_required`. |
| **`parent-rein`** | Suspend on permission prompt and delegate decision to parent Harness | `approvalPolicy: 'on-request'`,<br>`sandbox: 'workspace-write'` | `--permission-mode default` | Suspend `session/request_permission` Promise | Transitions task to **`attention_required`** and returns the prompt in `H2HTaskSnapshot.attention` for parent-agent `reins_steer`. |
| **`tight-rein`** | Suspend on permission prompt and push interactive alert to human mobile device | `approvalPolicy: 'on-request'`,<br>`sandbox: 'workspace-write'` | `--permission-mode default` | Suspend `session/request_permission` Promise | Transitions task to **`attention_required`** and fires **H2M Push (`ntfy`/Bark/App)** for human approval. |
| **`plan-only`** | Strict read-only analysis / code review (matches `/codex:review`) | `approvalPolicy: 'never'`,<br>`sandbox: 'read-only'` | `--permission-mode plan` | Deny write/execute permissions; allow `read`/`search`/`think` | Automatically declines (`decline`/`deny`) any write or destructive command and records it in `diagnostic`. |

---

## 4.5 Model Catalog Discovery & Reasoning Effort Selection (`H2HModelCatalog` & `ReasoningEffort`)

Different tasks require different cost, latency, and reasoning depth trade-offs (e.g., selecting a lightweight model with `low` effort for an `ephemeral` summary export vs. selecting a frontier model with `high`/`xhigh`/`ultra` effort for a complex `persistent` architectural refactoring or adversarial review). Reins H2H standardizes **dynamic model discovery** and **per-session / per-turn model & effort selection**.

### 4.5.1 Canonical `ReasoningEffort` Vocabulary

```typescript
export type ReasoningEffort =
  | 'low'     // Fast responses with lighter reasoning
  | 'medium'  // Balanced speed and reasoning depth for everyday tasks
  | 'high'    // Greater reasoning depth for complex problems
  | 'xhigh'   // Extra high reasoning depth for complex problems
  | 'max'     // Maximum reasoning depth
  | 'ultra';  // Ultra-deep frontier reasoning (supported on Codex Sol/Astra/Terra models)
```

### 4.5.2 Canonical Model Catalog Schema (`H2HModelCatalog`)

Querying a target via CLI (`reins models [targetId] --json`), MCP (`reins_targets({ targetId, includeModels: true })`), or Hub HTTP (`GET /models?targetId=<id>`) returns an **`H2HModelCatalog`**:

```typescript
export interface H2HModelDescriptor {
  /** Canonical model identifier passed via --model / model (e.g. 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna') */
  readonly id: string;
  readonly model: string;
  /** Human-readable display name (e.g. 'GPT-6.1-Sol') */
  readonly displayName: string;
  /** Model capability summary */
  readonly description: string;
  /** True if marked as the catalog-wide default model by the Harness server */
  readonly isDefault: boolean;
  /** Default reasoning effort for this model when effort is not explicitly overridden */
  readonly defaultEffort: ReasoningEffort | null;
  /** Supported reasoning effort levels for this specific model */
  readonly supportedEfforts: ReasoningEffort[];
  /** Human-readable descriptions for each supported reasoning effort */
  readonly effortDetails?: Array<{
    readonly effort: ReasoningEffort;
    readonly description: string;
  }>;
  /** Supported input modalities (e.g. ['text', 'image']) */
  readonly inputModalities: string[];
}

export interface H2HModelCatalog {
  readonly targetId: string;
  readonly kind: 'codex' | 'antigravity' | 'dsh' | 'claude-code' | 'acp';
  /** Active user/target defaults prior to per-task overrides */
  readonly currentConfig: {
    readonly model: string | null;
    readonly effort: ReasoningEffort | null;
    readonly provider: string | null;
  };
  readonly models: H2HModelDescriptor[];
}
```

### 4.5.3 Four-Tier Model & Effort Resolution Precedence

When a task is delegated (`reins_delegate`) or steered (`reins_steer`), the effective `model` and `effort` are resolved in strict priority order:

1. **Tier 1 — Per-Turn / Per-Task Explicit Override** (`delegate.model` / `delegate.effort` or `steer.model` / `steer.effort`):
   Highest precedence. Allows callers to pick `model` and `effort` at session creation time, or dynamically upgrade/downgrade `model` and `effort` on follow-up turns (`reins steer <taskId> reply --model ... --effort ...`).
2. **Tier 2 — Target Configuration Default in `reins.yaml`** (`targets.<id>.model` / `targets.<id>.effort`):
   Target-specific baseline configured in Reins Hub.
3. **Tier 3 — Native Harness User Configuration**:
   The user's local/remote Harness settings (e.g., `~/.codex/config.toml` `model` and `model_reasoning_effort` read via `config/read`).
4. **Tier 4 — Harness Catalog Default**:
   The catalog entry with `isDefault: true` and its `defaultReasoningEffort`.

### 4.5.4 Southbound Wire Mapping for Model Discovery & Selection

| Target Harness | Model & Effort Discovery Mechanism | Session Start / Resume Wire Mapping (`delegate`) | Mid-Session Turn Wire Mapping (`steer reply`) |
| :--- | :--- | :--- | :--- |
| **1. OpenAI Codex**<br>(`codex-app-server`) | JSON-RPC `model/list` (`{}`) + `config/read` (`{ includeLayers: false }`) over stdio or SSH | `thread/start` & `thread/resume`:<br>• `model: effectiveModel`<br>• `config: { model_reasoning_effort: effectiveEffort }`<br>Records returned `res.model` & `res.reasoningEffort` onto `snapshot`. | `turn/start`:<br>• `model: effectiveModel`<br>• `effort: effectiveEffort` |
| **2. Antigravity**<br>(`agentapi` / `agy-cli`) | Configured target catalog (`inherit`, `flash_lite`, `flash`, `pro`) | `agentapi new-conversation --model=<model>` or `agy --model <model>` | Preserves conversation model or passes `--model <model>` on CLI resume |
| **3. DeepSeek Harness**<br>(`acp` / `dsh-headless`) | Configured target catalog / `~/.dsh` profile | ACP `session/new` `_meta.model` or `dsh --profile headless --model <model>` | Subsequent `session/prompt` or `--session-id <id> --model <model>` |
| **4. Claude Code**<br>(`claude-tmux`) | Standard aliases (`sonnet`, `opus`, `haiku`) & efforts (`low`, `medium`, `high`, `max`) | Interactive `tmux new-session` with `claude --session-id <uuid> --model <model> --effort <effort>` (never `claude -p`) | Interactive `tmux` bracketed paste (`paste-buffer -p` + `Enter`) or `claude --resume <sessionId> --model <model> --effort <effort>` |

---

## 5. H2H Task State Machine & Result Envelope (`H2HTaskSnapshot`)

### 5.1 Task Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> queued: reins_delegate()
    queued --> starting: Spawn process/SSH & validate/sync Workspace
    starting --> working: Handshake complete & Turn Prompt submitted
    working --> attention_required: Intercept approval request (Approval/CanUseTool/TmuxDialog/UserInput)
    attention_required --> working: reins_steer(approve / approve_session / deny / reply)
    working --> completed: Turn finished cleanly (stopReason = completed)
    working --> failed: Process crash / protocol error / limit hit (stopReason = error | max-tokens | refusal)
    working --> aborted: reins_abort() (stopReason = aborted)
    attention_required --> aborted: reins_abort()
    completed --> working: reins_steer(action='reply', message='...') [Persistent continuation]
    aborted --> working: reins_steer(action='reply', message='...') [Resume after interrupt]
```

### 5.2 Canonical Task Snapshot Schema (`H2HTaskSnapshot`)

Every Northbound operation (`reins_delegate`, `reins_status`, `reins_steer`, `reins_abort`) returns a deterministic, JSON-safe **`H2HTaskSnapshot`**:

```typescript
export interface H2HTaskSnapshot {
  /** Protocol version identifier */
  readonly protocol: 'reins-h2h/v0.2';
  /** Reins Hub globally unique task identifier */
  readonly taskId: string;
  /** Target node ID (e.g. 'local-codex', 'local-agy', 'local-dsh', 'remote-claude') */
  readonly target: string;
  /** Short human-readable task summary */
  readonly description?: string;
  /** Session persistence mode ('persistent' = first-class user session; 'ephemeral' = one-shot) */
  readonly sessionMode: 'persistent' | 'ephemeral';
  /** Effective ReinPolicy governing this task */
  readonly reinPolicy: 'free-rein' | 'auto-edit' | 'parent-rein' | 'tight-rein' | 'plan-only';
  /** Effective model identifier used for this session/turn (e.g. 'gpt-6.1-sol', 'gpt-6-luna', 'flash_lite') */
  readonly model?: string;
  /** Effective reasoning effort level used for this session/turn */
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

  /** Underlying native Harness session metadata for human/agent handoff */
  readonly nativeSession: {
    readonly harnessType: 'codex' | 'antigravity' | 'dsh' | 'claude-code' | 'acp';
    readonly driverMode: 'codex-app-server' | 'agy-cli' | 'acp' | 'dsh-sdk' | 'claude-tmux' | 'claude-sdk';
    /** Native session ID (Codex threadId / Claude session UUID / DSH sessionId) */
    readonly sessionId: string;
    /** Active turn ID (e.g. Codex turnId) */
    readonly turnId?: string;
    /** Working directory on the target host */
    readonly workdir: string;
    /** Tmux session name when driven via claude-tmux */
    readonly tmuxSession?: string;
    /** Copy-pasteable native CLI command for a human to resume this session (when sessionMode === 'persistent') */
    readonly resumeCommandHint?: string;
  };

  /** Current task status */
  readonly status:
    | 'queued'
    | 'starting'
    | 'working'
    | 'attention_required'
    | 'completed'
    | 'failed'
    | 'aborted';

  /** Whether follow-up turns via reins_steer(reply) are supported */
  readonly continuable: boolean;
  /** True when waitSec elapsed while the task is still running in the background */
  readonly timedOutWaiting?: boolean;

  /**
   * Terminal or active stop reason (100% compatible with DSH SubagentStopReason, plus 'running' and 'attention-required')
   */
  readonly stopReason:
    | 'running'
    | 'attention-required'
    | 'completed'
    | 'aborted'
    | 'error'
    | 'max-tokens'
    | 'refusal';

  /**
   * Final non-empty assistant output blocks (matches DSH SubagentResult.output)
   */
  readonly output: Array<{
    readonly type: 'text';
    readonly text: string;
  }>;

  /**
   * Validated structured output when outputSchema was requested (matches DSH SubagentResult.structured)
   */
  readonly structured?: unknown;

  /**
   * Structured, credential-safe failure and permission diagnostic facts (matches DSH SubagentResult.diagnostic, <= 4096 UTF-8 bytes)
   */
  readonly diagnostic?: string;

  /**
   * Present when status === 'attention_required': normalized approval or user-input request
   */
  readonly attention?: {
    readonly requestId: string;
    readonly kind: 'command_approval' | 'file_approval' | 'permission_grant' | 'user_input' | 'login_or_trust';
    readonly title: string;
    readonly summary: string;
    readonly rawDetail?: string;
    readonly options: Array<{
      readonly action: 'approve' | 'approve_session' | 'deny' | 'reply';
      readonly label: string;
      readonly description?: string;
    }>;
  };

  /**
   * Incremental conversation & tool transcript (compatible with dsh-claude-vps sinceSeq polling)
   */
  readonly transcript?: {
    readonly seq: number;
    readonly sinceSeq: number;
    readonly messages: Array<{
      readonly seq: number;
      readonly role: 'user' | 'assistant' | 'thinking' | 'tool';
      readonly text: string;
      readonly tool?: {
        readonly name: string;
        readonly status: 'running' | 'completed' | 'interrupted' | 'error';
        readonly summary?: string;
      };
    }>;
    readonly paneTail?: string[];
  };

  /**
   * Cross-host workspace artifacts (populated when workspaceMode === 'git-patch')
   */
  readonly artifacts?: {
    readonly gitPatch?: string;
    readonly modifiedFiles?: string[];
  };

  /** Execution timestamps and duration */
  readonly timing: {
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly durationMs: number;
  };
}
```

---

## 6. Southbound Wire Drivers & Dual Session Lifecycle Contract

Reins decouples the **Transport Layer (`LocalTransport` vs. `SshTransport`)** from the **Wire Driver Layer**. Every stdio-based driver can run either as a local child process or across an SSH tunnel.

> [!IMPORTANT]
> **Dual-Mode Session Lifecycle Governance (`persistent` First-Class vs. `ephemeral` One-Shot)**:
> To balance **human take-over capability** against **session list cleanliness**, Reins supports `sessionMode: 'persistent' | 'ephemeral'` (with boolean alias `continuable: true | false`):
> - **When to use `persistent` (First-Class User Session — default for `preset: 'task' | 'rescue'`)**:
>   Iterative feature development, multi-file refactoring, deep debugging, multi-turn `reins steer` workflows, or tasks the human user may want to inspect and resume in their native Harness client (`codex resume`, `claude --resume`, DSH session list).
> - **When to use `ephemeral` (Burn-After-Reading Session — default for `preset: 'review' | 'adversarial-review'` and micro-tasks)**:
>   Data/summary exports, quick file explanations, single-pass code reviews, or high-frequency parallel subtasks that would otherwise clutter and dilute the user's primary session history.

| Target Harness (Adaptation Order) | **`persistent` Mode (First-Class User Session)** Behavior & Human Handoff | **`ephemeral` Mode (Burn-After-Reading)** Behavior (Zero Session List Clutter) | Resuming an Existing Session (`sessionId`) |
| :--- | :--- | :--- | :--- |
| **1. OpenAI Codex**<br>(`codex-app-server`) | • `thread/start` sends **`ephemeral: false`**<br>• Saved to `~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`<br>• Human can run `codex resume <threadId>` or view in Codex UI | • `thread/start` sends **`ephemeral: true`** (matches DSH `subagent-codex`)<br>• In-memory only; torn down on turn completion without writing to `~/.codex/sessions/` | Pass `sessionId: "<threadId>"` (invokes JSON-RPC `thread/resume` `{ threadId }`). |
| **2. Antigravity**<br>(`agy-cli`) | • Uses default user workspace/conversation store; exposes conversation ID for UI/CLI continuation | • Runs in temporary scratch conversation context and cleans up on completion | Pass `sessionId: "<conversationId>"`. |
| **3. DeepSeek Harness**<br>(`acp` / `dsh-sdk`) | • Uses user's primary `~/.dsh` store<br>• Top-level session (`origin !== 'subagent'`) with `sessions.flush()`<br>• Directly visible in DSH TUI / Web UI session list | • Uses isolated `~/.reins/ephemeral-dsh-home` (matches DSH `subagent-dsh-sdk`) so the user's primary `~/.dsh` list stays clean | Pass `sessionId: "<sessionId>"` (invokes ACP `session/resume` `{ sessionId, cwd }`). |
| **4. Claude Code**<br>(`claude-tmux`) | • Interactive `tmux` session (`claude --session-id <uuid>` / `--resume <uuid>`, never `-p`)<br>• Saved to `~/.claude/projects/<slug>/<uuid>.jsonl`<br>• Human can run `claude --resume <uuid>`, `/resume`, or `tmux attach -t =<tmuxSession>` | • Runs interactively inside a temporary `tmux` session, then kills the `tmux` session and removes the scratch `.jsonl` upon turn completion | Pass `sessionId: "<uuid>"` (`claude --resume <uuid>`) or reuse active `tmuxSession`. |

---

## 7. Call-Chain Loop Guard & Workspace Handoff Contract

### 7.1 Call-Chain Loop Guard (`H2H_*` & `REINS_*` Environment Headers)
When spawning local subprocesses or remote SSH commands, Reins reads `H2H_*` (falling back to `REINS_*`) and injects both standard and legacy headers:
- `H2H_TRACE_ID` (`REINS_TRACE_ID`): Global trace identifier (e.g., `tr_01j9x8k2m`)
- `H2H_HOP_COUNT` (`REINS_HOP_COUNT`): Current delegation depth (`parentHop = incoming ?? 0`, `childHop = parentHop + 1`)
- `H2H_MAX_HOPS` (`REINS_MAX_HOPS`): Maximum allowed hop count (default `3`; monotonic ceiling `min(requested, inherited)`)
- `H2H_CALL_CHAIN` (`REINS_CALL_CHAIN`): Comma-delimited list of visited target IDs (e.g., `local-agy,local-codex`)

**Enforcement Rules**:
1. If `childHop > effectiveMaxHops`, `reins_delegate` rejects immediately with `stopReason: 'error'` and diagnostic category `depth-limit`.
2. If `target` is already present in `CALL_CHAIN` and `allowTargetReentry: true` is not explicitly set, `reins_delegate` blocks the cyclic call.

### 7.2 Cross-Host Workspace Modes (`workspaceMode`)
1. **`remote-native` (Default)**: Executes directly inside `workdir` on the target host.
2. **`git-patch`**: Synchronizes the caller's base commit and uncommitted `git diff` into an isolated remote worktree before execution, and captures the resulting `git diff` into `H2HTaskSnapshot.artifacts.gitPatch` upon completion.
3. **`context-only`**: Packs inline context/diffs into the prompt and defaults to `reinPolicy: 'plan-only'` for read-only reviews and consultations.

---

## 8. Dual Northbound Surface Specification: CLI + `SKILL.md` & MCP Server

Reins provides two 100% isomorphic Northbound entry points backed by the same `reins-hub` engine:

### 8.1 The Five Core Primitives: MCP Tools vs. CLI Subcommands

#### ① `reins_targets` / `reins targets` & `reins models`
Lists configured local/remote Harness targets, capabilities, active/resumable tasks, and selectable model catalogs.

| Semantic | MCP Parameter (`reins_targets`) | CLI Option (`reins targets` / `reins models`) | Description |
| :--- | :--- | :--- | :--- |
| Target ID | `targetId?: string` | `reins models [targetId]` | Inspect a specific target and query its live `H2HModelCatalog` (defaults to `local-codex` in `reins models`). |
| Include models | `includeModels?: boolean` | `reins models [targetId]` | When `true` (or when `targetId` is passed), queries selectable models, supported `ReasoningEffort` levels, and current user defaults. |
| Filter by tag | `filterTag?: string` | `--tag <tag>` | Filter targets by capability tag (e.g. `coding`, `review`). |
| Include sessions | `includeSessions?: boolean` (default `true`) | `--no-sessions` | Whether to include active and resumable tasks. |
| Output format | *(Structured JSON + rendered text)* | `--json` | Outputs strict JSON when `--json` is set; human-readable list otherwise. |

#### ② `reins_delegate` / `reins delegate`
Delegates a task to a target Harness or resumes an existing session.

| Semantic | MCP Parameter (`reins_delegate`) | CLI Option (`reins delegate <target>`) | Description |
| :--- | :--- | :--- | :--- |
| Target ID | `targetId: string` **(required)** | `<target>` **(positional 1)** | Target node ID (e.g. `local-codex`, `local-agy`, `local-dsh`, `remote-claude`). |
| Task prompt | `prompt: string` **(required)** | `-p, --prompt <text>` or<br>`-f, --prompt-file <path>` or<br>`--prompt-stdin` | Full instructions for the target Harness. **CLI supports file and `stdin` input to avoid PowerShell/Bash quoting pitfalls.** |
| Short title | `description?: string` | `-d, --desc <text>` | 3–8 word task title (compatible with DSH `description`). |
| Workflow preset | `preset?: 'task' \| 'review' \| 'adversarial-review' \| 'rescue'` | `--preset <name>` | `task`/`rescue` default to `persistent`; `review`/`adversarial-review` default to `ephemeral` + `plan-only` policy. |
| Session mode | `sessionMode?: 'persistent' \| 'ephemeral'`<br>*(alias `continuable?: boolean`)* | `--persistent` or `--ephemeral` (`--one-shot`) | `persistent`: saved in user's native Harness session list for multi-turn/human resume. `ephemeral`: one-shot execution without session list clutter. |
| Working dir | `cwd?: string` | `--cwd <path>` | Override target working directory. |
| Workspace mode | `workspaceMode?: 'remote-native' \| 'git-patch' \| 'context-only'` | `--workspace-mode <mode>` | Default `remote-native`. |
| Rein policy | `reinPolicy?: 'free-rein' \| 'auto-edit' \| 'parent-rein' \| 'tight-rein' \| 'plan-only'` | `--policy <policy>` | Override target's default `ReinPolicy`. |
| Model override | `model?: string` | `--model <id>` | Optional model override (e.g. `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `flash_lite`). |
| Reasoning effort | `effort?: 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max' \| 'ultra'` | `--effort <level>` | Optional reasoning effort override (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`). |
| Resume session | `sessionId?: string` | `--session <id>` | Resume an existing native session ID (`threadId` / `uuid`). |
| Attach tmux | `attachTmux?: string` | `--attach-tmux <name>` | Attach to an existing remote tmux session (`claude-tmux` only). |
| Run in background | `wait?: boolean` (default `true`) | `--wait` / `--bg` | When `--bg` (`wait: false`), spawns detached worker and returns `taskId` immediately. |
| Turn timeout | `timeoutSec?: number` (default `600`) | `--timeout <sec>` | Max turn duration in seconds. |
| JSON output | *(Structured object)* | `--json` | Emit `H2HTaskSnapshot` JSON. |

#### ③ `reins_status` / `reins status`
Queries the latest `H2HTaskSnapshot`, incremental transcript messages, and pending approval prompts.

| Semantic | MCP Parameter (`reins_status`) | CLI Option (`reins status [taskId]`) | Description |
| :--- | :--- | :--- | :--- |
| Task ID | `taskId?: string` | `[taskId]` | Target task ID, or list recent tasks when omitted. |
| Status filter | `status?: string` | `--status <status>` | Filter task list by status (`running`, `completed`, `attention_required`, etc.). |
| Target filter | `targetId?: string` | `--target <targetId>` | Filter task list by target ID. |
| Limit | `limit?: number` (default `20`) | `--limit <n>` | Maximum number of tasks to return when listing. |
| JSON output | *(Structured object)* | `--json` | Emit `H2HTaskSnapshot` JSON. |

#### ④ `reins_steer` / `reins steer`
Approves/denies an `attention_required` permission request, sends a follow-up turn to a `persistent` session, or steers an active turn.

| Semantic | MCP Parameter (`reins_steer`) | CLI Option (`reins steer <taskId> <action>`) | Description |
| :--- | :--- | :--- | :--- |
| Task ID | `taskId: string` **(required)** | `<taskId>` **(positional 1)** | Target task ID. |
| Action | `action: 'reply' \| 'approve' \| 'reject' \| 'interrupt'` **(required)** | `<action>` **(positional 2)** | `approve` (allow tool call), `reject` (decline tool call), `interrupt` (abort active turn), or `reply` (follow-up prompt / multi-turn continuation). |
| Message text | `message?: string` | `[message]` or `-p, --prompt <text>` or `--prompt-file <path>` or `--prompt-stdin` | Follow-up prompt when `action === 'reply'`. |
| Model override | `model?: string` | `--model <id>` | Optional model switch for the steered follow-up turn. |
| Reasoning effort | `effort?: 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max' \| 'ultra'` | `--effort <level>` | Optional reasoning effort switch for the steered follow-up turn. |
| Foreground wait | `wait?: boolean` (default `true`) | `--wait` / `--bg` | Whether to wait for the steered turn to complete. |
| JSON output | *(Structured object)* | `--json` | Emit `H2HTaskSnapshot` JSON. |

#### ⑤ `reins_abort` / `reins abort`
Interrupts the active turn or terminates the underlying session.

| Semantic | MCP Parameter (`reins_abort`) | CLI Option (`reins abort <taskId>`) | Description |
| :--- | :--- | :--- | :--- |
| Task ID | `taskId: string` **(required)** | `<taskId>` **(positional 1)** | Target task ID. |
| Kill session | `terminateSession?: boolean` (default `false`) | `--kill` | Default `false` interrupts only the current turn while keeping the session resumable; `--kill` / `true` terminates the underlying process/tmux session. |
| JSON output | *(Structured object)* | `--json` | Emit `H2HTaskSnapshot` JSON. |
