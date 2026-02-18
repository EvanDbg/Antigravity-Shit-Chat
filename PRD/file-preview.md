# 文件预览功能 (File Preview in Chat)

## 背景

Antigravity Shit-Chat 通过 CDP 镜像 IDE 聊天界面。当 AI 在对话中引用文件时（如 `server.js`、`README.md`），用户点击这些文件链接后，文件会在 IDE 中打开。但在网页端用户无法查看文件内容。

## 需求

1. **网页端文件预览**：点击聊天中的文件链接时，在网页端弹出一个模态窗口显示文件内容
2. **同时打开 IDE**：点击仍然通过 click passthrough 在 IDE 中打开文件
3. **代码查看器**：支持语法高亮显示代码文件
4. **Markdown 渲染**：`.md` 文件按 Markdown 语法渲染
5. **可关闭**：模态窗口有关闭按钮，点击遮罩层也可关闭

## 技术方案

### 1. 文件链接识别

在 `captureHTML()` 中增强标注逻辑，识别文件链接元素并额外添加 `data-file-link` 属性：

**识别策略**（在 IDE 端 DOM 中执行）：
- 查找 `<a>` 或 `<button>` 元素内文本匹配文件名模式（如 `xxx.ext`）的元素
- 检查元素的 `href` 或 `data-*` 属性是否包含文件路径
- 通过元素上下文判断（是否在代码引用区域内）
- 将匹配到的文件路径存入 `data-file-path` 属性

### 2. 文件内容获取（服务端直接读取）

> **结论**：经过测试，CDP 环境中 5 种文件读取方案（`require('fs')`、`import('fs')`、`globalThis.__require`、`fetch('file://')`、`fetch('vscode-file://')`）均失败。Electron 渲染进程不暴露 Node.js API。
>
> **替代方案**：由于 `server.js` 与文件在同一台机器上运行，直接通过 Node.js `fs.readFileSync` 读取。

新增 API 端点 `GET /api/file-content?path=<filepath>`：
- 服务端使用 `fs.readFileSync(path, 'utf-8')` 读取文件
- 安全校验：限制只读取项目工作区目录下的文件
- 返回 `{ content, filename, ext }`

### 3. 前端模态窗口

在 `index.html` 中新增：
- **模态窗口 HTML**：参照现有的 Account Manager Modal 样式
- **语法高亮**：引入 highlight.js CDN
- **Markdown 渲染**：引入 marked.js CDN
- **文件链接拦截**：在现有 click handler 中增加文件链接判断逻辑

### 4. 交互流程

```
用户点击文件链接
  ├─ 1. 正常 click passthrough → IDE 打开文件（现有逻辑不变）
  └─ 2. 同时发起 /api/file-content 请求
       ├─ 成功 → 弹出预览窗口
       │    ├─ .md 文件 → Markdown 渲染
       │    └─ 其他文件 → 代码查看器 + 语法高亮
       └─ 失败 → 静默失败，不影响 IDE 操作
```

## 修改文件

| 文件 | 改动 |
|------|------|
| `server.js` | `captureHTML()` 增加文件链接标注、新增 `/api/file-content/:id` 端点、新增 `readFileViaCDP()` 函数 |
| `public/index.html` | 文件预览模态窗口 HTML/CSS、引入 highlight.js + marked.js CDN、修改 click handler 逻辑 |

## 验证

### 需要确认的问题

> [!IMPORTANT]
> 1. **文件链接 HTML 结构**：当前快照中没有包含文件链接的示例。需要在 IDE 中让 AI 引用一个文件，然后抓取快照来确认具体的 HTML 结构
> 2. **CDP 文件读取方案**：需要测试在 Antigravity IDE 的 CDP 环境中，哪种方式能成功读取文件内容（VS Code API / Node.js fs / 其他）

### 测试步骤

1. 在 Antigravity IDE 中发起一个会引用文件的对话
2. 抓取快照 HTML，确认文件链接的具体 DOM 结构
3. 测试 CDP 文件读取脚本
4. 验证完整流程：点击文件链接 → IDE 打开 + 网页预览弹出
