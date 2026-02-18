# 登录认证 + 离线模式 + 启动器

## 背景

Remote Dev 应用需要防止未授权访问，同时在 Antigravity IDE 未运行时提供友好的用户体验，并允许用户直接从网页启动 IDE。

## 功能

### 1. 密码登录
- 密码通过 `PASSWORD` 环境变量配置（默认 `shitchat`）
- HMAC 签名 cookie 认证，有效期 7 天
- 未认证请求：页面 → 302 跳转到 `/login.html`，API → 401
- WebSocket 连接也需验证 cookie

### 2. 离线模式
- 无 cascade 连接时显示 "Antigravity is not running" 提示
- 红色脉冲状态点 + 启动按钮
- 自动发现连接后自动切换到正常界面

### 3. 启动 Antigravity
- `POST /api/launch` 以 detached 进程启动 `Antigravity.exe --remote-debugging-port=9000`
- 路径通过 `ANTIGRAVITY_PATH` 环境变量配置
- 按钮有加载中/成功/失败状态反馈

## 修改文件

| 文件 | 改动 |
|------|------|
| `server.js` | imports, auth helpers, middleware, `/api/login`, `/api/launch`, WS auth |
| `public/login.html` | 新建：暗色主题登录页面 |
| `public/index.html` | 离线状态 UI, 启动按钮, `launchAntigravity()` |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PASSWORD` | `shitchat` | 登录密码 |
| `AUTH_SECRET` | 随机生成 | HMAC 签名密钥 |
| `ANTIGRAVITY_PATH` | 自动检测 | Antigravity.exe 路径 |
| `PORT` | `3563` | 服务端口 |
