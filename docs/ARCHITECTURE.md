# Reins 系统架构设计（Architecture & Roadmap）

> **项目路径**：`C:\Users\ariab\Desktop\workspace\reins`  
> **技术栈选型**：Node.js (ESM, `>=22`)，零冗余重型依赖，核心逻辑保持纯函数化与高可测试性（`node --test`）。

---

## 1. 总体架构拓扑

Reins 采用 **「中心守护进程（Hub） + 多协议暴露（MCP & Mobile API） + 插件化南向驱动（Drivers）」** 的分层架构：

```text
  ┌───────────────────┐     ┌───────────────────┐     ┌───────────────────┐
  │ Antigravity (AGY) │     │ DeepSeek (DSH)    │     │ Claude / Codex    │
  └─────────┬─────────┘     └─────────┬─────────┘     └─────────┬─────────┘
            │ (MCP Client)            │ (MCP Client)            │ (MCP Client)
            └─────────────────────────┼─────────────────────────┘
                                      ▼
                       ┌──────────────────────────────┐
                       │      reins-mcp (Adapter)     │
                       │  stdio / Streamable HTTP MCP │
                       └──────────────┬───────────────┘
                                      │ (Local HTTP / IPC)
                                      ▼
╔═══════════════════════════════════════════════════════════════════════════╗
║                           reins-hub (Core Daemon)                         ║
║                                                                           ║
║  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐  ║
║  │ Target Registry │  │ Task & Session   │  │ Rein Policy & Loop Guard │  ║
║  │ (Local & SSH)   │  │ State Machine    │  │ (Max Hops / Approvals)   │  ║
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
• CodexDriver    • ClaudeTmuxDriver   │         • ntfy.sh / Bark  • 全局多机任务看板
• DshAcpDriver     (faex1 / vps)      │         • Feishu / Slack  • 手机端一键审批
• AgyDriver      • RemoteAcpDriver    │                           • 实时对话与 Diff
```

---

## 2. 核心模块职责划分

### 2.1 `src/hub/` —— 核心状态机与路由器
- **`registry.js`**：加载并校验配置文件（`reins.yaml`），维护所有本机与远程 Harness 节点的健康状态与并发锁。
- **`task-manager.js`**：管理 H2H 任务的完整生命周期（`queued` $\rightarrow$ `working` $\rightarrow$ `attention_required` $\rightarrow$ `completed`），维护逻辑 `taskId` 与底层 Harness `sessionId` 的映射，支持会话持久化与恢复。
- **`loop-guard.js`**：检查并注入 `REINS_TRACE_ID`、`REINS_HOP_COUNT` 与 `REINS_CALL_CHAIN`，防止跨 Harness 死循环调用。
- **`server.js`**：提供轻量级本地 HTTP + SSE 服务（例如监听 `127.0.0.1:19420`），既供多个 `reins-mcp` stdio 进程共享同一个状态池，也供手机端 App / Web 控制台接入。

### 2.2 `src/mcp/` —— 北向 MCP Server 暴露层
- 支持两种运行方式：
  1. **Standalone / Embedded 模式**：直接内嵌 Hub 核心，单进程通过 `stdio` 跑起来，适合快速在 Antigravity 或 Claude Desktop 中挂载测试。
  2. **Hub Client 模式**：多个宿主各自的 `reins-mcp` stdio 进程作为薄代理连接到后台唯一的 `reins-hub` 守护进程，确保多宿主之间的任务状态与手机端视图完全同步。
- 实现 `H2H_PROTOCOL.md` 中定义的 5 个核心工具：`reins_targets`、`reins_delegate`、`reins_status`、`reins_steer`、`reins_abort`。

### 2.3 `src/transports/` —— 传输层抽象
- **`local.js`**：封装本机子进程派生（`child_process.spawn`）、环境变量注入与跨平台信号清理（Windows / POSIX）。
- **`ssh.js`**：直接吸收并通用化 `../dsh-claude-vps` 中已验证的 SSH 传输层：
  - 统一使用 `ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 <sshHost>`。
  - 所有动态文本负载（如多行/中文 Prompt）一律通过 **Base64 编码** 传输，彻底杜绝远程 Shell 转义注入问题。

### 2.4 `src/drivers/` —— 南向 Harness 驱动器
每个驱动器实现统一的接口契约：`startSession()`, `sendPrompt()`, `pollStatus()`, `sendAction()`, `abortSession()`。

1. **`claude-tmux.js`（首期重点，直接复用 `../dsh-claude-vps` 验证成果）**：
   - 支持通过本机或远程 SSH 的 `tmux` 启动交互式 `claude --session-id <uuid>`。
   - 使用 `tmux load-buffer` + `tmux paste-buffer -p`（Bracketed Paste）+ `0.5s` 延迟 `Enter` 可靠注入单行与多行指令。
   - 通过持续监听 `~/.claude/projects/<slug>/<uuid>.jsonl` 提取结构化助手回复与工具调用，通过 `tmux capture-pane` 检测权限确认弹窗。
2. **`dsh-driver.js`（DeepSeek Harness 驱动）**：
   - 支持两种子模式：
     - `headless`：调用 `dsh --profile headless "<prompt>"` 执行一次性任务；
     - `acp`：通过 `dsh --profile acp` 建立长连接 stdio JSON-RPC 会话。
3. **`codex-driver.js`（OpenAI Codex CLI 驱动）**：
   - 调用 `codex exec --json` 解析结构化事件流，或通过 `tmux` 交互式驱动。
4. **`generic-acp.js`（通用 ACP 协议驱动）**：
   - 对接任何实现了 Agent Client Protocol 的新兴 Harness。

### 2.5 `src/notify/` —— 移动端通知与交互回调层
- **`ntfy.js` / `bark.js` / `webhook.js`**：
  - 当任务完成（`completed`）、失败（`failed`）或卡在权限确认（`attention_required`）时，立即发送推送通知。
  - 在 `ntfy.sh` 模式下，通知自带 HTTP Action 按钮，用户在手机通知栏直接点击「允许」即可回调 `reins-hub` 的 `/api/tasks/:id/steer` 接口完成远程放行。

---

## 3. 分阶段实施路线图（Roadmap for Next Sessions）

### Milestone 1：核心骨架与首个跨机闭环（MVP）
- [ ] 实现 `src/transports/ssh.js` 与 `src/transports/local.js`。
- [ ] 将 `../dsh-claude-vps` 中的 `remote.js` / `transcript.js` / `bridge.js` 提炼迁移为通用的 `src/drivers/claude-tmux.js`。
- [ ] 实现 `src/drivers/codex-driver.js` 与 `src/drivers/dsh-driver.js`。
- [ ] 实现 `src/mcp/server.js`（标准 JSON-RPC 2.0 MCP Server），挂载到 **Antigravity** 中实测：
  - 场景 A：Antigravity 指派远程 `faex1` 上的 Claude Code 执行任务并获取结果；
  - 场景 B：Antigravity 指派本机的 DSH / Codex 协同工作。

### Milestone 2：Hub 守护进程与手机即时推送
- [ ] 完成 `reins-hub` HTTP + SSE 状态服务与持久化存储。
- [ ] 接入 `ntfy` / `Bark` / 飞书通知渠道，打通「远程 Harness 弹出权限请求 $\rightarrow$ 手机收到交互推送 $\rightarrow$ 点击放行 $\rightarrow$ 远程继续执行 $\rightarrow$ 完工通知手机」全链路。
- [ ] 实现 `git-patch` 跨机工作区补丁自动同步。

### Milestone 3：Reins Mobile App（移动端独立应用）
- [ ] 设计并实现移动端配对协议（支持 Tailscale 局域网直连 + 端到端加密 Relay 转发）。
- [ ] 构建跨平台手机端 App（React Native / Flutter）：
  - 实时展示所有本机与远端 Harness 的会话列表与调用树；
  - 移动端流式阅读 Transcript、查看高亮 Git Diff；
  - 手机端直接选择任意机器上的任意 Harness 发起新任务（Take the reins）。
