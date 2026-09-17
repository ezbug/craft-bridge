import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObsidianBridge } from "../src/bridge.js";
import type { BridgeConfig } from "../src/types.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "obsidian-craft-bridge-"));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await mkdir(join(vault, "Draft"), { recursive: true });
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await writeFile(join(vault, "Draft", "桥接.md"), "---\ntags: [MCP]\naliases: [连接]\n---\n# 桥接\n这是一个本地搜索目标。", "utf8");
  await writeFile(join(vault, "入口.md"), "# 入口\n\n[[Draft/桥接]]", "utf8");
  await writeFile(join(vault, ".obsidian", "private.md"), "不应被索引", "utf8");
  const config: BridgeConfig = { vaultRoot: vault, vaultName: "测试 Vault", stateDir: state, dbPath: join(state, "index.sqlite"), backupDir: join(state, "backups"), lockPath: join(state, "vault.lock"), backupRetentionDays: 30, maxReadChars: 20_000 };
  const bridge = await ObsidianBridge.create(config);
  await bridge.initialize();
  return { bridge, vault, state };
}

describe("local Obsidian index", () => {
  it("searches Chinese short queries and resolves backlinks without indexing .obsidian", async () => {
    const { bridge } = await fixture();
    expect(bridge.status().indexedFiles).toBe(2);
    expect((await stat(bridge.config.stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(bridge.config.backupDir)).mode & 0o777).toBe(0o700);
    expect(bridge.index.search("桥", undefined, undefined, 8)[0]?.title).toBe("桥接");
    expect(bridge.index.search("MCP", undefined, "MCP", 8)[0]?.path).toBe("Draft/桥接.md");
    expect(bridge.index.backlinks("Draft/桥接.md").backlinks[0]?.sourcePath).toBe("入口.md");
    expect(bridge.index.backlinks("入口.md").outlinks[0]?.targetPath).toBe("Draft/桥接.md");
    await expect(bridge.readNote("../outside.md")).rejects.toThrow();
    bridge.close();
  });
});
