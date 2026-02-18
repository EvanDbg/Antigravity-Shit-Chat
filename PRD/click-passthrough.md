# 点击透传功能 (Click Passthrough)

## 背景

Antigravity Remote Dev 应用通过 CDP 抓取 IDE cascade panel 的 HTML 快照并在网页端渲染显示。但是原来快照中的按钮和链接在网页端不可点击，用户无法与 IDE 中的交互元素进行操作。

## 需求

1. **点击透传**：用户在网页端点击按钮/链接时，将点击事件转发到 IDE 的 cascade panel
2. **新建对话**：在网页端提供 "新建对话" 按钮
3. **视觉反馈**：点击时有明确的视觉指示（hover 高亮、点击状态）

## 技术方案

### 元素标注

在 `captureHTML()` 捕获快照时：
- 遍历所有可点击元素 (`button`, `a`, `[role="button"]`, `[class*="cursor-pointer"]`)
- 通过 `buildSelector()` 为每个元素生成唯一 CSS 选择器路径
- 在克隆的 HTML 中添加 `data-cdp-click` 索引属性
- 随快照返回 `clickMap`（索引 → CSS 选择器的映射）

### API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/click/:id` | POST | 透传点击，body: `{ index }` |
| `/new-conversation/:id` | POST | 新建对话 |

### 前端实现

- `#chatContent` 上 事件委托拦截 `[data-cdp-click]` 点击
- hover: 蓝色边框高亮
- clicking: 0.5 opacity + pointer-events:none
- header 栏 `＋` 按钮调用新建对话 API

## 修改文件

| 文件 | 改动 |
|------|------|
| `server.js` | `buildSelector()`, `captureHTML()` 标注, `/click/:id`, `/new-conversation/:id` |
| `public/index.html` | CSS 样式, `＋` 按钮, 点击事件委托 |

## 验证

- `POST /click/-batyfy {"index":0}` → `{"success":true,"text":"Implementation Plan"}`
- 服务端日志: `🖱️ Click forwarded: "Implementation Plan"`
