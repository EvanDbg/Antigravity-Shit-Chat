# Cloudflare Tunnel 兼容性修复

通过 Cloudflare Tunnel 访问 Remote Dev 时，页面显示"连接中"无法加载内容。根本原因是 WebSocket 协议硬编码为 `ws://`，但 Tunnel 使用 HTTPS，浏览器拒绝在安全页面上建立不安全的 WebSocket 连接。

## 问题分析

### 根因
[index.html](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/Antigravity-Remote Dev/public/index.html#L513) 第 513 行：

```javascript
ws = new WebSocket(`ws://${location.host}`);
```

当通过 Cloudflare Tunnel（`https://xxx.trycloudflare.com`）访问时：
1. 页面通过 HTTPS 加载 ✅
2. WebSocket 尝试连接 `ws://xxx.trycloudflare.com` ❌
3. 浏览器阻止混合内容（HTTPS 页面不允许 `ws://` 连接）
4. WebSocket 永远无法连接 → 页面一直卡在"连接中"

### 次要问题
[server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/Antigravity-Remote Dev/server.js#L518) 第 518 行，登录 cookie 的 `sameSite: 'lax'` 在 Tunnel 场景下可能正常工作（因为是同域），但缺少 `secure` 标志在 HTTPS 环境下可能导致 cookie 不被发送。

## Proposed Changes

### Frontend

#### [MODIFY] [index.html](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/Antigravity-Remote Dev/public/index.html)

自动检测当前页面协议，使用对应的 WebSocket 协议：

```diff
- ws = new WebSocket(`ws://${location.host}`);
+ const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
+ ws = new WebSocket(`${wsProtocol}//${location.host}`);
```

---

### Backend

#### [MODIFY] [server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/Antigravity-Remote Dev/server.js)

为 auth cookie 添加 `secure` 标志感知，当通过 HTTPS（Tunnel）访问时自动启用：

```diff
- res.cookie('auth', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
+ const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
+ res.cookie('auth', token, {
+     httpOnly: true,
+     maxAge: 7 * 24 * 60 * 60 * 1000,
+     sameSite: 'lax',
+     secure: isSecure
+ });
```

同时需要信任代理以正确读取 `x-forwarded-proto`：

```diff
  const app = express();
+ app.set('trust proxy', true);
```

## Verification Plan

### Manual Verification
1. 启动本地服务：`npm start`
2. 本地访问 `http://localhost:3563` 确认功能正常（ws:// 仍然工作）
3. 通过 Cloudflare Tunnel 访问，确认页面不再卡在"连接中"，WebSocket 自动使用 `wss://`
