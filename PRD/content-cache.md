# 内容缓存系统

## 问题

Antigravity IDE 的聊天面板使用虚拟滚动/懒加载，每次只渲染当前视口可见的内容。当 Remote Dev 通过 CDP 抓取快照时，只能获取当前渲染的 DOM 片段。

现有流程的痛点：
1. **全量替换**：每次 `updateContentOnly` 都用 `innerHTML` 全量替换 DOM，丢弃已有内容
2. **滚动空白**：用户滚动到新位置时，需要等 IDE 懒加载 → 重新抓取快照 → 网络传输 → 渲染，期间显示空白
3. **重复加载**：已浏览过的区域再次滚动到时，还需重新加载

## 方案：客户端分段缓存 + 增量合并

### 核心思路

将每个 cascade 的快照内容视为**可拼接的内容带**。利用 IDE 聊天的天然结构（每条消息有唯一标识），提取消息级别的 "块"（chunks），在浏览器端缓存，滚动时增量合并而非全量替换。

### 技术方案

#### 1. 消息块提取（Server 端）

在 `captureHTML` 返回的 HTML 中，IDE 的每条消息是一个独立的 DOM 节点（通常是 `div` with unique `data-turn-id` 或类似属性）。修改返回数据，额外提取消息块列表：

```js
// captureHTML 新增返回
{
  html: '...full HTML...',
  chunks: [
    { id: 'turn-1', html: '<div>...</div>' },
    { id: 'turn-2', html: '<div>...</div>' },
    ...
  ]
}
```

#### 2. 客户端缓存层（Browser 端）

```js
// 每个 cascade 维护一个有序 chunk 缓存
const contentCache = {}; // { cascadeId: Map<chunkId, htmlString> }
```

- 收到新快照时，提取 chunks，merge 进缓存（新内容覆盖同 ID 旧内容，新 ID 追加）
- 渲染时从缓存组装完整 HTML，而非直接用服务端返回的 html

#### 3. 渲染策略

- **增量 DOM 更新**：对比新旧 chunk 列表，只更新变化的 DOM 节点，避免全量 `innerHTML` 替换
- **占位符**：对于缓存中不存在的区域（从未滚动到），显示轻量占位符而非空白
- **LRU 清理**：缓存超过一定大小时（如 500 个 chunks），清除最早的条目

### 实现步骤

#### Phase 1: 前端 HTML 分段缓存（最小改动方案）

不改 server 端，纯前端实现：

1. 在 `updateContentOnly` 中，将收到的整个 HTML 存入 `contentCache[cascadeId]`
2. 利用 DOM 解析，按顶层子节点（消息块）拆分，用内容 hash 作为 key
3. 合并新旧缓存，组装完整 DOM
4. 使用 `DocumentFragment` 高效更新

**修改文件**：
- `public/index.html` — `updateContentOnly` 函数重构 + 缓存逻辑

#### Phase 2: Server 端结构化输出（可选优化）

1. `captureHTML` 返回结构化 chunks
2. `/snapshot/:id` 支持增量返回（只返回变化的 chunks）

### 关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 缓存位置 | 浏览器内存（JS 对象） | 速度快，无持久化需求，关闭页面即清空 |
| 缓存粒度 | 消息级别（顶层子节点） | 最自然的分割单位，与 IDE 消息结构对齐 |
| 合并策略 | 新内容覆盖旧内容 | AI 正在生成的消息内容会持续变化 |
| 滚动行为 | 保留本地缓存内容 + 后台刷新 | 用户立即看到缓存内容，后台静默更新 |

### 验证方案

1. 打开长对话，滚动到底部
2. 向上滚动 → 应立即显示已缓存的历史内容，无空白
3. 继续向上到未缓存区域 → 显示加载提示 → IDE 加载后自动填充
4. 回到底部 → 立即显示，无闪烁
