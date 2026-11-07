# Reins

> **Take the reins of all your local and remote AI coding harnesses.**  
> 跨本机与远程环境的 AI Coding Harness 互调网关（H2H MCP Server）与移动端统一指挥中心。

---

## 1. 为什么叫 Reins？

在 AI 编程领域，Claude Code、Codex、DeepSeek Harness (`dsh`)、Antigravity (`agy`) 等工具都被称为 **Harness（马具/挽具）**。  
然而，当多匹穿戴着不同 Harness 的骏马一起拉车时，如果缺乏车夫手中的**总缰绳（Reins）**，它们只能各自为战、互不相通。

**Reins** 就是这套总控系统：
- **Pass / Hand over the reins（移交缰绳）**：让任意 Harness（如本机的 Antigravity）通过标准 MCP 协议，把子任务动态指派给另一个本机或远程的 Harness（如本机的 `dsh`/`codex`，或远程服务器上的 `claudecode`）。
- **Take the reins（接管缰绳）**：通过手机端 App 随时随地查看各个 Harness 的实时工作进度、对话流与代码改动，必要时直接介入下达指令。
- **Free rein vs. Tight rein（放开缰绳 / 收紧缰绳）**：灵活配置全自动沙盒执行（`free-rein`），或将高危工具调用/权限弹窗实时拦截并推送到手机端审批（`tight-rein`）。
- **Pull the reins（勒住缰绳）**：当某个后台或远程 Harness 跑偏、陷入死循环时，在主 Agent 或手机 App 上一键中断（Abort/Escape）。

---

## 2. 核心目标与演进路线

### Phase 1: H2H (Harness-to-Harness) MCP 互调核心
- 向上暴露标准 **MCP Server**（支持同步调用与异步任务轮询/通知），任何支持 MCP 的宿主（Antigravity、Claude Code、DSH、Codex、Cursor 等）挂载后即可获得跨 Harness 派单能力。
- 向下抽象统一的 **`HarnessDriver`** 与 **`Transport`（Local / SSH）**：
  - 支持本机进程直接拉起（通过 ACP 协议、JSON Stream 或 Headless CLI）。
  - 支持通过 **SSH + Tmux / 远程通道** 调用本机未安装的远程 Harness（如在 Windows 本机通过 Antigravity 指派远端 Linux VPS 上的 Claude Code 干活）。

### Phase 2: 守护进程化（`reins-hub`）与即时推送通知
- 将状态收敛至本地/云端常驻守护进程 **`reins-hub`**，持久化管理跨 Harness 的调用树（Call Tree）、会话状态与日志流。
- 内置通知网关（`reins-notify`），支持在任务完成、报错或遇到权限弹窗（`attention_required`）时，通过 **ntfy.sh / Bark / 飞书 / Webhook** 向手机发送交互式通知（可直接点击 Allow / Deny）。

### Phase 3: Reins Mobile App（移动端指挥台）
- 基于 `reins-hub` 暴露的实时状态流（借鉴 AHP 多端状态同步模型 + 端到端加密 Relay / Tailscale 直连），构建跨平台手机端 App：
  - 全局看板：统一管理本机与多台远程服务器上的所有 Harness 会话。
  - 交互审批：远程处理权限弹窗、追加 Prompt、查看 Git Diff。
  - 主动发起：在手机上直接唤醒任意机器上的指定 Harness 启动新任务。

---

## 3. 目录结构

```text
reins/
├── README.md                         # 项目总览与愿景定义
├── package.json                      # Node.js (ESM) 项目清单
├── config/
│   └── reins.example.yaml            # 本机与远程 Harness 节点配置示例
├── research/
│   └── PROTOCOLS_AND_ECOSYSTEM.md    # 现有协议 (MCP/A2A/ACP/AHP) 与开源生态深度调研及 H2H 定位
├── docs/
│   ├── ARCHITECTURE.md               # Reins 整体系统架构设计 (Hub + MCP + Drivers + Mobile)
│   └── H2H_PROTOCOL.md               # Reins H2H (Harness-to-Harness) 互调协议规范 v0.1
└── src/
    ├── index.js                      # 入口引导文件
    ├── hub/                          # 核心状态机、任务路由与防环控制 (待实现)
    ├── mcp/                          # 面向宿主 Harness 的 MCP Server 暴露层 (待实现)
    ├── drivers/                      # 各大 Harness 驱动适配器 (Claude/Codex/DSH/AGY) (待实现)
    ├── transports/                   # Local 子进程与 Remote SSH/Tmux 传输层 (待实现)
    └── notify/                       # 手机端推送与 Webhook 通知桥接 (待实现)
```

---

## 4. 快速导航（供新会话 Agent 阅读）

在新会话中推进本项目时，请按以下顺序阅读核心文档：
1. **[`research/PROTOCOLS_AND_ECOSYSTEM.md`](./research/PROTOCOLS_AND_ECOSYSTEM.md)**：了解当前业界协议（MCP Tasks、A2A、ACP、AHP）的边界、开源竞品优缺点，以及为什么我们需要定义轻量级的 **H2H (Harness-to-Harness)** 规范。
2. **[`docs/H2H_PROTOCOL.md`](./docs/H2H_PROTOCOL.md)**：查看 Reins 定义的 H2H 核心原语、任务状态机、跨机 Workspace 同步契约与防死循环（Loop Guard）机制。
3. **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)**：查看系统模块划分、已有技术资产复用方案（如复用 `../dsh-claude-vps` 中已验证的 SSH + Tmux + JSONL 交互式驱动协议）及 MVP 实施计划。
4. **[`config/reins.example.yaml`](./config/reins.example.yaml)**：查看目标节点（Target）与策略（Rein Policy）的配置格式。
