# PWA 自动登录 + 快照内容稳定性

## 背景

两个高优先级问题：
1. PWA 每次打开都需要重新输入密码登录
2. 网页端显示的会话内容偶尔缺失（只显示框框无内容）

## 需求

### 1. PWA 自动登录

- 登录后 cookie 在 server 重启后仍然有效
- 无需额外的"记住密码"按钮 — 直接在服务端持久化 auth secret
- 安全性：auth secret 保存在 config.json 中，不在源码里

### 2. 快照内容稳定性

- 空/短快照不应覆盖已有的完整快照
- 当 IDE 上下文切换（面板切换、iframe 重载）时，自动重试获取
- 异常情况下打印 warning 日志，便于排查

## 实现方案

### AUTH_SECRET 持久化
- `AUTH_SECRET` 首次启动时用 `randomBytes(32)` 生成
- 自动写入 `config.json` 的 `authSecret` 字段
- 后续重启从 config.json 读取同一个 secret

### 快照保护
- `updateSnapshots()` 中新增最小长度检查：新快照 < 200 chars 且旧快照 > 500 chars 时跳过
- `captureHTML()` 新增重试：首次失败后刷新 `rootContextId` 再试一次
- 跳过时打印 warning 日志

## 影响范围

- `server.js` — AUTH_SECRET 生成逻辑 + captureHTML + updateSnapshots
- `config.json` — 新增 `authSecret` 字段（自动生成）
