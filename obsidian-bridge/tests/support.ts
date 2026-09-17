import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObsidianBridge } from "../src/bridge.js";
import type { BridgeConfig } from "../src/types.js";

export async function fixtureForLinks() {
  const root = await mkdtemp(join(tmpdir(), "obsidian-craft-links-"));
  const vault = join(root, "vault");
  const state = join(root, "state");
  await mkdir(vault, { recursive: true });
  const notePath = join(vault, "笔记.md");
  await writeFile(notePath, "# 原始笔记\n\n正文。\n", "utf8");
  const config: BridgeConfig = { vaultRoot: vault, vaultName: "测试 Vault", stateDir: state, dbPath: join(state, "index.sqlite"), backupDir: join(state, "backups"), lockPath: join(state, "vault.lock"), backupRetentionDays: 30, maxReadChars: 20_000 };
  const bridge = await ObsidianBridge.create(config);
  await bridge.initialize();
  return { bridge, notePath };
}
