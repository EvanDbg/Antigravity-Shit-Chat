# Fix: 通过 CDP 打开项目文件夹

## 问题描述

当 Antigravity 已在运行时，通过 Web UI 的"打开文件夹"按钮操作，预期打开指定文件夹，但实际行为是将已有的 Antigravity 窗口激活到前台，**文件夹未被打开**。

### 根因

macOS 的 `open -a Antigravity --args folder` 命令对已运行的应用只执行激活（activate），`--args` 参数不会传递给已运行的 Electron 进程。

## 修复方案

利用已有的 CDP（Chrome DevTools Protocol）WebSocket 连接，在 Antigravity 的 Electron 渲染进程中通过 `Runtime.evaluate` 执行 `require('child_process').spawn()` 来启动新窗口。

### 变更范围

- `server.js`：修改 `/api/open-project` 路由的 `alreadyRunning` 分支

### 验证标准

1. Antigravity 已运行时，点击 OPEN_HERE 按钮能打开新窗口并加载指定文件夹
2. 服务器日志显示通过 CDP 成功执行
3. CDP 不可用时能回退到原有方案
