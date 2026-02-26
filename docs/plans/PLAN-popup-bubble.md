# 目标描述

针对移动端 Webview 里 IDE 弹窗组件显示异位、样式紊乱、同步滞后等一系列问题，我们将执行彻底的“气泡弹窗架构重构”（Popup Bubble Architecture）。这套方案从根本上跳出原有的 Shadow DOM 以及粗暴样式覆盖的困境，重新构造前端坐标锚连与后端快照时序机制。

## 变更方案

### 前端重构 (`public/js/chat.js` & `public/css/snapshot.css`)

#### [MODIFY] `public/js/chat.js`
- **全局点击拦截与坐标嗅探**
  - 在 `document` 捕获阶段绑定全局 `click` 监听器，记录最后一次真实物理点击事件（`window.lastClickEvent`）。用于决定弹出气泡的锚定坐标。
- **DOM 提取降噪与 Shadow DOM 逃逸**
  - 在 `updateContent()` 抛给 `morphdom` 即将渲染之前，拦截传入的 `temp` DOM 树。
  - 通过 `temp.querySelectorAll('[role="dialog"]')` 定位弹窗容器。
  - 从原生元素中提取关键信息：标题、高光徽标（如 New）、普通选项及其对应的 `data-cdp-click` 索引。
  - 在交给 `morphdom` 渲染前，移除或隐藏原生弹窗，避免其在页面中捣乱。
- **自适应气泡渲染器 (Bubble Renderer)**
  - 构建脱离 Shadow DOM 且在 `document.body` 根层级挂载的超高层级（`z-index: 99999`）半透明遮罩与气泡框。
  - 解析 `lastClickEvent` 的 X/Y 坐标，赋予气泡初始的 `fixed` 绝对定位，包含自动向上下检测边界的安全空间避让机制。
  - 为重构后的气泡列表项重绑点击事件：点击发送 `fetch('/click/:id', ...)` 并随即关闭气泡自身。

#### [MODIFY] `public/css/snapshot.css`
- 补充移动端专属气泡的相关排版：半透明毛玻璃背景 `.mobile-popup-backdrop`、以及美化重绘组件 `.mobile-popup-bubble`, `.mobile-popup-title` 等精美质感样式。

---

### 后端重构 (`server.js`)

#### [MODIFY] `server.js`
- **消除状态不同步：时延广播机制**
  - 编辑 `app.post('/click/:id')` 的路由逻辑。
  - 在点击命令发送 IDE 并返回成功后，不要简单地发回空包裹；增加一段异步时序代码：开启 `150ms` 的倒计时（等待 IDE 原生弹窗执行完毕渲染）。
  - 时间到达后直接调用核心逻辑 `captureHTML` 重新抓取全局快照。
  - 通过 WebSocket (`wsMap`) 向前端下发新抓取的 HTML 数据，诱发界面的热更新，修复“必须等 3 秒后轮询才出弹窗”的滞后 BUG。

## 验证计划

1. **手动点击触发测试**：点击 `Gemini 3.1 Pro` 或是 `Planning` 控制器。
2. **位置校准与越界翻转验证**：观察菜单是否像“工具气泡”一样平滑精准地出现在手指点击的周边；如果在极靠近屏幕底部边缘点击，气泡是否能感知屏幕界限自动翻折至上方出现。
3. **连贯性与数据验证**：点击选项后确认弹窗消失，主界面内容或目标模型随 IDE 同步被瞬间更改而无错位感。
