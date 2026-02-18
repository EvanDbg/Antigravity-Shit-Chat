# 文件预览 — 基于 Editor Active Tab

## 背景

旧方案使用 `find` 命令在文件系统搜索文件，速度慢(5-10s)、可能找到同名错误文件、且无法加载系统生成的 Artifact 文件。

## 新方案

点击文件链接 → 等待 300ms(Editor 打开文件) → 读取 Editor active tab 信息：

### 普通文件
- 从 `.monaco-icon-label[aria-label]` 提取完整路径
- 格式: `~/path/to/file.js • Modified`
- 展开 `~` → `fs.readFile` → 显示代码/Markdown 预览

### 系统 Artifact（Task/Implementation Plan/Walkthrough）
- 判断: `data-resource-name` 以 `.resolved` 结尾
- 通过 CDP 直接抓取 `.artifact-view .leading-relaxed.select-text` 的渲染 HTML
- 直接注入到预览 Modal

## 文件变更

- `server.js` — `/api/file-content` → `/api/active-file/:id`（CDP 读 active tab）
- `public/index.html` — click handler 等待 300ms + 调用新 API + 分类渲染
