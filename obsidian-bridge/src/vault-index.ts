import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseNote } from "./parser.js";
import { assertRelativeNotePath } from "./config.js";
import { IndexStore } from "./index-store.js";
import type { BridgeConfig, IndexStatus, ParsedNote } from "./types.js";

const IGNORED_DIRECTORIES = new Set([".obsidian", ".trash", ".git", "node_modules"]);

export class VaultIndex {
  private readonly notes = new Map<string, ParsedNote>();
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private lastScanAt?: string;
  private lastScanDurationMs?: number;
  private lastError?: string;
  private watcherState: "active" | "unavailable" = "unavailable";

  constructor(readonly config: BridgeConfig, readonly store: IndexStore) {}

  async initialize(): Promise<void> {
    await stat(this.config.vaultRoot);
    await this.refresh();
    this.startWatcher();
  }

  async refresh(): Promise<void> {
    const started = Date.now();
    try {
      const files = await collectMarkdown(this.config.vaultRoot);
      const present = new Set<string>();
      const next = new Map<string, ParsedNote>();
      for (const path of files) {
        present.add(path);
        const absolute = join(this.config.vaultRoot, path);
        const raw = await readFile(absolute, "utf8");
        const parsed = await parseNote(path, raw, absolute);
        next.set(path, parsed);
        this.store.upsert(parsed);
      }
      this.store.removeMissing(present);
      this.notes.clear();
      for (const [path, note] of next) this.notes.set(path, note);
      this.store.resolveLinks(this.notes);
      this.lastScanAt = new Date().toISOString();
      this.lastScanDurationMs = Date.now() - started;
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastScanDurationMs = Date.now() - started;
      throw error;
    }
  }

  async update(relativePath: string): Promise<void> {
    if (this.closed) return;
    let path: string;
    try { path = assertRelativeNotePath(relativePath); } catch { return; }
    const absolute = join(this.config.vaultRoot, path);
    try {
      const raw = await readFile(absolute, "utf8");
      const parsed = await parseNote(path, raw, absolute);
      this.notes.set(path, parsed);
      this.store.upsert(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.notes.delete(path);
        this.store.remove(path);
      } else {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.store.resolveLinks(this.notes);
  }

  search(query: string, folder: string | undefined, tag: string | undefined, limit: number) {
    return this.store.search(query, { folder, tag, limit, vaultName: this.config.vaultName });
  }

  backlinks(path: string) {
    const normalized = assertRelativeNotePath(path);
    return { outlinks: this.store.outlinks(normalized, this.config.vaultName), backlinks: this.store.backlinks(normalized, this.config.vaultName) };
  }

  status(): IndexStatus {
    return this.store.status(this.config.vaultRoot, this.lastScanAt, this.lastScanDurationMs, this.lastError, this.watcherState);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
    this.store.close();
  }

  private startWatcher(): void {
    try {
      this.watcher = watch(this.config.vaultRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const path = String(filename).replace(/\\/g, "/");
        if (path.split("/").some((part) => IGNORED_DIRECTORIES.has(part)) || !path.toLowerCase().endsWith(".md")) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.update(path); }, 250);
      });
      this.watcherState = "active";
      this.watcher.on("error", (error) => { this.lastError = error.message; this.watcherState = "unavailable"; });
    } catch (error) {
      this.watcherState = "unavailable";
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}

async function collectMarkdown(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      output.push(relative(root, absolute).replace(/\\/g, "/"));
    }
  }
  await walk(root);
  return output.sort();
}
