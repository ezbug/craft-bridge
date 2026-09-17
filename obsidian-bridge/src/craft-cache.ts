import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CraftDocumentSummary, CraftSearchResult } from "./types.js";

interface CacheFile { version: 1; updatedAt: string; documents: CraftDocumentSummary[]; }

export class CraftDocumentCache {
  private documents = new Map<string, CraftDocumentSummary>();
  private updatedAt?: string;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as CacheFile;
      if (raw.version !== 1 || !Array.isArray(raw.documents)) return;
      this.documents = new Map(raw.documents.filter((item) => item?.id && item.title).map((item) => [item.id, item]));
      this.updatedAt = raw.updatedAt;
    } catch { /* first run or corrupted cache: remote refresh will rebuild it */ }
  }

  async refresh(documents: CraftDocumentSummary[]): Promise<void> {
    this.documents = new Map(documents.map((item) => [item.id, item]));
    this.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, JSON.stringify({ version: 1, updatedAt: this.updatedAt, documents }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, this.path);
  }

  search(query: string, limit = 8): CraftSearchResult[] {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return [];
    return [...this.documents.values()]
      .filter((doc) => doc.title.toLocaleLowerCase().includes(q))
      .sort((a, b) => score(b.title, q) - score(a.title, q) || a.title.localeCompare(b.title))
      .slice(0, Math.min(Math.max(limit, 1), 20))
      .map((doc) => ({ ...doc, matchedIn: ["title"], source: "cache" as const }));
  }

  get size(): number { return this.documents.size; }
  get lastUpdatedAt(): string | undefined { return this.updatedAt; }
  get(id: string): CraftDocumentSummary | undefined { return this.documents.get(id); }
}

function score(title: string, query: string): number {
  const lower = title.toLocaleLowerCase();
  if (lower === query) return 4;
  if (lower.startsWith(query)) return 3;
  if (lower.includes(query)) return 2;
  return 0;
}
