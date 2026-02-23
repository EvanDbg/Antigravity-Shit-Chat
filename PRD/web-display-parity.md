# Web 端显示效果一比一复刻 Antigravity 对话历史

## 问题

当前 Web 端的对话历史显示效果与 Antigravity IDE 中的显示效果存在较大差异，包括但不限于：

1. **字体和排版** — Web 端字体、行高、间距与 IDE 不一致
2. **颜色和主题** — 虽然已有 CSS 变量注入，但部分元素（按钮、链接、代码块等）仍然渲染不一致
3. **布局结构** — 消息气泡、头像、工具调用区块等布局差异
4. **Tailwind 类未生效** — IDE 使用 Tailwind CSS，但 Web 端缺少对应的 Tailwind 工具类定义
5. **交互组件** — 折叠区域、代码差异块、任务面板等复杂组件的样式丢失

## 当前方案的局限

已有 `applyCascadeStyles()` 函数从 IDE 提取 CSS 变量并注入到 Web 端，但：
- 只提取了 CSS 变量，没有提取 Tailwind 的实际类定义
- 很多 IDE 特有的样式类（如 `prose`、`bg-ide-*`、`text-ide-*`）在 Web 端没有对应实现
- 代码块、任务面板等复杂组件的结构和样式差异明显

## 关联 PRD

> [!NOTE]
> 已有 [web-display-visual-optimization.md](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/PRD/web-display-visual-optimization.md) 解决了按钮和边框的部分问题。本 PRD 目标是**全面复刻**，达到一比一的视觉还原度。

## 期望目标

用户在 Web 端看到的对话历史，应该与在 Antigravity IDE 中看到的**完全一致**：
- 同样的字体、字号、行高
- 同样的颜色、背景、边框
- 同样的消息布局和间距
- 同样的代码块渲染效果
- 同样的折叠/展开组件外观
- 同样的按钮、链接样式

## 实现方向

### 方案 A：完整提取 IDE 计算样式

在 `captureHTML()` 时，除了提取元素结构和 CSS 变量外，还提取每个关键元素的 `getComputedStyle()`，将样式以内联方式写入 HTML。

**优点**：最精确的还原  
**缺点**：HTML 体积大幅增加，性能影响

### 方案 B：提取 Tailwind 编译后的 CSS

从 IDE 页面中提取完整的 `<style>` 标签内容（Tailwind 编译后的 CSS），注入到 Web 端。

**优点**：一次性解决所有样式类的问题  
**缺点**：CSS 规则可能与 Web 端自有样式冲突，需要命名空间隔离

### 方案 C：截图渲染（降级方案）

直接截取 IDE 对话区域的截图，在 Web 端以图片方式显示。

**优点**：100% 一致  
**缺点**：不可交互，占用带宽大

> [!IMPORTANT]
> 推荐 **方案 B** 作为主要方向，配合必要的样式隔离。需要调研 Antigravity 扩展加载的具体 CSS 文件结构。

## 文件变更

### [MODIFY] [server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/server.js)

- 在 `captureHTML()` 或 CSS 提取逻辑中，提取 IDE 的完整 Tailwind CSS
- 将 CSS 以作用域限定的方式传递给前端

### [MODIFY] [index.html](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/public/index.html)

- 注入提取的 CSS 到 `#chat-viewport` 作用域内
- 确保不与 Web 端自有样式冲突
- 移除现有的手动样式覆盖（因为不再需要）

## 验证

- 截图对比：同一对话在 IDE 和 Web 端的截图逐像素对比
- 覆盖常见场景：纯文本消息、代码块、文件链接、按钮、折叠区域、任务面板
- 不同主题/配色方案下的一致性
