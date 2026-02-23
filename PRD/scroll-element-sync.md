# 滚动联动优化 — 基于元素定位而非直接透传

## 问题

当前网页端滚动与 Antigravity 对话历史的联动方式是**直接透传滚动**（发送 `ratio` 到 IDE），存在以下问题：

1. **内容不对齐** — 网页端和 IDE 端的内容高度不同（CSS 渲染差异、懒加载等），按比例滚动会导致位置偏移
2. **滚动抖动** — 透传滚动后刷新快照，新快照内容高度变化又触发滚动，形成反馈循环（虽然有 `scrollSyncLock`，但体验仍不理想）
3. **语义丢失** — 用户期望"看到同一条消息"，但 ratio 只是几何位置映射，无法保证语义一致

## 当前实现

```javascript
// 当前方式：计算滚动比例，透传到 IDE
const ratio = chatContainer.scrollTop / maxScroll;
fetch(`/scroll/${currentCascadeId}`, {
    body: JSON.stringify({ ratio })
});
```

## 期望行为

| 步骤 | 行为 |
|------|------|
| 用户在网页端滚动 | 检测网页端**顶部可见的第一个消息元素** |
| 发送到后端 | 将该元素的标识（如消息 ID、`data-*` 属性）发送给后端 |
| 后端通知 IDE | Antigravity IDE 端将该元素滚动到可视区域顶部 |
| 刷新快照 | IDE 滚动完成后重新抓取快照 |

## 实现方案

### 1. 前端：检测顶部可见元素

```javascript
function getTopVisibleElement() {
    const viewport = document.getElementById('chatContent');
    const elements = viewport.querySelectorAll('[data-message-id], [data-turn-id]');
    const containerTop = chatContainer.scrollTop;
    
    for (const el of elements) {
        if (el.offsetTop >= containerTop) {
            return el.getAttribute('data-message-id') || el.getAttribute('data-turn-id');
        }
    }
    return null;
}
```

### 2. 后端：基于元素 ID 滚动 IDE

```javascript
// POST /scroll/:id → 改为发送 { elementId } 而非 { ratio }
// 后端通过 CDP 在 IDE 中找到对应元素并 scrollIntoView
await page.evaluate((elementId) => {
    const el = document.querySelector(`[data-message-id="${elementId}"]`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}, elementId);
```

### 3. 元素标识策略

需要先调研 Antigravity IDE 对话内的 DOM 结构，确定可用的唯一标识属性：
- `data-message-id`
- `data-turn-id` 
- `data-turn-number`
- 或者使用消息内容的 hash 作为标识

> [!IMPORTANT]
> 实现前需先通过 CDP 检查 Antigravity 对话框的 DOM 结构，确认哪些属性可以用作消息的唯一标识。

## 关联 PRD

> [!NOTE]
> 已有 [scroll-passthrough.md](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/PRD/scroll-passthrough.md) 描述了当前的直接透传方案。本 PRD 是其**替代方案**，改为基于元素定位的智能联动。

## 文件变更

### [MODIFY] [server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/server.js)

- 修改 `POST /scroll/:id` 端点，接受 `{ elementId }` 参数
- 通过 CDP 在 IDE 中找到对应元素并调用 `scrollIntoView()`
- 在 `captureHTML()` 中为消息元素保留唯一标识属性（如 `data-message-id`）

### [MODIFY] [index.html](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/public/index.html)

- 修改滚动事件处理器，改为检测顶部可见元素并发送元素 ID
- 移除 ratio 方式的滚动同步逻辑

## 验证

- 在网页端向上滚动 → IDE 端应滚动到相同消息位置
- 在网页端向下滚动 → IDE 端应同步滚动到对应位置
- 快速连续滚动 → 不应出现抖动或死循环
- 内容高度差异场景（长代码块等）→ 仍然能定位到正确消息
