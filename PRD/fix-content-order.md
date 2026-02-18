# 修复内容缓存消息顺序

## 问题

缓存中消息顺序反了：index 0 = 最新消息 → index 79 = 最旧消息。正确的应该是 index 0 = 最旧（顶部），last index = 最新（底部）。

## 根因

IDE 的虚拟滚动在 DOM 中把**最新消息放在最前面**（DOM 顺序 ≠ 时间顺序）。`parseSnapshotChunks` 按 DOM 顺序提取，因此缓存中消息顺序是反的。

## 方案

在 `buildCacheHtml` 渲染时**反转** `cache.sequence`：

```diff
 // Build a simple structure: viewport > message container with accumulated messages
-const messagesHtml = cache.sequence.map(c => c.html).join('');
+const reversed = [...cache.sequence].reverse();
+const messagesHtml = reversed.map(c => c.html).join('');
```

只在渲染时反转，不修改存储。merge 逻辑保持不变，overlap 锚定仍然正确。

## 影响范围

仅修改 `buildCacheHtml` 一行代码。

## 验证

- Chrome DevTools 截图确认：顶部 = 旧消息，底部 = 新消息
- 滚动仍然正常累积
