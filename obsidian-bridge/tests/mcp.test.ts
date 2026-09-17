import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ObsidianBridge } from "../src/bridge.js";
import { createMcpServer } from "../src/mcp-server.js";
import { fixtureForLinks } from "./support.js";

describe("MCP protocol surface", () => {
  it("exposes all bridge tools and returns a bounded search result", async () => {
    const { bridge } = await fixtureForLinks();
    const server = createMcpServer(bridge as ObsidianBridge);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bridge-test-client", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "apply_obsidian_link_change", "index_status", "list_obsidian_backlinks", "preview_obsidian_link_change", "read_obsidian_note", "rollback_obsidian_link", "search_obsidian_notes", "verify_obsidian_link",
    ]);
    const result = await client.callTool({ name: "search_obsidian_notes", arguments: { query: "原始", limit: 8 } });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type?: string; text?: string }>)[0]?.text ?? "{}";
    expect(JSON.parse(text)).toMatchObject({ returned: 1, limit: 8, results: [{ path: "笔记.md" }] });
    await client.close(); await server.close(); bridge.close();
  });
});
