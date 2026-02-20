# 精细化可点击元素：只让真正具备"点击属性"的元素可点击

## 问题分析

### 当前行为

在 [captureHTML()](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/server.js#L441-L569) 函数中，使用了一个**宽泛的 CSS 选择器**来标记可点击元素：

```javascript
const clickSelector = 'button, a, [role="button"], [class*="cursor-pointer"]';
```

这意味着 **ALL** 匹配以下条件的元素都会被标记为 `data-cdp-click`：

| 选择器 | 匹配范围 | 问题 |
|--------|----------|------|
| `button` | 所有 `<button>` 元素 | ✅ 大部分合理，但包括纯装饰性按钮 |
| `a` | 所有 `<a>` 锚点元素 | ⚠️ 包括无 href 的锚点、markdown 渲染出的外部链接等 |
| `[role="button"]` | ARIA 角色为 button 的元素 | ✅ 通常合理 |
| `[class*="cursor-pointer"]` | 类名包含 `cursor-pointer` 的元素 | ⚠️ Tailwind 大量使用，范围过广 |

### 实际影响

在 Antigravity 的对话框中，以下元素都被错误地标记为可点击：

1. **外部超链接** — markdown 中渲染的 URL，如 `[link](https://example.com)`，在 IDE 中点击是打开浏览器，但在 web 端变成了发送 CDP click
2. **纯装饰性 span/div** — 一些带有 `cursor-pointer` 类但实际不需要远程点击的 UI 元素
3. **已展开的折叠区域标题** — 被误识别为可点击
4. **AI 回复中的代码块操作按钮（复制等）** — 这些在 web 端点击意义不大

### 真正需要可点击的元素

对话框中真正有用的可点击元素：

| 类别 | 描述 | 识别方式 |
|------|------|----------|
| **文件链接** | 点击打开文件 (如 `server.js`, `index.html`) | 文本匹配文件扩展名模式 |
| **Accept/Reject 按钮** | 接受或拒绝代码编辑 | 按钮文本包含 "Accept"/"Reject"/"Apply" |
| **展开/折叠** | 任务节、代码差异等的展开折叠 | 通常有 `aria-expanded` 属性 |
| **重试/停止按钮** | 控制 AI 响应 | 按钮文本包含 "Retry"/"Stop" |

## 方案设计

### 核心思路

> **不再对所有匹配选择器的元素"一刀切"标记，而是增加一个过滤层，只标记真正有交互价值的元素。**

### 具体策略：白名单 + 属性检测

在 `captureHTML()` 的 CDP 脚本中，增加一个 `shouldBeClickable(el)` 判断函数：

```javascript
function shouldBeClickable(el) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim();
    const role = el.getAttribute('role');
    const ariaExpanded = el.hasAttribute('aria-expanded');
    const ariaLabel = el.getAttribute('aria-label') || '';
    const classList = el.className || '';
    
    // 1. 有 aria-expanded 属性的元素（折叠/展开控件）→ 可点击
    if (ariaExpanded) return true;
    
    // 2. 有 onclick / 事件监听器绑定的按钮 → 可点击
    //    (难以直接检测事件监听器，所以通过按钮文本判断)
    
    // 3. 文件链接：文本匹配文件扩展名模式 → 可点击
    const fileExtPattern = /\b[\w.-]+\.(?:md|txt|js|ts|jsx|tsx|py|rs|go|java|c|cpp|h|css|html|json|yaml|yml|toml|xml|sh|bash|sql|rb|php|swift|kt|scala|r|lua|pl|ex|exs|hs|ml|vue|svelte)\b/i;
    if (fileExtPattern.test(text) && text.length < 100) return true;
    
    // 4. 操作按钮：Accept / Reject / Apply / Retry / Stop 等
    const actionPatterns = /^(accept|reject|apply|retry|stop|cancel|run|save|undo|redo|dismiss|close|confirm|approve|deny)/i;
    if (tag === 'button' && actionPatterns.test(text)) return true;
    
    // 5. role="button" + 有意义的 aria-label → 可点击
    if (role === 'button' && ariaLabel) return true;
    
    // 6. <a> 标签只有 href 指向 file:// 或者 data-href 指向 file:// → 可点击
    if (tag === 'a') {
        const href = el.getAttribute('href') || '';
        const dataHref = el.getAttribute('data-href') || '';
        if (href.startsWith('file://') || dataHref.startsWith('file://')) return true;
        // 排除外部链接和无意义的锚点
        return false;
    }
    
    // 7. 排除纯 cursor-pointer 装饰元素（没有实际交互价值）
    if (tag !== 'button' && !role) return false;
    
    // 8. 默认：button 和 role="button" 保留
    return tag === 'button' || role === 'button';
}
```

## User Review Required

> [!IMPORTANT]
> 这个方案采用**白名单策略**，只有明确识别为有交互价值的元素才会被标记为可点击。这意味着可能会漏掉一些边缘场景。如果你发现某些应该可点击的元素没有被标记，我们需要补充白名单规则。

> [!WARNING]
> 修改后，markdown 中的**外部链接**（如 `https://github.com/...`）将**不再**在 web 端可点击跳转。如果你需要外部链接可点击，我可以单独处理——让外部链接在新窗口中直接打开 URL，而不是发送 CDP click。

## Proposed Changes

### Server-Side: CDP Capture Logic

#### [MODIFY] [server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/server.js)

修改 `captureHTML()` 函数中的 CDP 脚本（L474-L507），增加 `shouldBeClickable()` 过滤函数：

1. 在 `clickSelector` 匹配后，增加 `shouldBeClickable(el)` 过滤
2. 只对通过过滤的元素设置 `data-cdp-click`
3. `clickMap` 只包含真正可点击的元素

---

### Client-Side: External Link Handling (可选增强)

#### [MODIFY] [index.html](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/public/index.html)

可选：对于外部链接（`<a href="https://...">`)，不发送 CDP click，而是直接在新窗口打开：
- 在 click handler 中检测 `href` 属性
- 如果是 `http://` 或 `https://` 开头，使用 `window.open()` 直接打开

## Verification Plan

### Manual Verification

1. 启动 server 和 Antigravity，打开 web UI
2. 在 Antigravity 中发起一个包含以下内容的对话：
   - 文件链接引用（如某个 `.js` 文件）
   - 外部 URL 链接
   - Accept/Reject 按钮（编辑代码时出现）
   - 折叠/展开区域
3. 在 web UI 中检查：
   - ✅ 文件链接可点击，并正确跳转到文件
   - ✅ Accept/Reject 按钮可点击
   - ✅ 折叠/展开控件可点击
   - ✅ 外部 URL 链接**不**显示为 CDP 可点击样式
   - ✅ 纯装饰性元素不显示可点击样式
