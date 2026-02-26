# AGENTS.md — Antigravity Remote Dev

## 项目概述

**ag-mobile-monitor v2.5.1** — 一个移动端优先的 PWA 应用，让你通过手机远程监控和交互 **Antigravity IDE**（基于 VS Code/Electron 的 AI 编程 IDE）中的 AI 聊天会话。

**核心场景**：当 IDE 中的 AI 正在执行长时间编码任务时，用户可以离开工位，通过手机查看进度、发送消息、获取完成通知。

---

## 架构总览

```
┌─────────────┐     CDP/WebSocket      ┌─────────────┐     HTTP/WS      ┌──────────┐
│ Antigravity  │◄──────────────────────►│  server.js   │◄───────────────►│  Mobile   │
│     IDE      │  Port 9000-9003        │  Port 3563   │                 │  Browser  │
│  (Electron)  │                        │              │                 │  (PWA)    │
└─────────────┘                         └─────────────┘                  └──────────┘
```

**单文件单体架构**：无构建步骤、无框架、无转译。后端为单个 `server.js`（~1786 行），前端为单个 `index.html`（~2534 行，内联 CSS + JS）。

---

## 目录结构

```
antigravity-remote-dev/
├── server.js              # Express + WebSocket + CDP 逻辑（后端全部逻辑）
├── package.json           # 3 个依赖：express, ws, web-push
├── config.json            # 运行时配置（密码、端口、VAPID 密钥）—— gitignore
├── config.example.json    # 配置文件模板
├── .push-subscriptions.json  # 推送订阅持久化
├── public/
│   ├── index.html         # 主应用 UI（内联 CSS + JS）
│   ├── login.html         # 密码登录页面
│   ├── sw.js              # Service Worker（PWA + 推送通知）
│   ├── manifest.json      # PWA 清单
│   └── icons/             # PWA 图标（192x192, 512x512）
├── PRD/                   # 30 个产品需求文档（历史功能规格）
├── genesis/               # 原始 v1 代码存档
└── test-*.js              # 临时测试脚本（非测试框架）
```

---

## 技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| 运行时 | Node.js ≥16, ES Modules | 后端服务器 |
| HTTP | Express 4.x | REST API + 静态文件 |
| 实时通信 | ws 8.x (WebSocket) | 服务端 WS 广播 + CDP 客户端 |
| 推送通知 | web-push 3.x | VAPID 推送通知 |
| 协议 | Chrome DevTools Protocol (CDP) | 与 Electron 应用通信 |
| 前端 | 原生 HTML/CSS/JS | 无框架，无构建步骤 |
| PWA | Service Worker + Manifest | 可安装，离线缓存，推送通知 |
| 认证 | HMAC-SHA256 cookie token | 密码登录 |

---

## 核心数据流

### 三条通信通道

1. **读取（快照捕获）**：Server → IDE (CDP `Runtime.evaluate`) → 每 3 秒捕获聊天界面的 HTML 快照 + CSS 变量
2. **写入（消息注入）**：Mobile → Server → IDE (CDP) → 注入文本到聊天输入框并点击发送
3. **点击透传**：Mobile → Server → IDE (CDP) → 构建 CSS 选择器映射，将点击转发到 IDE 的实际 DOM 元素

---

## 后端组件详解 (`server.js`)

### 1. 配置与认证 (L1-123)

- 加载 `config.json`（密码、端口、路径、VAPID 密钥）
- 首次运行自动生成并持久化 `AUTH_SECRET` 和 `VAPID keys`
- HMAC-SHA256 token 生成 + 验证（cookie 认证）
- 配置优先级：`config.json` > 环境变量 > 默认值

### 2. CDP 连接层 (L183-269)

- `connectCDP(url)` — 建立 WebSocket 到 Electron 调试端口，追踪执行上下��
- `extractMetadata(cdp)` — 在所有执行上下文（主窗口 + iframe）中搜索聊天界面容器（`#cascade`、`#chat`、`#conversation`）
- 上下文缓存（`rootContextId`）优化重复查找

### 3. 快照捕获引擎 (L272-569)

- **`captureCSS(cdp)`** — 提取 IDE 所有样式表，选择器命名空间化（`body`/`html`/`:root` → `#chat-viewport`）防止样式泄露
- **`captureComputedVars(cdp)`** — 捕获 40+ CSS 变量（VS Code 主题变量 + IDE 自定义变量），确保主题还原
- **`captureHTML(cdp)`** — 克隆聊天 DOM，为可点击元素标注 `data-cdp-click` 索引，构建选择器映射，检测文件链接，移除输入区域
- **AI 完成检测** — 基于反馈按钮指纹（`data-tooltip-id^="up-"`）去重通知

### 4. 发现循环 (L571-651)

- 每 10 秒轮询 CDP 端口（默认 9000-9003）
- 筛选 `workbench.html` 目标（Antigravity 窗口）
- 维护持久 CDP 连接，复用已有连接，清理过期连接
- 每个连接窗口 = 一个 "cascade"（源自 IDE 聊天组件术语）

### 5. 快照更新循环 (L654-729)

- 每 3 秒并行 HTML 捕获
- 基于哈希的变更检测 — 仅在内容变化时广播
- 短快照保护（当新快照 < 200 字符而旧快照 > 500 字符时拒绝更新）
- 配额轮询：从 `#wusimpl.antigravity-quota-watcher` 状态栏提取使用量
- CSS 定期刷新：每 ~30 秒重新捕获 CSS 以响应主题变更

### 6. REST API 端点

| 端点 | 方法 | 功能 | 认证 |
|------|------|------|------|
| `/api/login` | POST | 密码认证 → httpOnly cookie | 否 |
| `/login.html` | GET | 登录页面 | 否 |
| `/api/launch` | POST | 启动 Antigravity（带 CDP） | 是 |
| `/api/kill-all` | POST | 关闭所有 Antigravity 进程 | 是 |
| `/api/close-cascade/:id` | POST | 关闭特定 IDE 窗口（CDP window.close） | 是 |
| `/api/workspace-root` | GET | 从窗口标题检测工作区目录 | 是 |
| `/api/browse` | GET | 目录浏览（带安全限制） | 是 |
| `/api/open-project` | POST | 在新 Antigravity 窗口中打开文件夹 | 是 |
| `/api/manager/accounts` | GET | 代理到 Antigravity-Manager（账号列表） | 是 |
| `/api/manager/current` | GET | 当前活跃账号 | 是 |
| `/api/manager/switch` | POST | 切换账号 | 是 |
| `/cascades` | GET | 列出所有已连接的 IDE 会话 | 是 |
| `/snapshot/:id` | GET | 获取 cascade 的 HTML 快照 | 是 |
| `/snapshot` | GET | 获取首个活跃 cascade 的快照 | 是 |
| `/styles/:id` | GET | 获取 CSS + 计算变量 | 是 |
| `/api/quota/:id` | GET | 获取 cascade 配额信息 | 是 |
| `/api/active-file/:id` | GET | 读取编辑器活跃标签内容 | 是 |
| `/api/active-tab-name/:id` | GET | 获取活跃标签名（轻量） | 是 |
| `/api/close-tab/:id` | POST | 关闭活跃编辑器标签（Cmd+W） | 是 |
| `/send/:id` | POST | 注入消息到 IDE 聊天 | 是 |
| `/click/:id` | POST | 转发点击到 IDE 元素 | 是 |
| `/scroll/:id` | POST | 同步滚动位置到 IDE | 是 |
| `/new-conversation/:id` | POST | 创建新聊天会话 | 是 |
| `/api/push/vapid-key` | GET | VAPID 公钥 | 是 |
| `/api/push/subscribe` | POST | 注册推送订阅 | 是 |
| `/api/push/unsubscribe` | POST | 取消推送订阅 | 是 |

### 7. 消息注入 (L1684-1744)

- 多策略：先尝试 `contenteditable`，再尝试 `textarea`
- 发送按钮检测：`data-tooltip-id*="send"` → 按钮选择器 → Enter 键回退
- React 受控 textarea 使用 native setter hack

### 8. 推送通知 (L1746-1784)

- VAPID Web Push（`web-push` 库）
- 自动清理过期/无效订阅（410/404 响应）
- 赛博朋克主题通知消息

---

## 前端组件详解 (`public/index.html`)

### UI 结构（2534 行，完全内联）

1. **头部栏** — Cascade 标签页（每个 IDE 窗口一个）+ 操作按钮（新建对话、通知、项目浏览器、全部关闭、账号管理）
2. **配额栏** — 可折叠的 AI 模型使用配额显示
3. **聊天视口** — 渲染的 HTML 快照，包裹在 `#chat-viewport` 中并应用作用域 CSS
4. **输入区域** — 赛博朋克风格 textarea + 发送按钮
5. **模态框**：账号管理器、文件预览（Markdown/代码高亮）、项目浏览器

### 关键前端功能

- **WebSocket 实时更新** — cascade 列表、快照变更、配额更新、CSS 更新、AI 完成事件
- **点击透传** — `[data-cdp-click]` 元素通过 CDP 转发点击到 IDE
- **滚动同步** — 防抖滚动位置同步（Web UI ↔ IDE）
- **文件预览** — 检测聊天中的文件链接，打开预览模态框（Markdown 用 `marked.js`，代码用 `highlight.js`）
- **CSS 作用域** — IDE 样式表以 `#chat-viewport` 命名空间注入，防止全局泄露
- **赛博朋克 Toast 通知** — Glitch 动画、扫描线叠加、进度指示器
- **PWA 支持** — 可安装，iOS 主屏幕运行，安全区域 insets

### 外部依赖（CDN）

- `marked.js` — Markdown 渲染
- `highlight.js` — 代码语法高亮（github-dark 主题）

---

## 其他文件

### `public/login.html` (178 行)
简洁的密码登录页面，POST 到 `/api/login`，成功后跳转到 `/`。

### `public/sw.js` (69 行)
Service Worker：
- 静态资源预缓存（network-first 策略）
- Web Push 通知接收和显示
- 通知点击 → 打开/聚焦应用

### `public/manifest.json`
PWA 清单：standalone 模式、竖屏方向、深色主题。

### `config.example.json`
配置文件模板，包含默认值。

### `PRD/` (30 个文档)
产品需求文档，记录了迭代功能开发历程：
- 核心功能：登录 → 快照捕获 → 消息注入
- 交互功能：点击透传 → 滚动同步 → 文件预览
- 品质优化：CSS 隔离 → 视觉优化 → 显示一致性
- 运维功能：启动按钮 → 全部关闭 → 账号切换 → 项目浏览器
- 通知功能：PWA 推送 → AI 完成检测 → 智能点击检测
- Bug 修复：点击崩溃 → 文件预览 404 → CDP 打开文件夹 → 无聊天找到

---

## 关键设计决策

1. **单文件架构** — 无构建步骤、无框架。整个后端一个文件，整个 UI 一个 HTML 文件。便于理解和修改。
2. **CDP 而非 API** — 无需 Electron 应用暴露 API，服务器充当"远程调试器"进行抓取和注入。
3. **HTML 快照而非截图** — 更小的载荷，保留文本可选性，支持点击透传，允许 CSS 主题化。
4. **CSS 变量捕获** — 确保移动端视图匹配 IDE 实际主题（深色/浅色模式、自定义主题）。
5. **反馈指纹去重** — 通过追踪反馈按钮唯一 tooltip ID 防止重复 AI 完成通知。
6. **多策略回退** — 文件预览尝试 ariaLabel → hover tooltip → fallback；项目打开尝试 CLI → CDP → `open -n`；发送尝试 tooltip-div → button → Enter 键。

---

## 平台支持

- **服务端**：macOS（主要，使用 `osascript`/`pgrep`/`open -a`）+ Windows（辅助，使用 `tasklist`/`taskkill`）
- **客户端**：任何移动浏览器，针对 iOS PWA 优化（安全区域 insets、`apple-mobile-web-app-capable`）

---

## 配置说明

| 字段 | 描述 | 默认值 |
|------|------|--------|
| `password` | 登录密码 | `shitchat` |
| `port` | Web 服务器端口 | `3563` |
| `antigravityPath` | Antigravity 可执行文件路径（空 = 自动检测） | 自动 |
| `cdpPorts` | 扫描的 CDP 端口 | `[9000, 9001, 9002, 9003]` |
| `managerUrl` | Antigravity-Manager URL | `http://127.0.0.1:8045` |
| `managerPassword` | Antigravity-Manager 密码 | 空 |
| `vapidKeys` | VAPID 密钥对（自动生成） | 自动 |
| `authSecret` | 认证签名密钥（自动生成并持久化） | 自动 |
| `vapidSubject` | VAPID 主题（Apple 要求 mailto: 或 https:） | `mailto:noreply@example.com` |

---

## 开发注意事项

### 代码风格
- ES Modules（`"type": "module"`）
- 无 TypeScript，纯 JavaScript
- 无 linter/formatter 配置
- 内联样式和脚本（无构建步骤）
- 中英文混合注释

### 核心常量
- `DISCOVERY_INTERVAL = 10000` — 发现新 IDE 窗口间隔（10 秒）
- `POLL_INTERVAL = 3000` — 快照更新间隔（3 秒）
- CSS 刷新间隔：每 10 次轮询（~30 秒）

### 已知限制
- `send/:id` 路由中有未完成的注入逻辑注释（L1511-1520），实际调用了 `injectMessage()` 辅助函数
- `getQuotaColor()` 在前端定义了两次（L1439 和 L2301），阈值不同
- 无测试框架，只有临时测试脚本
- 无错误监控/日志持久化

### 安全考虑
- HMAC-SHA256 cookie 认证（7 天过期）
- 目录浏览限制系统目录（`/System`、`/private`、`C:\Windows` 等）
- 文件预览限制 1MB 大小
- WebSocket 连接需要认证 cookie
- `config.json` 应在 `.gitignore` 中（包含密码和密钥）

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **antigravity-remote-dev** (187 symbols, 366 relationships, 14 execution flows).

GitNexus provides a knowledge graph over this codebase — call chains, blast radius, execution flows, and semantic search.

## Always Start Here

For any task involving code understanding, debugging, impact analysis, or refactoring, you must:

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/refactoring/SKILL.md` |

## Tools Reference

| Tool | What it gives you |
|------|-------------------|
| `query` | Process-grouped code intelligence — execution flows related to a concept |
| `context` | 360-degree symbol view — categorized refs, processes it participates in |
| `impact` | Symbol blast radius — what breaks at depth 1/2/3 with confidence |
| `detect_changes` | Git-diff impact — what do your current changes affect |
| `rename` | Multi-file coordinated rename with confidence-tagged edits |
| `cypher` | Raw graph queries (read `gitnexus://repo/{name}/schema` first) |
| `list_repos` | Discover indexed repos |

## Resources Reference

Lightweight reads (~100-500 tokens) for navigation:

| Resource | Content |
|----------|---------|
| `gitnexus://repo/{name}/context` | Stats, staleness check |
| `gitnexus://repo/{name}/clusters` | All functional areas with cohesion scores |
| `gitnexus://repo/{name}/cluster/{clusterName}` | Area members |
| `gitnexus://repo/{name}/processes` | All execution flows |
| `gitnexus://repo/{name}/process/{processName}` | Step-by-step trace |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher |

## Graph Schema

**Nodes:** File, Function, Class, Interface, Method, Community, Process
**Edges (via CodeRelation.type):** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
RETURN caller.name, caller.filePath
```

<!-- gitnexus:end -->
