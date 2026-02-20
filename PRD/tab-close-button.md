# 为 Tab 增加关闭按钮，关闭对应的 Antigravity 窗口

用户希望在网页端的每个 cascade tab 上增加一个 `×` 关闭按钮，点击后关闭**对应的那一个** Antigravity 窗口（非全部 kill）。

## Proposed Changes

### Server — 新增单个 Cascade 关闭 API

#### [MODIFY] [server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/server.js)

在现有 `/api/kill-all` 路由旁边新增 `POST /api/close-cascade/:id`：

1. 根据 `req.params.id` 查找 `cascades` Map 中对应的 cascade
2. 通过 CDP 向该窗口发送 `window.close()` 指令关闭 Electron 窗口
3. 同时关闭该 cascade 的 CDP websocket 连接
4. 从 `cascades` Map 中删除该 cascade
5. 调用 `broadcastCascadeList()` 通知所有前端客户端更新 tab 列表

```javascript
// Close single Antigravity window
app.post('/api/close-cascade/:id', async (req, res) => {
    const { id } = req.params;
    const cascade = cascades.get(id);
    if (!cascade) return res.status(404).json({ error: 'Cascade not found' });

    try {
        // Send window.close() via CDP to close the Electron window
        await cascade.cdp.call('Runtime.evaluate', {
            expression: 'window.close()',
            contextId: cascade.cdp.rootContextId
        });
    } catch (e) { /* window may already be closing */ }

    try { cascade.cdp.ws.close(); } catch (e) { }
    cascades.delete(id);
    broadcastCascadeList();

    res.json({ success: true, closedId: id });
});
```

---

### Frontend — Tab 关闭按钮 UI 和逻辑

#### [MODIFY] [index.html](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/public/index.html)

**1. CSS 样式（在已有的 `.cascade-tab` 样式块附近）**

为关闭按钮添加样式，hover 时变红，尺寸小巧不影响 tab 点击：

```css
.cascade-tab .close-btn {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: transparent;
    border: none;
    color: #888;
    font-size: 12px;
    line-height: 16px;
    text-align: center;
    cursor: pointer;
    margin-left: 4px;
    padding: 0;
    transition: all 0.2s;
    flex-shrink: 0;
}

.cascade-tab .close-btn:hover {
    background: #f87171;
    color: #fff;
}
```

**2. Tab 渲染（`renderTabs()` 函数）**

在每个 tab 的 `${c.title || 'Untitled'}` 后面添加一个 `×` 按钮：

```javascript
function renderTabs() {
    tabsContainer.innerHTML = cascades.map(c => `
        <div class="cascade-tab ${c.id === currentCascadeId ? 'active' : ''} ${c.active ? 'active-window' : ''}" 
             onclick="selectCascade('${c.id}')">
            <div class="status"></div>
            ${c.title || 'Untitled'}
            <button class="close-btn" onclick="event.stopPropagation(); closeCascade('${c.id}')" title="Close">×</button>
        </div>
    `).join('');
    // ... rest unchanged
}
```

> [!IMPORTANT]
> 使用 `event.stopPropagation()` 防止关闭按钮的点击冒泡到 tab 的 `onclick` 导致先切换再关闭。

**3. JavaScript 关闭函数**

```javascript
async function closeCascade(id) {
    if (!confirm('Close this Antigravity window?')) return;
    try {
        const res = await fetch(`/api/close-cascade/${id}`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) console.warn('Close failed:', data.error);
    } catch (e) {
        console.error('Close cascade error:', e);
    }
}
```

## Verification Plan

### Manual Verification

1. 启动 server 和至少一个 Antigravity 实例
2. 在网页端观察 tab 上是否显示 `×` 按钮
3. hover `×` 按钮确认变红效果
4. 点击 `×` 按钮，确认弹出确认框
5. 确认后，对应的 Antigravity 窗口应关闭，tab 消失
6. 如果还有其他窗口，应不受影响
