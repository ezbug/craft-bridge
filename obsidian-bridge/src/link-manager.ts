import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat, unlink, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { BridgeConfig, LinkChangeAction, LinkOperation } from "./types.js";
import { assertExistingNote } from "./safe-path.js";
import { assertRelativeNotePath } from "./config.js";
import { IndexStore } from "./index-store.js";
import { craftCardMarkdown } from "./craft-card.js";

const START = "<!-- obsidian-craft-bridge:start -->";
const END = "<!-- obsidian-craft-bridge:end -->";
const CALLOUT_HEADER = "> [!info] 🔗 Craft 连接";
const ENTRY = /(?:^|\n)(?:>\s*)?<!-- obsidian-craft-bridge:entry (\{[\s\S]*?\}) -->[ \t]*\r?\n(?:>\s*)?- \[[^\]\r\n]*\]\([^\r\n]*\)[ \t]*/g;

interface ManagedEntry { id: string; title: string; url: string; }

export class LinkManager {
  constructor(readonly config: BridgeConfig, readonly store: IndexStore, private readonly onChanged?: (notePath: string) => Promise<void>) {}

  async preview(action: LinkChangeAction, notePathInput: string, craftTitleInput: string, craftUrlInput: string): Promise<LinkOperation> {
    const notePath = assertRelativeNotePath(notePathInput);
    const craftTitle = cleanTitle(craftTitleInput);
    const craftUrl = cleanUrl(craftUrlInput);
    const absolutePath = await assertExistingNote(this.config.vaultRoot, notePath);
    const content = await readFile(absolutePath, "utf8");
    const beforeHash = hash(content);
    const bridgeId = makeBridgeId(notePath, craftUrl);
    const current = parseManagedBlock(content);
    const entries = current.entries.slice();
    const existing = entries.find((entry) => entry.id === bridgeId);
    let nextEntries = entries;
    let changed = current.legacy && entries.length > 0;
    if (action === "add") {
      const next = { id: bridgeId, title: craftTitle, url: craftUrl };
      if (!existing || existing.title !== next.title || existing.url !== next.url) {
        nextEntries = existing ? entries.map((entry) => entry.id === bridgeId ? next : entry) : [...entries, next];
        changed = true;
      }
    } else if (existing) {
      nextEntries = entries.filter((entry) => entry.id !== bridgeId);
      changed = true;
    }
    const newContent = changed ? renderManagedBlock(content, nextEntries, current.range) : content;
    const operation: LinkOperation = {
      id: randomUUID(), action, notePath, craftTitle, craftUrl, bridgeId,
      expectedHash: beforeHash, beforeHash, status: "preview",
      patch: summarizePatch(content, newContent, action, changed),
      craftMarkdown: action === "add" ? craftMarkdown(craftTitle, this.config.vaultName, notePath, bridgeId) : "",
      changed, newContent, createdAt: new Date().toISOString(),
    };
    this.store.operationInsert(operation);
    return operation;
  }

  async apply(operationId: string, expectedHash: string, confirmation: string): Promise<LinkOperation & { conflict?: string }> {
    if (confirmation !== "apply") throw new Error("confirmation_required: pass confirmation='apply' after reviewing the preview");
    const stored = this.store.operationGet(operationId);
    if (!stored) throw new Error(`operation_not_found: ${operationId}`);
    const operation = fromRow(stored);
    if (operation.status !== "preview") throw new Error(`operation_not_previewable: ${operation.status}`);
    if (operation.expectedHash !== expectedHash) throw new Error("stale_preview: expected_hash does not match the preview");
    const absolutePath = await assertExistingNote(this.config.vaultRoot, operation.notePath);
    return withFileLock(this.config.lockPath, async () => {
      const currentContent = await readFile(absolutePath, "utf8");
      const currentHash = hash(currentContent);
      if (currentHash !== expectedHash) {
        this.store.operationUpdate(operation.id, { status: "failed" });
        return { ...operation, status: "failed", conflict: `file_changed: current=${currentHash} expected=${expectedHash}` };
      }
      const changed = operation.newContent !== undefined && operation.newContent !== currentContent;
      if (!changed) {
        this.store.operationUpdate(operation.id, { status: "applied", afterHash: currentHash });
        return { ...operation, status: "applied", afterHash: currentHash };
      }
      await mkdir(this.config.backupDir, { recursive: true });
      const backupPath = join(this.config.backupDir, `${new Date().toISOString().replaceAll(":", "-")}-${operation.id}.md`);
      await copyFile(absolutePath, backupPath);
      await atomicWrite(absolutePath, operation.newContent ?? currentContent);
      const afterContent = await readFile(absolutePath, "utf8");
      const afterHash = hash(afterContent);
      if (afterHash !== hash(operation.newContent ?? currentContent)) {
        this.store.operationUpdate(operation.id, { status: "failed", backupPath });
        throw new Error("verification_failed: post-write hash mismatch");
      }
      this.store.operationUpdate(operation.id, { status: "applied", afterHash, backupPath });
      await this.onChanged?.(operation.notePath);
      await pruneBackups(this.config.backupDir, this.config.backupRetentionDays);
      return { ...operation, status: "applied", afterHash, backupPath };
    });
  }

  async rollback(operationId: string, confirmation: string): Promise<LinkOperation> {
    if (confirmation !== "rollback") throw new Error("confirmation_required: pass confirmation='rollback'");
    const stored = this.store.operationGet(operationId);
    if (!stored) throw new Error(`operation_not_found: ${operationId}`);
    const operation = fromRow(stored);
    if (operation.status !== "applied" || !operation.backupPath || !operation.afterHash) throw new Error("rollback_unavailable: operation has no verified applied backup");
    const absolutePath = await assertExistingNote(this.config.vaultRoot, operation.notePath);
    return withFileLock(this.config.lockPath, async () => {
      const currentContent = await readFile(absolutePath, "utf8");
      const currentHash = hash(currentContent);
      if (currentHash !== operation.afterHash) throw new Error(`rollback_conflict: current=${currentHash} expected=${operation.afterHash}`);
      const backup = await readFile(operation.backupPath!, "utf8");
      await atomicWrite(absolutePath, backup);
      const restoredHash = hash(await readFile(absolutePath, "utf8"));
      if (restoredHash !== operation.beforeHash) throw new Error("rollback_verification_failed");
      this.store.operationUpdate(operation.id, { status: "rolled_back" });
      await this.onChanged?.(operation.notePath);
      return { ...operation, status: "rolled_back" };
    });
  }

  async verify(notePathInput: string, craftUrl?: string): Promise<{ notePath: string; hash: string; entries: ManagedEntry[]; matched?: ManagedEntry; uri: string }> {
    const notePath = assertRelativeNotePath(notePathInput);
    const absolutePath = await assertExistingNote(this.config.vaultRoot, notePath);
    const content = await readFile(absolutePath, "utf8");
    const entries = parseManagedBlock(content).entries;
    const matched = craftUrl ? entries.find((entry) => entry.id === makeBridgeId(notePath, cleanUrl(craftUrl))) : undefined;
    return { notePath, hash: hash(content), entries, matched, uri: `obsidian://open?vault=${encodeURIComponent(this.config.vaultName)}&file=${encodeURIComponent(notePath)}` };
  }
}

export function makeBridgeId(notePath: string, craftUrl: string): string {
  return `ocb-${createHash("sha256").update(`${notePath}\n${craftUrl}`).digest("hex").slice(0, 16)}`;
}

export function craftMarkdown(title: string, vaultName: string, notePath: string, bridgeId: string): string {
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(notePath)}`;
  return craftCardMarkdown({ title, targetUrl: uri, sourceLabel: "Obsidian", sourcePath: notePath, bridgeId, layout: "regular" });
}

function parseManagedBlock(content: string): { entries: ManagedEntry[]; legacy: boolean; range?: { start: number; end: number } } {
  const start = content.indexOf(START);
  const end = content.indexOf(END);
  if (start < 0 && end < 0) return { entries: [], legacy: false };
  if (start < 0 || end < start) throw new Error("managed_block_invalid: start/end markers are inconsistent");
  const block = content.slice(start, end + END.length);
  const entries: ManagedEntry[] = [];
  for (const match of block.matchAll(ENTRY)) {
    try {
      const value = JSON.parse(match[1] ?? "") as ManagedEntry;
      if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.url !== "string") throw new Error("bad entry");
      entries.push(value);
    } catch { throw new Error("managed_block_invalid: entry metadata is not valid JSON"); }
  }
  return { entries, legacy: !block.includes(CALLOUT_HEADER), range: { start, end: end + END.length } };
}

function renderManagedBlock(content: string, entries: ManagedEntry[], range?: { start: number; end: number }): string {
  if (entries.length === 0 && range) {
    const prefix = content.slice(0, range.start).replace(/\s*$/, "");
    const suffix = content.slice(range.end).replace(/^\s*/, "");
    return suffix ? `${prefix}\n\n${suffix}` : `${prefix}\n`;
  }
  const lines = [START, CALLOUT_HEADER];
  for (const entry of entries) {
    lines.push(`> <!-- obsidian-craft-bridge:entry ${JSON.stringify(entry)} -->`);
    lines.push(renderManagedLink(entry.title, entry.url));
  }
  lines.push(END);
  const block = lines.join("\n");
  if (range) {
    return `${content.slice(0, range.start)}${block}${content.slice(range.end)}`;
  }
  return `${content.replace(/\s*$/, "")}\n\n${block}\n`;
}

function summarizePatch(before: string, after: string, action: LinkChangeAction, changed: boolean): string {
  if (!changed) return `no-op: ${action} requested but the managed link state is already current`;
  return `${action}: managed Obsidian-Craft block changes ${before.length} → ${after.length} bytes; preview must be applied with the expected hash`;
}

export function renderManagedLink(title: string, url: string): string {
  return `> - [${title.replace(/[\r\n\[\]]/g, " ")}](${url.replace(/[\r\n]/g, "")})`;
}

function cleanTitle(value: string): string {
  const title = value.trim().replace(/[\r\n]/g, " ");
  if (!title) throw new Error("invalid_craft_title");
  return title.slice(0, 300);
}

function cleanUrl(value: string): string {
  const url = value.trim().replace(/[\r\n]/g, "");
  if (!/^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(url) || url.includes(")")) throw new Error("invalid_craft_url");
  return url.slice(0, 2000);
}

function hash(content: string): string { return `sha256:${createHash("sha256").update(content).digest("hex")}`; }

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  try { await stat(path); } catch { await writeFile(path, "", { flag: "a", mode: 0o600 }); }
  const release = await lockfile.lock(path, { retries: { retries: 8, minTimeout: 50, maxTimeout: 500 }, realpath: false });
  try { return await operation(); } finally { await release(); }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { await rename(temporary, path); } catch (error) { try { await unlink(temporary); } catch {} throw error; }
}

async function pruneBackups(directory: string, retentionDays: number): Promise<void> {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let entries: string[] = [];
  try { entries = await (await import("node:fs/promises")).readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry);
    try { const info = await stat(path); if (info.isFile() && info.mtimeMs < cutoff) await unlink(path); } catch {}
  }
}

function fromRow(row: Record<string, unknown>): LinkOperation {
  return {
    id: String(row.id), action: row.action as LinkChangeAction, notePath: String(row.note_path), craftTitle: String(row.craft_title), craftUrl: String(row.craft_url), bridgeId: String(row.bridge_id), expectedHash: String(row.expected_hash), beforeHash: String(row.before_hash), afterHash: row.after_hash ? String(row.after_hash) : undefined, backupPath: row.backup_path ? String(row.backup_path) : undefined, status: row.status as LinkOperation["status"], patch: String(row.patch), craftMarkdown: String(row.craft_markdown), newContent: row.new_content ? String(row.new_content) : undefined, createdAt: String(row.created_at),
  };
}
