# 一键关闭 Antigravity & 账号切换功能需求

## 功能一：一键关闭所有 Antigravity 程序

### 需求描述
在 Shit-Chat 网页 header 栏增加关闭按钮，点击后关闭所有运行中的 Antigravity IDE 进程。

### 实现要点
- `POST /api/kill-all` 接口：macOS 使用 `pkill`，Windows 使用 `taskkill`
- 同时关闭所有 CDP WebSocket 连接，清理状态
- UI 上在通知按钮旁添加 ⏻ 按钮，带确认对话框

### 涉及文件
- `server.js` — 添加 `/api/kill-all` 路由
- `public/index.html` — 添加关闭按钮和交互逻辑

---

## 功能二：Antigravity-Manager 账号切换调研结论

### 结论
Antigravity-Manager **没有外部 REST API** 用于账号切换。所有管理通过其内置 Web UI 完成。

### 现有能力
- ✅ 429/401 自动轮换（API 代理层内置）
- ✅ Manager Web UI 手动切换
- ❌ 无外部可编程 API

### 建议方案
利用 Antigravity-Manager 已有的自动轮换机制，确保多账号已添加即可。如需手动操作，可在 Shit-Chat 中加入 Manager Web UI 跳转链接。
