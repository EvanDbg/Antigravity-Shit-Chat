# Antigravity Shit-Chat — 架构概览

> **版本**: v1 | **日期**: 2026-02-18

---

## 1. 系统全景

```
┌─────────────────────────────────────────────┐
│           用户 (手机浏览器 / PWA)              │
└──────────────────┬──────────────────────────┘
                   │ HTTP / WebSocket
                   ▼
┌──────────────────────────────────────────────┐
│          System A: Node.js 服务端              │
│   ┌────────────┐  ┌───────────────────────┐  │
│   │  Express   │  │   WebSocket Server    │  │
│   │  (HTTP)    │  │  (实时快照推送)        │  │
│   └─────┬──────┘  └──────────┬────────────┘  │
│         │                    │               │
│   ┌─────▼────────────────────▼────────────┐  │
│   │         CDP 连接管理                    │  │
│   │  (发现 → 连接 → 快照 → 注入 → 点击)    │  │
│   └─────────────────┬─────────────────────┘  │
│                     │                        │
│   ┌─────────────────▼─────────────────────┐  │
│   │       Web Push (推送通知)               │  │
│   └───────────────────────────────────────┘  │
└──────────────────┬───────────────────────────┘
                   │ CDP (Chrome DevTools Protocol)
                   ▼
┌──────────────────────────────────────────────┐
│       Antigravity IDE (Electron)              │
│   ┌────────────────────────────────────────┐ │
│   │  Chat Panel (聊天面板)                  │ │
│   │  Quota Watcher (配额监控)               │ │
│   │  多端口实例 (9000-9003)                 │ │
│   └────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
         ↕ (可选)
┌──────────────────────────────────────────────┐
│       Antigravity-Manager (Docker)            │
│       http://127.0.0.1:8045                   │
└──────────────────────────────────────────────┘
```

---

## 2. 系统定义

### System A: Node.js 服务端

| 属性 | 值 |
|------|-----|
| **ID** | SYS-A |
| **职责** | HTTP/WS 服务、CDP 通信、快照捕获、消息注入、推送通知 |
| **源码** | `server.js` (~1036 行, 单文件架构) |
| **技术栈** | Node.js, Express, ws, Chrome DevTools Protocol |
| **架构模式** | 单文件服务端 + 事件驱动 |

**核心模块 (server.js 内)**:

| 模块 | 行范围 | 职责 |
|------|--------|------|
| Auth Helpers | L87-110 | JWT makeToken / verifyToken / parseCookies |
| CDP Logic | L172-342 | connectCDP / extractMetadata / captureCSS / captureHTML / extractQuotaInfo |
| Main App | L427-574 | discover (多端口扫描) / updateSnapshots (轮询快照) |
| HTTP Server | L596-949 | Express 路由、WebSocket、Manager 代理 |
| Inject/Push | L951-1036 | injectMessage / sendPushNotification |

### System B: 前端 (public/)

| 属性 | 值 |
|------|-----|
| **ID** | SYS-B |
| **职责** | 移动端监控界面、PWA 壳、推送接收 |
| **源码目录** | `public/` |
| **技术栈** | HTML, CSS, JavaScript (原生), PWA |

**核心文件**:

| 文件 | 职责 |
|------|------|
| `index.html` | 主监控面板 (~45KB，含内联 CSS/JS) |
| `login.html` | 登录页 |
| `manifest.json` | PWA 清单 |
| `sw.js` | Service Worker (推送、缓存) |
| `icons/` | PWA 图标资源 |

---

## 3. 数据流

### 3.1 快照捕获流程

```
[定时器 3s] → discover() → 扫描 CDP 端口
                            ↓
                  connectCDP(wsUrl) → WebSocket 连接
                            ↓
                  captureHTML(cdp) → Runtime.evaluate
                            ↓ DOM 快照
                  captureCSS(cdp) → CSS.getMatchedStylesForNode
                            ↓ 样式数据
                  hashString(html) → 内容变化检测
                            ↓ (仅变化时)
                  broadcast({type:'snapshot_update'}) → WS 推送客户端
```

### 3.2 消息注入流程

```
手机输入消息 → WS {type:'inject'} → server.js
                                      ↓
                            injectMessage(cdp, text)
                                      ↓
                            CDP: DOM.querySelector('#chat-input')
                            CDP: Runtime.evaluate(设置值)
                            CDP: DOM.focus + Input.dispatchKeyEvent(Enter)
```

### 3.3 点击透传流程

```
手机点击元素 → WS {type:'click', selector} → server.js
                                              ↓
                            CDP: Runtime.evaluate(
                              document.querySelector(selector).click()
                            )
```

---

## 4. 通信协议

### WebSocket 事件 (Server → Client)

| 事件 | 描述 |
|------|------|
| `snapshot_update` | 聊天快照内容更新 |
| `cascade_list` | 可用实例列表 |
| `status` | Antigravity 运行状态 |
| `quota_update` | 配额信息更新 |

### WebSocket 事件 (Client → Server)

| 事件 | 描述 |
|------|------|
| `inject` | 注入消息到 IDE |
| `click` | 点击透传 |
| `switch_cascade` | 切换监控实例 |
| `new_conversation` | 创建新会话 |
| `kill_all` | 关闭所有会话 |

### HTTP API

| 路径 | 方法 | 描述 |
|------|------|------|
| `/` | GET | 主监控页面 |
| `/login` | GET/POST | 登录页/认证 |
| `/api/quota/:id` | GET | 获取 Quota 信息 |
| `/api/push/subscribe` | POST | 订阅推送通知 |
| `/api/push/unsubscribe` | POST | 取消推送订阅 |
| `/api/manager/*` | ALL | Manager 代理 |

---

## 5. 技术决策摘要

| 决策 | 选择 | 理由 |
|------|------|------|
| 运行时 | Node.js | 原生 WebSocket 支持，CDP 库成熟 |
| Web 框架 | Express | 轻量、足够 |
| 实时通信 | ws (WebSocket) | 双向通信，延迟低 |
| IDE 通信 | Chrome DevTools Protocol | Electron 原生支持，无需修改 IDE |
| 认证 | JWT + Cookie | 简单有效 |
| 推送 | Web Push API | PWA 原生，无需额外服务 |
| 前端 | 原生 HTML/CSS/JS | 单文件，无构建步骤 |

> 详细 ADR 见 `03_ADR/` 目录
