#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ObsidianBridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp-server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const bridge = await ObsidianBridge.create(config);
  await bridge.initialize();
  const server = createMcpServer(bridge);
  const transport = new StdioServerTransport();
  const close = async () => { await server.close().catch(() => undefined); bridge.close(); };
  process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`[obsidian-craft-bridge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
