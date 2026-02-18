# Antigravity Remote Dev — 任务清单 (WBS)

> **版本**: Genesis v1 | **日期**: 2026-02-18
>
> 整合自 `PRD/feature-roadmap.md` 和各 PRD 文档

---

## ✅ 已完成功能

- [x] 密码登录 (Cookie-based JWT)
- [x] CDP 连接和多端口发现 (9000-9003)
- [x] 实时快照捕获 + CSS 样式保留
- [x] WebSocket 推送 (3秒轮询)
- [x] 内容稳定性检测 (hash 比对)
- [x] 消息注入 (通过 CDP)
- [x] 点击透传 (CSS Selector)
- [x] Antigravity 离线检测 + 远程启动
- [x] 新建会话 / Kill All 会话
- [x] 账户切换
- [x] PWA 支持 (manifest + Service Worker)
- [x] Web Push 推送通知
- [x] iOS PWA 推送适配
- [x] Quota 配额信息显示
- [x] Antigravity-Manager API 代理

---

## 📋 待实现功能

### 基础设施 [P1]

- [ ] `TASK-101` Cloudflare Tunnel 适配 — 支持外网访问
- [ ] `TASK-102` macOS 适配优化 — 路径检测、启动命令适配
- [ ] `TASK-103` server.js 拆分重构 — 按模块拆分 (当前 1036 行单文件)
- [ ] `TASK-104` index.html 拆分 — CSS/JS 独立文件 (当前 45KB)

### 功能增强 [P2]

- [ ] `TASK-201` 多用户权限管理 — 不同用户不同权限
- [ ] `TASK-202` 会话历史回放 — 记录快照历史并回放
- [ ] `TASK-203` 快照截图保存 — 将当前快照保存为图片
- [ ] `TASK-204` 键盘快捷键支持 — 手机端快捷操作

### 体验优化 [P2]

- [ ] `TASK-301` 暗色模式 — 跟随系统偏好
- [ ] `TASK-302` 连接状态指示器 — 更清晰的 CDP/WS 状态
- [ ] `TASK-303` 自动重连机制 — WebSocket 断线自动重连优化

---

## 📊 统计

| 类别 | 总任务数 | 已完成 |
|------|----------|--------|
| 已发布功能 | 15 | 15 ✅ |
| 待实现 | 11 | 0 |
