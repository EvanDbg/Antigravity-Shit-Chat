# 输入框 Enter 键换行（而非发送）

## 问题

当前 Web 输入框（`<textarea>`）按 Enter 键直接触发 `sendMessage()`，无法在消息中插入换行。

## 当前行为

| 操作 | 结果 |
|---|---|
| Enter | 发送消息 |
| Shift+Enter | 换行 |

## 期望行为

| 操作 | 结果 |
|---|---|
| Enter | 换行（textarea 默认行为） |
| 点击「⚡ SEND」按钮 | 发送消息 |

## 改动范围

### `public/index.html`

移除 `keydown` 事件监听器中的 Enter → 发送逻辑（第 1512-1517 行）：

```diff
- document.getElementById('messageInput').addEventListener('keydown', (e) => {
-     if (e.key === 'Enter' && !e.shiftKey) {
-         e.preventDefault();
-         sendMessage();
-     }
- });
```

发送按钮的 `onclick` 绑定（第 1510 行）保持不变。

## 影响

- textarea 恢复默认换行行为
- 用户只能通过点击发送按钮发送消息
- `injectMessage` 后端逻辑无需改动（已支持 `\n`）
