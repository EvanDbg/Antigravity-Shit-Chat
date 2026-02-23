# 修复网页端点击文件后提示 File not found

## 问题

用户在网页端点击文件链接后，IDE 中成功打开了文件，但网页端的文件预览弹窗显示 `❌ File not found`。

## 根因

在 [server.js L1288](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/server.js#L1288) 中，路径从 tab 的 `ariaLabel` 提取：

```javascript
let filePath = tabInfo.ariaLabel.replace(/\s•\s.*$/, '').trim();
```

该正则只清理 ` • Modified` / ` • Unsaved` 等后缀。但当文件以 **preview 模式**打开时，`ariaLabel` 格式为：

```
~/path/to/file.md (preview ◎)
```

`(preview ◎)` 部分**未被清理**，导致路径变为：

```
/Users/evan/.../file.md (preview ◎)
```

这个路径不存在 → `ENOENT` → `File not found`。

## 修复方案

修改 L1288 的正则，同时清理 `• ...` 和 `(preview ...)` 后缀：

```diff
- let filePath = tabInfo.ariaLabel.replace(/\s•\s.*$/, '').trim();
+ let filePath = tabInfo.ariaLabel
+     .replace(/\s•\s.*$/, '')      // 清理 " • Modified" 等状态后缀
+     .replace(/\s*\(preview[^)]*\)/, '') // 清理 "(preview ◎)" 预览后缀
+     .trim();
```

## 文件变更

### [MODIFY] [server.js](file:///Users/evan/Documents/seafile/Seafile/00_Dev/Github/antigravity-remote-dev/server.js)

修改 L1288，增强 `ariaLabel` 的清理正则。

## 验证

- 在 IDE 中以 preview 模式打开文件 → 网页端点击后能正确显示文件预览
- 在 IDE 中正常打开文件（非 preview）→ 仍然正常工作
- 文件名本身包含括号的边缘场景 → 验证不会被误裁剪
