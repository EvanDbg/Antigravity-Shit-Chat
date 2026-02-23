# 输入框自适应高度 — 根据内容自动调节

## 问题

当前 Web 端输入框 `<textarea>` 高度固定为 `42px`，`max-height: 120px`。当用户输入多行文字时：
- 内容被截断，需要手动滚动查看
- 无法一目了然地看到完整输入内容
- 体验不如主流聊天应用的自适应输入框

## 当前行为

| 属性 | 值 |
|------|-----|
| `height` | `42px`（固定） |
| `max-height` | `120px` |
| `resize` | `none` |

输入框不会随内容增长而变高，超出部分只能通过内部滚动查看。

## 期望行为

| 场景 | 行为 |
|------|------|
| 单行输入 | 保持默认最小高度（约 42px） |
| 多行输入 | 高度随内容自动增长 |
| 内容超过半屏 | 限制最大高度为 `50vh`（半个屏幕高度），超出部分内部滚动 |
| 删除内容 | 高度自动缩回 |

## 实现方案

### CSS 修改

```css
textarea {
    /* 移除固定 height，改用 min-height */
    min-height: 42px;
    max-height: 50vh;  /* 最大不超过半屏 */
    overflow-y: auto;  /* 超出 max-height 时显示滚动条 */
}
```

### JavaScript 修改

监听 `input` 事件，动态调整 `textarea` 高度：

```javascript
const textarea = document.getElementById('messageInput');
textarea.addEventListener('input', () => {
    textarea.style.height = 'auto'; // 先重置高度
    textarea.style.height = textarea.scrollHeight + 'px'; // 设为内容高度
});
```

## 文件变更

### [MODIFY] [index.html](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/public/index.html)

1. **CSS**（L139-L153）：将 `height: 42px` 改为 `min-height: 42px`，`max-height: 120px` 改为 `max-height: 50vh`
2. **JavaScript**：在 `<script>` 块末尾添加 `input` 事件监听器，动态调整高度

## 验证

- 输入单行文字 → 高度保持最小值
- 输入多行文字 → 高度自动增长
- 输入大量文字 → 高度不超过屏幕一半，出现内部滚动
- 删除文字 → 高度自动缩减
