# Craft Bridge · Obsidian 插件

这是 Obsidian 侧的桌面配套插件。它不索引 Vault，也不上传正文；只提供当前 Markdown 编辑器上下文和光标处链接写入能力。

## 安装

使用 macOS 菜单栏 App 首次设置向导选择 Vault 并安装插件文件。然后在 Obsidian → 设置 → 第三方插件中手动启用 Craft Bridge。

也可以从 GitHub Release 下载 `craft-obsidian-bridge-plugin-v0.1.0.zip`，将压缩包内的 `manifest.json`、`main.js`（以及如有的 `styles.css`）放入 Vault 的 `.obsidian/plugins/craft-obsidian-bridge/`，再在 Obsidian 中手动启用。不要把整个 App 压缩包复制到插件目录。

回到菜单栏 App，点击“复制本机连接 Token”，再粘贴到 Obsidian 的 Craft Bridge 插件设置。Token 文件保存在 `~/Library/Application Support/craft-obsidian-bridge/bridge.token`；不要把 Token 发给他人或提交到 Git。Obsidian 插件设置可能随 Vault 同步，请确认同步范围符合你的隐私要求。

插件默认连接 `127.0.0.1:47832`。如果在 App 设置中更改了 RPC 端口，也要在插件设置中填写相同端口。

插件需要 Obsidian 桌面版 1.5.0 或更新版本；不支持 Obsidian 移动端。

## 工作范围

插件只提供当前 Markdown 编辑器上下文和光标处链接写入能力，不索引 Vault，也不直接连接外网。它会通过 `127.0.0.1` 把当前文件路径、光标行文本和选区发给 Craft Bridge App；用户确认建立双链后，Bridge 可能将笔记标题、路径及最多 280 个字符的上下文摘要写入 Craft Card。完整 Vault 正文不会上传。

插件写入前会重新读取当前编辑器状态；内容发生变化时拒绝覆盖。删除只允许匹配仍未被用户改写的同一行链接。
