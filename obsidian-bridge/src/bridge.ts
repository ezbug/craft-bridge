import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { assertExistingNote } from "./safe-path.js";
import { IndexStore } from "./index-store.js";
import { LinkManager } from "./link-manager.js";
import { VaultIndex } from "./vault-index.js";
import type { BridgeConfig } from "./types.js";

export class ObsidianBridge {
  readonly store: IndexStore;
  readonly index: VaultIndex;
  readonly links: LinkManager;

  private constructor(readonly config: BridgeConfig, store: IndexStore) {
    this.store = store;
    this.index = new VaultIndex(config, store);
    this.links = new LinkManager(config, store, async (path) => this.index.update(path));
  }

  static async create(config: BridgeConfig): Promise<ObsidianBridge> {
    await mkdir(config.stateDir, { recursive: true });
    await mkdir(config.backupDir, { recursive: true });
    const store = await IndexStore.open(config.dbPath);
    return new ObsidianBridge(config, store);
  }

  async initialize(): Promise<void> { await this.index.initialize(); }

  async readNote(path: string, section?: string, maxChars = this.config.maxReadChars): Promise<Record<string, unknown>> {
    const absolutePath = await assertExistingNote(this.config.vaultRoot, path);
    const raw = await readFile(absolutePath, "utf8");
    const content = section ? readSection(raw, section) : raw;
    const limit = Math.min(maxChars ?? this.config.maxReadChars, this.config.maxReadChars);
    const limited = content.length > limit ? `${content.slice(0, limit)}\n\n[内容已截断；请缩小章节或提高受控上限]` : content;
    const note = this.store.getNote(path.replaceAll("\\", "/"));
    return { path: path.replaceAll("\\", "/"), title: note?.title, tags: note?.tags ?? [], aliases: note?.aliases ?? [], hash: sha256(raw), truncated: limited.length !== content.length, content: limited, uri: `obsidian://open?vault=${encodeURIComponent(this.config.vaultName)}&file=${encodeURIComponent(path)}` };
  }

  status() { return this.index.status(); }
  close(): void { this.index.close(); }
}

function readSection(raw: string, section: string): string {
  const needle = section.trim().toLocaleLowerCase();
  if (!needle) return raw;
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && line.replace(/^#{1,6}\s+/, "").trim().toLocaleLowerCase() === needle);
  if (start < 0) throw new Error(`section_not_found: ${section}`);
  const headingLevel = (lines[start]?.match(/^#+/)?.[0].length ?? 1);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const level = lines[index]?.match(/^(#+)\s+/)?.[1]?.length;
    if (level && level <= headingLevel) { end = index; break; }
  }
  return lines.slice(start, end).join("\n");
}

function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
