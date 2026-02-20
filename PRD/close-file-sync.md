# 网页端关闭文件预览时同步关闭 Editor Tab

## 需求背景

当用户在网页端点击对话中的文件链接时，文件会同时在 Antigravity IDE 编辑器和网页端预览弹窗中打开。  
目前关闭网页端预览弹窗时，IDE 中的文件 tab 仍然保留，需要用户手动关闭。

## 期望行为

关闭网页端文件预览弹窗时，自动关闭 IDE 中对应的文件 tab。

## 技术方案

1. **新增 API** `POST /api/close-tab/:id` — 通过 CDP `Input.dispatchKeyEvent` 向 IDE 发送 `Ctrl+W`（macOS 为 `Cmd+W`）
2. **修改前端** `closeFilePreview()` — 关闭弹窗时调用此 API

## 触发场景

- 点击预览弹窗的 ✕ Close 按钮
- 按 Escape 键
- 点击弹窗外的遮罩层

## 涉及文件

| 文件 | 修改内容 |
|------|----------|
| `server.js` | 新增 `/api/close-tab/:id` 路由 |
| `public/index.html` | 修改 `closeFilePreview()` 添加 API 调用 |

## 验收标准

- [ ] 网页端关闭文件预览后，IDE 中对应 tab 被关闭
- [ ] 三种关闭方式（按钮/Escape/遮罩层点击）均触发同步关闭
- [ ] 网络错误不阻塞前端关闭动作
