# 智能点击检测 + Good/Bad 通知触发

## 智能点击检测

### 问题
所有 `data-cdp-click` 点击都触发文件预览，但展开/折叠按钮、操作按钮不应触发。

### 方案
前后 Tab 对比法：
1. 点击前 → `GET /api/active-tab-name/:id` 记录当前 tab
2. 执行 click
3. 等 500ms
4. 再次查询 tab → 如果 tab 变了 = 文件打开 → 显示预览

### 改动
- `server.js` — 新增 `GET /api/active-tab-name/:id`
- `index.html` — click handler 改为前后对比

---

## Good/Bad 通知触发

### 问题
旧方案使用 "连续 3 次 stable poll"（~9秒延迟）检测 AI 完成。

### 方案
检测快照 HTML 末尾 500 字符是否同时包含 "Good" 和 "Bad"：
- 检测到 → 立即 `sendPushNotification()`
- 2 分钟冷却防止重复

### 改动
- `server.js` — polling loop 通知逻辑改为 Good/Bad 关键词检测
