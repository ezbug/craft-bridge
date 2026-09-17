import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ObsidianBridge } from "./bridge.js";

export function createMcpServer(bridge: ObsidianBridge): McpServer {
  const server = new McpServer({ name: "obsidian-craft-bridge", version: "0.1.0" });
  const notePath = z.string().min(1).describe("Vault 内相对 Markdown 路径，例如 Draft/主题.md");

  server.registerTool("search_obsidian_notes", {
    title: "Search Obsidian notes",
    description: "在用户选择的本地 Obsidian Vault 中搜索标题、正文、YAML tags/aliases 与语义 wikilink。默认只返回最相关 8 条；明确要求时最多 20 条。索引和扫描不消耗模型 token，只有摘要会回传给 Agent。",
    inputSchema: {
      query: z.string().min(1),
      folder: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(20).default(8),
    },
  }, async ({ query, folder, tag, limit }) => callSafely(() => { const results = bridge.index.search(query, folder, tag, limit); return { query, results, returned: results.length, limit: Math.min(limit, 20) }; }));

  server.registerTool("read_obsidian_note", {
    title: "Read an Obsidian note",
    description: "按需读取单篇笔记或一个标题章节；受 maxReadChars 限制，避免把整个 Vault 或长正文发送给 Craft Agent。",
    inputSchema: { path: notePath, section: z.string().optional(), max_chars: z.number().int().min(100).max(50_000).optional() },
  }, async ({ path, section, max_chars }) => callSafely(() => bridge.readNote(path, section, max_chars)));

  server.registerTool("list_obsidian_backlinks", {
    title: "List Obsidian backlinks",
    description: "返回笔记已解析的出链和指向它的反向链接，包含标题、路径、显示文字与 obsidian:// 目标。",
    inputSchema: { path: notePath },
  }, async ({ path }) => callSafely(() => ({ path, ...bridge.index.backlinks(path) })));

  server.registerTool("index_status", {
    title: "Obsidian index status",
    description: "查看本地索引覆盖率、链接数、最近扫描耗时、FTS 模式与文件监听器状态。",
    inputSchema: {},
  }, async () => callSafely(() => bridge.status()));

  server.registerTool("preview_obsidian_link_change", {
    title: "Preview a reversible Obsidian link change",
    description: "生成受管 Obsidian 双链补丁和 Craft 原生 Regular Card 预览，不修改文件。Agent 必须把此预览展示给用户并在 apply 时携带 expected_hash 与 confirmation='apply'。",
    inputSchema: { action: z.enum(["add", "remove"]), note_path: notePath, craft_title: z.string().min(1), craft_url: z.string().min(1) },
  }, async ({ action, note_path, craft_title, craft_url }) => callSafely(() => bridge.links.preview(action, note_path, craft_title, craft_url)));

  server.registerTool("apply_obsidian_link_change", {
    title: "Apply an Obsidian link change",
    description: "在预览哈希仍匹配时，写入 Vault 外备份、原子替换、重新读取并校验 SHA-256。Craft Source 失败时应调用 rollback_obsidian_link。",
    inputSchema: { operation_id: z.string().uuid(), expected_hash: z.string().min(10), confirmation: z.literal("apply") },
  }, async ({ operation_id, expected_hash, confirmation }) => callSafely(() => bridge.links.apply(operation_id, expected_hash, confirmation)));

  server.registerTool("verify_obsidian_link", {
    title: "Verify an Obsidian managed link",
    description: "重新读取笔记并报告受管 Bridge ID、当前文件哈希和匹配项；只认实际存在且可打开的 Obsidian URI。",
    inputSchema: { note_path: notePath, craft_url: z.string().optional() },
  }, async ({ note_path, craft_url }) => callSafely(() => bridge.links.verify(note_path, craft_url)));

  server.registerTool("rollback_obsidian_link", {
    title: "Rollback an Obsidian link change",
    description: "仅在 apply 已验证且当前文件仍等于 after_hash 时，从 Vault 外备份原子恢复。用户新编辑会触发冲突并拒绝覆盖。",
    inputSchema: { operation_id: z.string().uuid(), confirmation: z.literal("rollback") },
  }, async ({ operation_id, confirmation }) => callSafely(() => bridge.links.rollback(operation_id, confirmation)));

  return server;
}

async function callSafely(operation: () => Promise<unknown> | unknown) {
  try {
    const value = await operation();
    const structuredContent = (typeof value === "object" && value !== null && !Array.isArray(value)) ? value as Record<string, unknown> : { result: value };
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }] };
  }
}
