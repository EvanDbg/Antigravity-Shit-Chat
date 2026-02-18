# 滚动透传 — 加载历史会话内容

## 背景

网页端快照只显示 IDE 聊天窗口的可视区域。IDE 使用懒加载机制，需要上滑才会加载更早的消息。
此功能将网页端的滚动操作透传到 IDE 的聊天容器，触发懒加载并刷新快照。

## 实现方案

### 服务端
- `POST /scroll/:id` — 接受 `{ deltaY }` 参数
- 在 IDE iframe context 中找到可滚动容器，设置 `scrollTop += deltaY`
- 等待 300ms 后触发快照刷新（给懒加载时间）

### 前端
- 监听 `chatContainer` 的 `scroll` 事件
- 当 `scrollTop < 30`（到达顶部）时，发送 `deltaY: -800` 到服务端
- 1.5 秒防抖限制，防止请求风暴
- 显示 "⏳ 加载历史内容..." 加载提示
- 500ms 后自动刷新快照内容

## 文件变更

- `server.js` — 新增 `/scroll/:id` 端点
- `public/index.html` — 滚动事件处理 + 加载指示器 CSS/HTML
