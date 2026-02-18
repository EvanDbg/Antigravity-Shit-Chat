# 优化 Good/Bad 反馈按钮检测逻辑

## 问题

当前检测逻辑（`server.js:587`）使用纯文本正则匹配 HTML 末尾 500 字符：

```javascript
const lastChunk = (c.snapshot.html || '').slice(-500);
const hasGoodBad = /\bGood\b/.test(lastChunk) && /\bBad\b/.test(lastChunk);
```

**误报**：AI 对话内容中包含 "Good"/"Bad" 文字时也会触发通知。

## DOM 结构分析

通过 CDP 检查 Antigravity 窗口，反馈按钮的真实结构：

```html
<!-- Good 按钮 -->
<div data-tooltip-id="up-:r15:" class="... cursor-pointer ...">
  <span class="opacity-70">Good</span>
  <svg><!-- thumbs-up --></svg>
</div>

<!-- Bad 按钮 -->
<div data-tooltip-id="down-:r15:" class="... cursor-pointer ...">
  <span class="opacity-70">Bad</span>
  <svg><!-- thumbs-down --></svg>
</div>
```

**关键特征**：`data-tooltip-id` 以 `up-` / `down-` 开头。

## 方案

在 `captureHTML` 的 CDP 脚本中直接用 DOM 选择器检测反馈按钮，返回 `hasFeedbackButtons` 标志。

### 改动

1. **`captureHTML` 函数**：增加 feedback 检测，返回 `hasFeedbackButtons: true/false`
2. **`updateSnapshots` 检测逻辑**：替换文本正则为 `c.snapshot.hasFeedbackButtons`
