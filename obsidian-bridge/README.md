# Craft Bridge · 本机服务与 MCP

Bridge 为独立 macOS 菜单栏 App 和 MCP 客户端提供本地 Obsidian 搜索、Craft 文档查询与可回滚的双向链接流程。它只读取你显式选择的 Vault；不会把 Vault 正文整体上传或创建镜像文档。

## 能做什么

- 为 Vault 中的 Markdown 建立本地索引，覆盖标题、正文、YAML `tags` / `aliases` 和 wikilink；忽略 `.obsidian`、`.trash`、`.git`、`node_modules` 等目录。
- 在 MCP 客户端中搜索、按需读取笔记，并查看出链与反向链接。
- 与本机 RPC 配合，在预览、确认后把 Craft Card 和 Obsidian 链接写到各自一侧。
- 比较预期哈希、在 Vault 外保存回滚备份、原子替换并读回验证；如果用户编辑导致内容变化，则拒绝覆盖。

完整用户流程、安装和隐私说明见仓库根目录 [README](../README.md)。

## 本机 RPC

菜单栏 App 启动本机 RPC daemon；它只监听 `127.0.0.1`，默认端口为 `47832`，并要求 Bearer Token。RPC 由 Obsidian 插件使用。端口可在 App 设置中变更，插件端也要填写相同端口。

主要端点：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | 不含敏感资料的存活探测 |
| `GET` | `/status` | RPC、索引、Craft 配置及编辑器状态 |
| `POST` | `/search/obsidian` | 搜索所选 Vault |
| `POST` | `/search/craft` | 查询 Craft 搜索缓存与 Space API |
| `POST` | `/craft/refresh` | 刷新 Craft 文档缓存 |

事务端点供 App 与插件执行预览、应用、验证和回滚。除 `/health` 外，RPC 请求需在 `Authorization` Header 中附带 `Bearer <token>`。不要把 Token 暴露在网络、日志、截图或同步范围不明的配置中。

## MCP 工具

stdio MCP 适用于高级用户或开发者；它与菜单栏 App 的 RPC daemon 是不同的启动方式。MCP 客户端应直接启动 `dist/src/index.js`，不要把 `dist/src/daemon.js` 当成 MCP server。

- `search_obsidian_notes`：返回本地索引中的相关结果，默认 8 条，上限 20 条。
- `read_obsidian_note`：按需读取单篇笔记或指定标题章节；默认最多返回 20,000 个字符。
- `list_obsidian_backlinks`：查看指定笔记的出链和反向链接。
- `index_status`：检查索引数量、覆盖率、扫描状态和文件监听器。
- `preview_obsidian_link_change`：生成 Obsidian 托管链接补丁，不写入文件。
- `apply_obsidian_link_change`：验证用户确认与预期哈希后写入。
- `verify_obsidian_link`：读回并确认链接。
- `rollback_obsidian_link`：在当前内容仍符合预期时恢复本地备份。

## 开发运行

需要 [Node.js 22.23.2（Jod LTS）](https://nodejs.org/en/download/archive/v22.23.2/) 或兼容的 Node 22 版本。应用发行包已包含固定版本的 Apple Silicon Node 运行时；下面的步骤仅适用于从源码运行 MCP。

```bash
cd obsidian-bridge
npm ci
npm run build
npm test
npm run lint
```

设置环境变量后启动：

```bash
export OBSIDIAN_VAULT="/absolute/path/to/your/Obsidian Vault"
export OBSIDIAN_VAULT_NAME="Your Vault"
node dist/src/index.js
```

将 stdout 保留给 MCP 协议，不要向该进程输出调试文本。日志和诊断写入 stderr。

## MCP 客户端配置示例

```json
{
  "mcpServers": {
    "craft-obsidian-bridge": {
      "command": "node",
      "args": ["/path/to/craft-bridge/obsidian-bridge/dist/src/index.js"],
      "env": {
        "OBSIDIAN_VAULT": "/absolute/path/to/your/Obsidian Vault",
        "OBSIDIAN_VAULT_NAME": "Your Vault"
      }
    }
  }
}
```

请将示例路径替换为你自己的绝对路径，不要复制真实用户路径到公开配置。MCP 启动时如需 Craft API，可从 macOS Keychain 读取 `craft-obsidian-bridge` / `full-space` 项；源码开发也可使用 `CRAFT_SPACE_API_URL` 环境变量覆盖，但不要将有效 API Connection 写入客户端配置、`.env` 或版本库。App 用户应在引导页保存 Connection。

## 配置契约

App 在 `~/Library/Application Support/craft-obsidian-bridge/config.json` 保存非敏感用户配置：

```json
{
  "schemaVersion": 1,
  "vaultPath": "/absolute/path/to/your/Obsidian Vault",
  "vaultName": "Your Vault",
  "port": 47832,
  "launchAtLogin": false
}
```

字段说明：

- `schemaVersion`：当前为 `1`。未知版本会拒绝启动，不会自动改写。
- `vaultPath`、`vaultName`：用户选择的 Vault 位置与 Obsidian URI 所用名称。
- `port`：本机 RPC 端口，范围 `1024–65535`，默认 `47832`。
- `launchAtLogin`：是否登录时启动，默认 `false`。

Craft API Connection 保存在 macOS Keychain，不属于此 JSON。RPC Bearer Token 保存在同一 Application Support 目录下独立的 `bridge.token` 文件。索引、Craft 搜索缓存和备份也保存在本地状态目录。

### 环境变量

`obsidian-bridge/.env.example` 列出可用的开发覆盖项；应用不会自动读取 dotenv 文件。

| 变量 | 作用 | 默认值 |
|---|---|---|
| `OBSIDIAN_VAULT` | 指定 Vault 绝对路径；优先于 `config.json`，供 MCP 开发使用 | 无；未配置时拒绝启动 |
| `OBSIDIAN_VAULT_NAME` | 指定 Vault 显示名 | 路径最后一段 |
| `CRAFT_BRIDGE_PORT` | 本机 RPC 端口 | `47832` |
| `OBSIDIAN_BRIDGE_CONFIG` | 覆盖 JSON 配置位置 | 用户状态目录下的 `config.json` |
| `OBSIDIAN_BRIDGE_STATE_DIR` | 覆盖索引、缓存、Token 和备份目录 | macOS Application Support 下的 `craft-obsidian-bridge` |
| `OBSIDIAN_BRIDGE_BACKUPS` | 覆盖备份目录 | `<stateDir>/backups` |
| `OBSIDIAN_BRIDGE_BACKUP_RETENTION_DAYS` | 备份保留期限 | `30` 天 |
| `OBSIDIAN_BRIDGE_MAX_READ_CHARS` | MCP 单次读取上限 | `20000` 字符 |
| `OBSIDIAN_BRIDGE_LAUNCH_AT_LOGIN` | 覆盖登录启动偏好 | `false` |
| `CRAFT_SPACE_API_URL` | 源码开发时可选的 Keychain 覆盖 | 未设置时读取 Keychain |
| `CRAFT_BRIDGE_DISABLE_CRAFT_API` | 测试隔离：设为 `1` 时不读取环境变量或用户 Keychain 中的 Craft Connection | `false` |

## Craft API

请在 Craft 的 Imagine/API 页面创建 API Connection。Full Space API 支持全空间搜索、获取 block、插入或更新 block 等操作；当前连接实际允许访问的内容范围由 Craft Connection 设置决定。请参阅 [Craft API 帮助](https://support.craft.do/en/integrate/api) 和 [Space API 文档](https://connect.craft.do/api-docs/space)。

如果 Craft API 响应无法确认写入结果，Bridge 会返回待验证状态，不会把不确定结果报告为成功。自动化测试使用虚构的 API 响应，不会连接用户的 Craft Space。

## 测试

```bash
npm test
npm run lint
npm run build
```

测试应使用临时 Vault、虚构文档和本地替身 API。请勿用个人 Vault 或真实 Craft Space 执行破坏性验收。
