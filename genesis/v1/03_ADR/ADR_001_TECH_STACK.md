# ADR-001: 技术栈选择

**日期**: 2026-02 (v2.1)
**状态**: 已采纳

---

## 上下文

Antigravity Remote Dev 需要实现对 Antigravity IDE (Electron 应用) 的远程监控和交互，目标是在手机浏览器上实时查看聊天内容并进行操作。

## 决策

| 维度 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 运行时 | Node.js | Python, Go | 原生 WebSocket 支持，CDP 生态成熟 |
| Web 框架 | Express | Fastify, Koa | 足够简单，社区大，快速开发 |
| 实时通信 | ws (npm) | Socket.IO | 轻量，无需额外协议层 |
| IDE 通信 | CDP (原生) | Puppeteer | 直接 WebSocket 更轻量，无需 Chromium |
| 认证 | JWT + Cookie | Session | 无状态，PWA 友好 |
| 推送 | Web Push API | FCM, APNs | PWA 原生支持，跨平台 |
| 前端 | 原生 HTML/CSS/JS | React, Vue | 单文件部署，零构建，极简 |
| 部署 | 单文件 (server.js) | 微服务 | 工具类应用，简单优先 |

## 后果

- ✅ 极简架构，单文件即可运行
- ✅ CDP 零侵入，不需修改 Antigravity IDE
- ✅ PWA 支持，手机体验接近原生
- ⚠️ 单文件 server.js 已超 1000 行，需考虑拆分
- ⚠️ 原生前端代码也膨胀到 45KB，维护成本增加
