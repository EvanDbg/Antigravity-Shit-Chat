# Antigravity Remote Dev macOS 适配方案

## 概述

当前项目是一个基于 Node.js 的移动端监控工具，通过 Chrome DevTools Protocol (CDP) 连接 Antigravity IDE，提供实时聊天快照、消息注入和点击透传功能。项目代码在整体架构上是跨平台的（Node.js + Express + WebSocket），**只有少量 Windows 特定代码需要修改**。

## 调查结论

> [!TIP]
> 适配工作量较小，核心逻辑（CDP 通信、WebSocket、前端 UI）均为平台无关代码。仅需修改 `server.js` 中 2 处 Windows 特定逻辑，另外需要确认 Antigravity IDE 在 macOS 上的安装路径。

---

## 变更点详细分析

### 变更点 1：Antigravity 可执行文件路径（关键）

**文件**: [server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/Antigravity-Remote Dev/server.js#L34-L35)

**当前代码**:
```javascript
const ANTIGRAVITY_PATH = userConfig.antigravityPath || process.env.ANTIGRAVITY_PATH ||
    join(process.env.LOCALAPPDATA || 'C:\\Users\\EVAN\\AppData\\Local', 'Programs', 'Antigravity', 'Antigravity.exe');
```

**问题**:
- `LOCALAPPDATA` 是 Windows 专有环境变量，macOS 上不存在
- 路径默认值 `C:\Users\EVAN\AppData\Local\...` 是 Windows 路径
- `.exe` 后缀在 macOS 上不适用
- macOS 应用通常安装在 `/Applications/` 目录下，可执行文件在 `.app/Contents/MacOS/` 内

**修改方案**:
```javascript
function getDefaultAntigravityPath() {
    if (process.platform === 'darwin') {
        // macOS: 优先 /Applications，其次 ~/Applications
        const candidates = [
            '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
            join(process.env.HOME || '', 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Antigravity')
        ];
        return candidates.find(p => existsSync(p)) || candidates[0];
    }
    // Windows (原有逻辑)
    return join(process.env.LOCALAPPDATA || 'C:\\Users\\EVAN\\AppData\\Local',
        'Programs', 'Antigravity', 'Antigravity.exe');
}

const ANTIGRAVITY_PATH = userConfig.antigravityPath || process.env.ANTIGRAVITY_PATH || getDefaultAntigravityPath();
```

> [!IMPORTANT]
> 需要确认 Antigravity IDE 在 macOS 上的实际安装路径和可执行文件名称。如果 Antigravity 是基于 Electron 的应用，路径通常为 `/Applications/Antigravity.app/Contents/MacOS/Antigravity`。

---

### 变更点 2：spawn 进程启动参数

**文件**: [server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/Antigravity-Remote Dev/server.js#L455-L459)

**当前代码**:
```javascript
const child = spawn(ANTIGRAVITY_PATH, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
});
```

**问题**:
- `windowsHide: false` 是仅在 Windows 上生效的选项（在 macOS 上被忽略，不会报错但属于冗余代码）
- `detached: true` 在 macOS 上行为略有不同，但功能等效，可保留

**修改方案**:
```javascript
const spawnOptions = {
    detached: true,
    stdio: 'ignore',
};
if (process.platform === 'win32') {
    spawnOptions.windowsHide = false;
}
const child = spawn(ANTIGRAVITY_PATH, [`--remote-debugging-port=${port}`], spawnOptions);
```

> [!NOTE]
> 此变更为优化性质，不改不影响功能。`windowsHide` 在非 Windows 平台上会被 Node.js 忽略。

---

### 变更点 3：config.example.json 和 README 文档更新

**文件**: [config.example.json](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/Antigravity-Remote Dev/config.example.json), [README.md](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/Antigravity-Remote Dev/README.md)

**问题**:
- `README.md` 中 `antigravityPath` 字段描述为 `Path to Antigravity.exe (empty = auto-detect)`，暗示 Windows
- 启动命令 `antigravity . --remote-debugging-port=9000` 需确认 macOS 下是否同样可用

**修改方案**:
- 更新 README 中的路径描述，添加 macOS 说明
- 补充 macOS 下的启动方式说明，例如：
  ```bash
  # macOS
  /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=9000
  # 或通过 open 命令
  open -a Antigravity --args --remote-debugging-port=9000
  ```

---

## 无需修改的部分

| 模块 | 原因 |
|------|------|
| **CDP 连接逻辑** (`connectCDP`, `discover`, `extractMetadata` 等) | 基于 HTTP/WebSocket 协议，平台无关 |
| **前端页面** (`index.html`, `login.html`) | 纯 HTML/CSS/JS，在浏览器中运行，平台无关 |
| **认证系统** (`makeToken`, `verifyToken`, Cookie) | 使用 Node.js crypto 模块，跨平台 |
| **Express 路由和中间件** | 平台无关 |
| **WebSocket 服务** | 平台无关 |
| **消息注入和点击透传** (`injectMessage`, `/click/:id`) | 通过 CDP 远程执行，平台无关 |
| **NPM 依赖** (`ws`, `express`) | 纯 JS 包，无原生绑定，跨平台 |

---

## 前置确认事项

在实施适配之前，需要确认以下信息：

1. **Antigravity IDE 在 macOS 上是否已安装？安装路径是什么？**
   - 是否为标准 `.app` bundle（例如 `/Applications/Antigravity.app`）？
   - 可执行文件的确切路径是什么？

2. **Antigravity IDE macOS 版是否支持 `--remote-debugging-port` 参数？**
   - 如果是基于 Electron 的应用，通常默认支持此参数

3. **是否需要同时支持 Windows 和 macOS？还是仅适配 macOS 即可？**
   - 如果需要同时支持，代码需要做平台判断
   - 如果仅 macOS，可以直接替换

---

## 工作量评估

| 项目 | 工作量 | 优先级 |
|------|--------|--------|
| 修改 `ANTIGRAVITY_PATH` 默认路径逻辑 | ~10 行代码 | ⭐ 高 |
| 优化 `spawn` 参数 | ~5 行代码 | ⭐ 低（不改也不影响） |
| 更新 README 文档 | ~20 行文档 | ⭐ 中 |
| 测试验证 | 启动并验证 CDP 连接 | ⭐ 高 |

**总工作量**: 约 30 分钟，变更风险极低。

---

### 变更点 4：macOS 启动可靠性优化（新增）

**问题**: 
- macOS `open -a` 命令在应用已运行时会忽略启动参数（如 `--remote-debugging-port`）。
- 用户点击 Web 端 "Launch" 按钮时，如果 IDE 已运行且未开启调试端口，会导致连接失败且无反馈。

**修改方案**:
- 后端：在启动前检测端口占用；启动后轮询端口是否成功开启。
- 后端：若端口未开启（说明参数被忽略），返回 `RESTART_REQUIRED` 错误码。
- 前端：捕获该错误码，弹出提示框引导用户手动退出 IDE (Cmd+Q) 后重试。
