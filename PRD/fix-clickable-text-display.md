# 修复普通文字被错误标记为可点击的问题

## 问题

Web 端出现大量普通文字带有 `data-cdp-click` 属性，导致：

1. **显示效果异常** — 普通文字显示为可点击样式（带边框、hover 效果），破坏阅读体验
2. **误点击** — 阅读时不小心触碰到这些文字会触发 CDP click 操作，可能导致 IDE 端意外行为

## 根因分析

在 `server.js` 的 `captureHTML()` 函数中，`clickSelector` 过于宽泛：

```javascript
const clickSelector = 'button, a, [role="button"], [class*="cursor-pointer"]';
```

这导致：
- 所有 `<a>` 标签（包括 markdown 渲染的外部链接、无意义锚点）都被标记
- 所有带 `cursor-pointer` 类的元素（Tailwind 大量使用）都被标记
- AI 回复中的纯文本段落如果包含了上述元素，整块区域看起来都是"可点击"的

## 关联 PRD

> [!NOTE]
> 之前已有 [selective-clickable-elements.md](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/PRD/selective-clickable-elements.md) 对此问题做了方案设计（白名单策略 + `shouldBeClickable()` 过滤），但尚未完全解决问题。本 PRD 作为该方案的补充和跟进。

## 期望行为

| 元素类型 | 是否应标记为可点击 |
|---------|-------------------|
| 文件链接（`.js`, `.py` 等） | ✅ 是 |
| Accept / Reject / Apply 按钮 | ✅ 是 |
| 折叠/展开控件（`aria-expanded`） | ✅ 是 |
| 外部超链接（`https://...`） | ❌ 否（或直接 `window.open`） |
| 纯装饰性 `cursor-pointer` 元素 | ❌ 否 |
| AI 回复中的普通文字段落 | ❌ 否 |
| 代码块操作按钮（复制等） | ❌ 否 |

## 实现要点

1. **强化 `shouldBeClickable()` 过滤函数** — 确保只有明确有交互价值的元素被标记
2. **CSS 层面** — 检查 `[data-cdp-click]` 的样式是否过于突出，考虑降低视觉侵入性
3. **调试** — 在浏览器中检查当前哪些元素被错误标记，逐一排查规则

## 文件变更

### [MODIFY] [server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/server.js)

- 在 `captureHTML()` 的 CDP 脚本中，进一步收紧 `shouldBeClickable()` 过滤逻辑
- 减少被标记为 `data-cdp-click` 的元素数量

### [MODIFY] [index.html](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/public/index.html)

- 可选：调整 `[data-cdp-click]` 的 CSS 样式，降低视觉突出度

## 验证

- 打开 Web UI，查看对话内容
- 确认普通文字没有可点击样式
- 确认按钮和文件链接仍然可以正常点击
- 确认点击普通文字不会触发任何 CDP 操作
