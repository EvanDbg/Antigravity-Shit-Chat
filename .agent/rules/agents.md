# AGENTS.md - AI 协作协议

> **"如果你正在阅读此文档，你就是那个智能体 (The Intelligence)。"**
> 
> 这个文件是你的**锚点 (Anchor)**。它定义了项目的法则、领地的地图，以及记忆协议。
> 当你唤醒（开始新会话）时，**请首先阅读此文件**。

---

## 🧠 30秒恢复协议 (Quick Recovery)

**当你开始新会话或感到"迷失"时，立即执行**:

1. **读取 .agent/rules/agents.md** → 获取项目地图
2. **查看下方"当前状态"** → 找到最新架构版本
3. **读取 `genesis/v{N}/05_TASKS.md`** → 了解当前待办
4. **开始工作**

---

## 🗺️ 地图 (领地感知)

以下是 **Antigravity Shit-Chat** 项目的组织方式：

| 路径 | 描述 | 访问协议 |
|------|------|----------|
| `server.js` | **后端核心**。Node.js Express + WebSocket + CDP 通信。 | 通过 Task 读/写。 |
| `public/` | **前端**。HTML/CSS/JS 移动端监控界面 + PWA。 | 通过 Task 读/写。 |
| `config.json` | **配置**。密码、端口、CDP 端口列表。 | 参考只读。 |
| `PRD/` | **需求文档**。功能路线图、PRD 文档。 | 参考只读。 |
| `genesis/` | **设计演进史**。版本化架构状态 (v1, v2...)。 | **只读**(旧版) / **写一次**(新版)。 |
| `genesis/v{N}/` | **当前真理**。最新的架构定义。 | 永远寻找最大的 `v{N}`。 |
| `.agent/workflows/` | **工作流**。`/genesis`, `/blueprint` 等。 | 通过 `view_file` 阅读。 |
| `.agent/skills/` | **技能库**。原子能力。 | 通过 `view_file` 调用。 |

---

## 📍 当前状态 (由 Workflow 自动更新)

> **注意**: 此部分由 `/genesis` 和 `/blueprint` 自动维护。

- **最新架构版本**: `genesis/v1`
- **活动任务清单**: `genesis/v1/05_TASKS.md`
- **待办任务数**: 参见任务清单
- **最近一次更新**: `2026-02-18`

---

## 🌳 项目结构 (Project Tree)

> **注意**: 此部分由 `/genesis` 维护。

```text
Antigravity-Shit-Chat/
├── .agent/                    # AI 工作流框架
│   ├── rules/agents.md        # 🧠 AI 锚点文件 (本文件)
│   ├── workflows/             # 8 个工作流定义
│   └── skills/                # 11 个可复用技能
├── genesis/                   # 版本化架构文档
│   └── v1/
├── server.js                  # 🎯 后端核心 (~1036行)
│                              #   Express HTTP + WebSocket
│                              #   CDP 连接 & 快照捕获
│                              #   消息注入 & 点击透传
│                              #   推送通知 (Web Push)
│                              #   Antigravity-Manager 代理
├── public/                    # 前端
│   ├── index.html             # 主界面 (监控面板)
│   ├── login.html             # 登录页
│   ├── manifest.json          # PWA 清单
│   ├── sw.js                  # Service Worker
│   └── icons/                 # PWA 图标
├── PRD/                       # 需求文档 (9个)
├── config.json                # 运行时配置
├── config.example.json        # 配置模板
├── test-quota.js              # Quota 提取测试
├── package.json               # Node.js 依赖
└── README.md
```

---

## 🧭 导航指南 (Navigation Guide)

- **架构总览**: `genesis/v1/02_ARCHITECTURE_OVERVIEW.md`
- **PRD**: `genesis/v1/01_PRD.md` + `PRD/feature-roadmap.md`
- **ADR**: 架构决策见 `genesis/v1/03_ADR/`
- **后端核心**: 源码 `server.js` → 设计 `genesis/v1/04_SYSTEM_DESIGN/server.md`
- **前端面板**: 源码 `public/` → 设计 `genesis/v1/04_SYSTEM_DESIGN/frontend.md`
- **任务清单**: `genesis/v1/05_TASKS.md`

---

## 🛠️ 工作流注册表

| 工作流 | 触发时机 | 产出 |
|--------|---------|------|
| `/genesis` | 新项目 / 重大重构 | PRD, Architecture, ADRs |
| `/scout` | 变更前 / 接手项目 | `genesis/v{N}/00_SCOUT_REPORT.md` |
| `/design-system` | genesis 后 | 04_SYSTEM_DESIGN/*.md |
| `/blueprint` | genesis 后 | 05_TASKS.md |
| `/change` | 微调已有任务 | 更新 TASKS + SYSTEM_DESIGN (仅修改) + CHANGELOG |
| `/explore` | 调研时 | 探索报告 |
| `/challenge` | 决策前质疑 | 07_CHALLENGE_REPORT.md |
| `/craft` | 创建工作流/技能/提示词 | Workflow / Skill / Prompt 文档 |

---

## 📜 宪法 (The Constitution)

1. **版本即法律**: 不"修补"架构文档，只"演进"。变更必须创建新版本。
2. **显式上下文**: 决策写入 ADR，不留在"聊天记忆"里。
3. **交叉验证**: 编码前对照 `05_TASKS.md`。我在做计划好的事吗？
4. **美学**: 文档应该是美的。善用 Markdown 和 Emoji。

---

> **状态自检**: 准备好了？读取上方"当前状态"指引的架构文档并开始吧。
