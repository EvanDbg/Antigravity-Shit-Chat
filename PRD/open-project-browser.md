# PRD: Open New Project — Directory Browser

## 概述
在 AntiGravity Web UI 中添加目录浏览器功能，允许用户选择文件夹并在新 Antigravity 窗口中打开。

## 用户故事
- 作为用户，我想通过 Web UI 浏览本地文件系统目录
- 作为用户，我想选择一个文件夹并在新 Antigravity 窗口中打开
- 作为用户，我想在已有 Antigravity 运行时快速打开新项目（无需重新指定端口）

## 核心功能

### 1. 目录浏览 API
- `GET /api/workspace-root` — 获取起始目录
- `GET /api/browse?path=xxx` — 浏览目录（仅显示文件夹）
- `POST /api/open-project` — 智能启动新窗口

### 2. 智能启动策略
| 场景 | 行为 |
|------|------|
| Antigravity 已运行 | 不带 debug port，新窗口继承已有进程 |
| Antigravity 未运行 | 冷启动，使用 `--remote-debugging-port=9000` |

### 3. 跨平台支持
- **macOS**: `open -a Antigravity --args [folder] [--remote-debugging-port=9000]`
- **Windows**: `spawn(ANTIGRAVITY_PATH, [folder[, '--remote-debugging-port=9000']])`

### 4. UI 设计
- Header 📂 按钮打开弹窗
- Cyberpunk 主题 Modal（`#0ff` 霓虹色调）
- 面包屑导航 + 文件夹列表
- `⚡ OPEN_HERE` 按钮执行打开操作

## 验收标准
- [x] 目录浏览只显示文件夹，不显示文件
- [x] 面包屑可点击导航
- [x] 支持 macOS 和 Windows
- [x] 已运行时不指定端口，冷启动用 9000
- [x] 安全限制：禁止访问系统目录
- [x] Cyberpunk 主题保持一致
