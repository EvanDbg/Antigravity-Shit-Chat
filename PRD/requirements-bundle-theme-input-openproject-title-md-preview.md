# 需求汇总：主题切换 / 输入换行 / IDE 打开目录 / 标签标题 / Markdown 文件点击预览

## 背景

当前移动端监控应用已经具备基础可用性，但在主题一致性、输入体验、项目打开链路、标签标题准确性、以及 Markdown 文件点击预览上仍有明显缺口。

本需求文档用于将以下 5 个问题统一收敛为一个可执行清单，便于后续按优先级开发与验收。

## 本次汇总范围

1. 主题风格没有完全切换成功
2. 对话输入框不支持直接换行
3. 缺少“直接使用 IDE 打开某个文件夹”的可达功能
4. 标签栏 title 显示不正确（全部显示 Explore，而非真实标题）
5. 点击 Markdown 文件（`.md`）后：
   - (a) 当前点不开
   - (b) 需要支持后台查看
   - (c) 需要支持前台查看

---

## 需求 1：主题风格未完全切换成功

### 问题定义

主题切换存在“部分生效”的现象：全局/局部样式、Tailwind 类、以及覆盖层之间可能出现不一致，导致最终观感与 IDE 不完全同步。

### 现状线索（代码）

- 服务端从 IDE 提取样式：`server.js` 的 `captureCSS()` / `captureComputedVars()`
- 客户端应用样式：`public/js/chat.js` 的 `applyCascadeStyles()` + `setSnapshotTheme()`
- 主题切换触发：`public/js/settings.js` 通过 `theme-toggle` 事件驱动

### 目标

无论是 Follow IDE / Light / Dark，聊天区域主题都应稳定、完整、可重复切换，不出现“只变部分样式”或“切换后被覆盖回退”。

### 验收标准

1. 连续切换 20 次（follow→light→dark 循环）无卡死、无丢样式。
2. 代码块、链接、按钮、列表、消息区背景等关键元素主题一致。
3. 切换 cascade、触发 snapshot/css 更新后，主题模式仍保持用户选择。

---

## 需求 2：对话输入框支持直接换行

### 问题定义

当前输入框对 `Enter` 做了发送拦截，导致无法直接换行输入多段消息。

### 现状线索（代码）

- `public/js/app.js` 中 `messageInput` 的 `keydown`：`Enter && !shiftKey` 会 `preventDefault()` 并调用 `sendMessage()`。

### 目标行为

- `Enter`：换行（textarea 默认行为）
- 点击发送按钮：发送
-（可选增强）`Cmd/Ctrl + Enter`：发送

### 验收标准

1. 输入两行文本后发送，请求体保留 `\n`。
2. 不点击发送按钮时，按 Enter 不会触发发送。
3. 输入框自适应高度与现有逻辑不冲突。

---

## 需求 3：提供“直接通过 IDE 打开文件夹”的前端可达能力

### 问题定义

后端已存在打开项目能力，但前端入口/流程不可达或不完整，导致用户无法从当前 UI 直接完成“选目录 → 在 IDE 新窗口打开”。

### 现状线索（代码）

- 后端已实现：`POST /api/open-project`（`server.js`）
- 当前前端模块（`public/js/app.js`, `public/js/drawer.js`）未检索到对应触发与目录浏览调用链。

### 目标

在移动端 UI 中提供可发现、可操作、可反馈的完整链路：
`打开项目` → `浏览目录` → `确认` → `IDE 新窗口打开`。

### 验收标准

1. 用户可在前端明确找到“打开项目”入口。
2. 可浏览目录并选择目标文件夹。
3. 执行后端 `open-project` 成功时，UI 有成功反馈；失败时有可读错误提示。

---

## 需求 4：标签栏标题应显示真实 title（非固定 Explore）

### 问题定义

当前会话标题来源策略不准确，导致标签标题经常退化为同一值（如 Explore），无法区分不同会话。

### 现状线索（代码）

- 标题来源：`server.js` 的 `extractMetadata()`（通过 `h1/h2/header/[class*=title]` 选择器猜测）
- 前端展示：`/cascades` 返回 `metadata.chatTitle`，由 `public/js/app.js` 与 `public/js/drawer.js` 渲染。

### 目标

标题策略应优先取“可唯一识别会话”的真实来源，并建立可靠回退链，避免全部同名。

### 验收标准

1. 同时打开多个不同会话时，标签标题可区分。
2. 切换模型/模式等 UI 文案变化不应误伤会话标题。
3. 无法提取真实标题时，回退值可读且稳定（不使用误导性固定文案）。

---

## 需求 5：点击 Markdown 文件（`.md`）支持后台查看 + 前台查看

### 问题定义

当前点击 `.md` 文件链接时，存在“点不开”或“只在某一侧生效”的问题；目标是兼顾 IDE 背景打开与 Web 前台预览。

### 目标拆分

1. **可点击**：聊天快照中 `.md` 文件链接可稳定识别并触发。
2. **后台查看（IDE）**：点击后继续走 CDP click passthrough，在 IDE 打开对应文件。
3. **前台查看（Web）**：同时弹出前台预览（Markdown 渲染）。

### 现状线索（代码）

- 点击分发：`public/js/chat.js` 的 `handleCDPClick()`
- 前后台联动判断：`/api/active-tab-name/:id` 前后对比
- 文件预览容器：`public/index.html` 的 `filePreviewModal`
- 文件读取/提取能力：`server.js` 的 active file 相关接口与处理逻辑

### 建议实现约束（用于后续开发）

1. 使用事件委托（稳定父容器 + `closest('a')`/`data-*`）处理动态快照。
2. 对 `.md` 链接做语义标注（如 `data-type="md-preview"`），避免误触普通按钮。
3. 保持“前台失败不影响后台”：前台预览失败时，IDE 打开仍需成功。

### 验收标准

1. 点击 `.md` 链接后，IDE 侧对应文件成功打开。
2. Web 侧可弹出 Markdown 预览，标题与内容正确。
3. 在网络波动/接口失败场景下，至少保证一侧（优先 IDE 后台）可用，并给出非阻塞提示。

---

## 优先级建议

- **P0**：需求 2（输入换行）、需求 4（标题准确）
- **P1**：需求 5（MD 双通道预览）
- **P1**：需求 3（打开项目前端可达）
- **P2**：需求 1（主题完整一致性优化，可能涉及较大样式治理）

## 已检索到的关键证据（代码定位）

> 说明：以下定位用于后续实现时快速落点。

1. **主题切换与样式同步**
   - `server.js`：`captureCSS()`（约 L275+）、`captureComputedVars()`（约 L327+）
   - `server.js`：`/styles/:id`（约 L1513+）
   - `server.js`：CSS 刷新周期（`cssRefreshCounter >= 10`，约 30 秒，约 L728+）
   - `public/js/chat.js`：`applyCascadeStyles()`（约 L98+）、`setSnapshotTheme()`（约 L915+）
   - `public/js/settings.js`：`theme-toggle` 触发（约 L11+）

2. **输入换行与发送行为**
   - `public/js/app.js`：`messageInput` 的 `keydown`（`Enter && !shiftKey` 即发送，约 L324+）
   - `public/js/app.js`：`sendMessage()`（约 L143+）
   - `server.js`：`POST /send/:id`（约 L1526+）
   - `server.js`：`injectMessage()`（约 L2176+）

3. **打开项目能力（后端已有、前端链路需补）**
   - `server.js`：`GET /api/workspace-root`（约 L952+）
   - `server.js`：`GET /api/browse`（约 L985+）
   - `server.js`：`POST /api/open-project`（约 L1025+）
   - `public/index.html`：存在 `projectModal / projectList / projectOpenBtn` 结构，但在当前 `public/js/*.js` 中未检索到对应调用链。

4. **标签标题来源**
   - `server.js`：`extractMetadata()` 通过标题选择器推断 `chatTitle`（约 L229+）
   - `server.js`：`GET /cascades` 返回 `title: c.metadata.chatTitle`（约 L1193+）
   - `public/js/app.js` 与 `public/js/drawer.js`：消费并展示 `c.title`

5. **Markdown 文件点击预览**
   - `public/js/chat.js`：`handleCDPClick()` 中触发 `open-file-preview` 事件（约 L826/L831）
   - `public/index.html`：`filePreviewModal` 结构已存在
   - 当前在 `public/js/*.js` 未检索到 `open-file-preview` 的事件消费端实现，需补齐“事件 -> 拉取内容 -> 前台渲染”闭环。

## 关联历史 PRD（便于追溯）

- `PRD/enter-key-newline.md`
- `PRD/fix-open-folder-cdp.md`
- `PRD/file-preview.md`
- `PRD/smart-click-notification.md`
- `PRD/web-display-parity.md`
- `PRD/iframe-css-isolation.md`

## 备注

本文档为“需求汇总单”，不限制具体技术实现。后续可按每个需求拆分为独立实现 PRD 与任务单。
