# 协议与开源生态深度调研：从 A2A / ACP / MCP 到 H2H (Harness-to-Harness)

> 文档定位：梳理 2025–2026 年 AI Agent 互通协议标准与相关开源项目，明确 **Reins** 在协议栈中的生态位——填补 **H2H (Harness-to-Harness)** 与 **H2M (Harness-to-Mobile)** 的空白。

---

## 一、 现有四大标准协议调研：有没有现成的“H2H”协议？

目前业界围绕 AI Agent 互通已经形成了 **4 个主流开放协议**（MCP、A2A、ACP、AHP），但它们分别工作在不同的抽象层，**没有任何一个直接解决了「不同研发 Harness 之间跨本机/远程互调并共享工程上下文」的问题**。

### 1. 四大协议对比全景图

| 协议名称 | 发起方 / 维护组织 | 解决的连接关系 | 核心原语 / 机制 | 为什么不能直接当作 H2H 照搬？ | Reins 如何利用它？ |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **MCP**<br>*(Model Context Protocol)* | Anthropic<br>(全行业采纳) | **Harness $\leftrightarrow$ Tool / Data**<br>(Agent 调用外部工具与数据源) | `tools/list`, `tools/call`, 以及 2026-07 新增的异步扩展 **`io.modelcontextprotocol/tasks`** (`working`, `input_required`, `completed`) | MCP 本质是「客户端调工具」，本身不包含目标机器路由、Git 工作区同步、多 Harness 会话拓扑与终端权限弹窗接管。 | **作为 Reins 的北向接口（Northbound API）**：所有主流 Harness 都支持作为 MCP Client，因此 Reins 向上伪装成一个标准 MCP Server，让宿主零改造接入。 |
| **A2A**<br>*(Agent2Agent Protocol)* | Google 发起 $\rightarrow$<br>Linux Foundation<br>*(已合并 IBM ACP)* | **Cloud Agent $\leftrightarrow$ Cloud Agent**<br>(跨企业/跨框架的黑盒 Agent 协作) | `Agent Card` (JSON 能力声明)、`Task` 生命周期、Artifact 交换、HTTP + SSE 传输 | A2A 针对的是「云端微服务式的企业 Agent」（如客服 Agent 调供应链 Agent）。它假设 Agent 是无共享状态的 HTTP 服务，**完全缺乏对本地文件系统、Git 分支/Diff、SSH 隧道、PTY/Tmux 交互终端的表达能力**。 | **借鉴其概念模型**：吸收 A2A 的 `Agent Card`（演进为 Reins 的 `Harness Card`）和它的异步 Task 状态流设计。 |
| **ACP**<br>*(Agent Client Protocol)* | Zed Industries &<br>JetBrains | **IDE / Editor $\leftrightarrow$ Coding Harness**<br>(代码编辑器驱动底层 Agent) | 基于 stdio / JSON-RPC 2.0 的会话建立、流式消息、文件读写请求与工具执行授权回传 | ACP 是「编辑器（人）管单个 Agent」的协议，不支持 Agent 主动发现并派单给另一个远程 Agent，也不管理跨机 SSH 路由。 | **作为 Reins 的南向驱动之一（Southbound Driver）**：对于原生支持 ACP 的 Harness（如 `dsh --profile acp`、带 ACP 适配器的 Claude/Codex），Reins 可直接作为 ACP Client 驱动它们。 |
| **AHP**<br>*(Agent Host Protocol)* | Microsoft<br>(VS Code Team) | **Agent Host Daemon $\leftrightarrow$ Multi-UI**<br>(后台守护进程向多客户端同步状态) | 基于 Channel (`ahp-root://`)、不可变 Action 与 Reducer 的多端实时状态树同步 | 它是微软为 VS Code 解耦 UI 与后台会话设计的显示同步协议，偏重 UI 状态复制而非跨品牌 Harness 编排。 | **作为 Reins 手机端同步层的架构参考**：`reins-hub` 守护进程采用类似的「单 Host 多 Client（MCP 调用端 + 手机 App 端）实时状态流订阅」模式。 |

---

### 2. 什么是 H2H (Harness-to-Harness)？它比 A2A 多了什么？

如果把通用智能体之间的通信叫 **A2A (Agent-to-Agent)**，那么专门针对 **AI Coding Harnesses（具备文件系统读写、Shell 执行、Git 操作、交互式权限确认能力的工程化智能体宿主）** 之间的互调协议，就是 **H2H (Harness-to-Harness)**。

一个真正的 **H2H 协议（即 Reins 核心协议）** 必须解决以下 5 个 A2A 忽略的工程现实：

1. **执行长耗时与「挂起等待交互（Attention Required）」**
   - Coding Harness 跑一次重构或排查往往需要 2～15 分钟，且中途随时可能弹出权限确认（如 Claude Code 的 `1. Yes / 2. Yes, accept edits / 3. No`）或追问澄清。
   - H2H 必须将 `attention_required`（等待审批/输入）作为一等公民状态，允许路由给**父 Harness 自动决策**或**转发到人类手机端审批**。
2. **异构驱动模式兼容（Headless Stream vs. Interactive Tmux）**
   - 有些环境支持无头流式调用（如 `codex exec --json`、`dsh --profile acp`）；
   - 但在许多真实环境（例如使用订阅账号或受限于特定策略的远端 Claude Code）中，**不能使用 `-p/--print` 无头模式，必须驱动交互式 TUI 会话**（通过 `tmux` 注入按键 + 监听 `~/.claude/projects/.../*.jsonl` 转录文件）。H2H 必须在底层抹平这两种模式的差异。
3. **跨机工作区上下文契约（Workspace & Git Context Contract）**
   - 当本机（Windows）的 Antigravity 调用远程服务器（Linux VPS）上的 Claude Code 时，代码在哪？
   - H2H 必须明确定义工作区模式：`remote-native`（直接操作远端目录）、`git-patch`（自动打包本地 diff 发送给远端，完成后带回 git patch）、`context-only`（仅传递文本上下文进行方案咨询/评审）。
4. **调用链防环与跳数限制（Call-Chain & Loop Prevention）**
   - 当 Antigravity 和 DSH 都挂载了 Reins MCP Server 时，如果 Antigravity 调 DSH，DSH 又调回 Antigravity，就会引发无限递归风暴。
   - H2H 协议层必须强制携带 `trace_id`、`caller_harness` 和 `hop_count`（跳数上限）。
5. **会话亲和性与多轮续接（Session Affinity & Resume）**
   - 父 Harness 派发任务后，常常需要根据返回结果追问第二轮（「测试没过，请根据报错继续修」）。H2H 必须维护逻辑 `task_id` 到底层 Harness 原生 `session_id` / `tmux_pane` 的持久化映射。

---

## 二、 现有相关开源项目调研与差距分析

我们将目前已有的开源项目分为三类，分析它们做到了什么、缺了什么：

### 1. MCP Subagent 包装器类
- **`G0d2i11a/subcodex-mcp` (Subcodex)**：
  - *做法*：让 Claude Code 通过 MCP 把编码实现委托给本机的 OpenAI Codex CLI，带有契约式 Prompt 模板和超时卡死检测。
  - *局限*：只支持 `Claude -> Local Codex` 单向本机调用，无法扩展到多 Harness 或远程主机。
- **`tuannvm/codex-mcp-server` / `steipete/claude-code-mcp`**：
  - *做法*：把单个 CLI 的 `-p` 或 `exec` 命令包装成一个简单的同步 MCP Tool。
  - *局限*：无后台守护进程、无异步状态机、不支持交互式会话续接，长任务极易触发 MCP 超时。

### 2. 多 Agent 本地编排面板类
- **`BloopAI/vibe-kanban` (Vibe Kanban)**：
  - *做法*：基于 Web 看板和 `git worktree` 并行运行 Claude Code、Codex、Gemini CLI。
  - *局限*：面向人类手动拖拽卡片，不提供让一个 Agent 动态调用另一个 Agent 的 H2H MCP 接口。
- **`asheshgoplani/agent-deck` (Agent Deck)**：
  - *做法*：基于 Go/TUI 和后台 Daemon 管理多个终端 Agent 会话，支持监控状态并通过 Telegram/Discord 发通知。
  - *局限*：强绑定本地终端 TUI，缺乏跨平台/Windows 原生体验与标准化 MCP 互调能力。

### 3. 移动端远程控制与通知推送类
- **`slopus/happy` (Happy / Happy Coder)**：
  - *做法*：通过包装器 CLI (`happy`) 启动 Claude Code 或 Codex，经由端到端加密 Relay 连接 iOS/Android 手机 App，支持手机看 Diff、收推送、点审批。
  - *局限*：只解决了「单机 CLI 投屏到手机」，不支持多 Harness 间互调，也不支持无侵入地接管远端已有的 SSH/Tmux 会话。
- **`coa00/claude-push` & `ntfy.sh` 生态**：
  - *做法*：利用 Claude Code Hooks 在遇到权限弹窗时向开源推送服务 `ntfy.sh` 发送带 Action 按钮的 HTTP 请求，手机收到通知后直接点击 Allow/Deny。
  - *借鉴价值*：**极佳的 Phase 2 轻量级移动端通知方案**！在独立 App 开发完成前，Reins 可直接内置 `ntfy` / `Bark` 驱动，零成本获得手机端秒级推送与交互审批体验。

---

## 三、 本工作区已有核心资产复用（`../dsh-claude-vps`）

在同级目录 `C:\Users\ariab\Desktop\workspace\dsh-claude-vps` 中，我们已经完成了极其宝贵的底层技术验证，可直接提炼为 **Reins 的首个远程驱动器（`ClaudeTmuxSshDriver`）**：

1. **已验证的远端非 `-p` 交互式驱动协议（见 `../dsh-claude-vps/research/PROTOCOL.md`）**：
   - 通过 `ssh -o BatchMode=yes` 连接远端节点（如 `faex1`、`claude-vps`）。
   - 使用 `tmux new-session -d -s <name> -c <workdir>` 启动真实交互式 `claude --session-id <uuid>`。
   - 解决了多行/中文 Prompt 注入难题：通过 Base64 写入远端临时文件 $\rightarrow$ `tmux load-buffer` $\rightarrow$ `tmux paste-buffer -p`（开启 Bracketed Paste 防止按行误提交）$\rightarrow$ 延迟 `0.5s` 后发送 `Enter`。
   - 精准的状态与输出提取：通过长连接 `tail -n +1 -F ~/.claude/projects/<slug>/<uuid>.jsonl` 实时解析结构化对话记录，结合 `tmux capture-pane` 识别 `system/turn_duration`（回合结束）以及权限确认弹窗（`1. Yes / 2. Yes, accept edits / 3. No`）。
2. **从 `dsh-claude-vps` 到 `Reins` 的升维**：
   - `dsh-claude-vps` 只是 DSH 内部的一个专用插件；
   - **Reins** 将这一套远程操控能力下沉为通用的 **Southbound Driver**，同时新增 `CodexDriver`、`DshDriver`、`AgyDriver`，并向上通过标准 **MCP Server** 和 **WebSocket/REST API** 暴露给所有 Harness 与未来的 **Reins 手机 App**。
