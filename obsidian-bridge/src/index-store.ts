import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BacklinkResult, IndexStatus, NoteSearchResult, ParsedNote } from "./types.js";

type NoteRow = {
  path: string;
  title: string;
  aliases_json: string;
  tags_json: string;
  body: string;
  search_text: string;
  hash: string;
  mtime_ms: number;
  size: number;
};

export interface SearchOptions {
  folder?: string;
  tag?: string;
  limit: number;
  vaultName: string;
}

export class IndexStore {
  readonly db: Database.Database;
  readonly ftsMode: "trigram" | "substring";
  private readonly searchByFts: Database.Statement;
  private readonly searchBySubstring: Database.Statement;

  constructor(readonly dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        body TEXT NOT NULL,
        search_text TEXT NOT NULL,
        hash TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS note_tags (
        path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY(path, tag)
      );
      CREATE TABLE IF NOT EXISTS links (
        source_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
        target_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
        raw_target TEXT NOT NULL,
        heading TEXT,
        display TEXT,
        embed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source_path, raw_target, heading, display)
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        note_path TEXT NOT NULL,
        craft_title TEXT NOT NULL,
        craft_url TEXT NOT NULL,
        bridge_id TEXT NOT NULL,
        expected_hash TEXT NOT NULL,
        before_hash TEXT NOT NULL,
        after_hash TEXT,
        backup_path TEXT,
        status TEXT NOT NULL,
        patch TEXT NOT NULL,
        craft_markdown TEXT NOT NULL,
        new_content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS links_target_idx ON links(target_path);
      CREATE INDEX IF NOT EXISTS notes_mtime_idx ON notes(mtime_ms);
    `);
    try { this.db.exec("ALTER TABLE operations ADD COLUMN new_content TEXT NOT NULL DEFAULT ''"); } catch {
      // Existing bridge databases already have the column, or were created by this version.
    }
    let mode: "trigram" | "substring" = "trigram";
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, aliases, tags, body, tokenize='trigram')");
    } catch {
      mode = "substring";
    }
    this.ftsMode = mode;
    this.searchByFts = this.db.prepare(`
      SELECT n.*,
        (SELECT count(*) FROM links l WHERE l.source_path = n.path) AS outbound_count,
        (SELECT count(*) FROM links l WHERE l.target_path = n.path) AS backlink_count,
        bm25(notes_fts, 8.0, 3.0, 2.0, 1.0) AS score
      FROM notes_fts
      JOIN notes n ON n.path = notes_fts.path
      WHERE notes_fts MATCH @match
        AND (@folder = '' OR n.path = @folder OR n.path LIKE @folder || '/%')
        AND (@tag = '' OR EXISTS (SELECT 1 FROM note_tags nt WHERE nt.path = n.path AND nt.tag = @tag))
      ORDER BY score, n.title COLLATE NOCASE
      LIMIT @limit
    `);
    this.searchBySubstring = this.db.prepare(`
      SELECT n.*,
        (SELECT count(*) FROM links l WHERE l.source_path = n.path) AS outbound_count,
        (SELECT count(*) FROM links l WHERE l.target_path = n.path) AS backlink_count,
        0 AS score
      FROM notes n
      WHERE lower(n.search_text) LIKE '%' || lower(@query) || '%'
        AND (@folder = '' OR n.path = @folder OR n.path LIKE @folder || '/%')
        AND (@tag = '' OR EXISTS (SELECT 1 FROM note_tags nt WHERE nt.path = n.path AND nt.tag = @tag))
      ORDER BY CASE WHEN instr(lower(n.title), lower(@query)) > 0 THEN 0 ELSE 1 END,
        n.title COLLATE NOCASE
      LIMIT @limit
    `);
  }

  static async open(dbPath: string): Promise<IndexStore> {
    await mkdir(dirname(dbPath), { recursive: true });
    return new IndexStore(dbPath);
  }

  upsert(note: ParsedNote): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO notes(path,title,aliases_json,tags_json,body,search_text,hash,mtime_ms,size,updated_at)
        VALUES(@path,@title,@aliases,@tags,@body,@searchText,@hash,@mtimeMs,@size,@updatedAt)
        ON CONFLICT(path) DO UPDATE SET
          title=excluded.title, aliases_json=excluded.aliases_json, tags_json=excluded.tags_json,
          body=excluded.body, search_text=excluded.search_text, hash=excluded.hash,
          mtime_ms=excluded.mtime_ms, size=excluded.size, updated_at=excluded.updated_at
      `).run({
        path: note.path,
        title: note.title,
        aliases: JSON.stringify(note.aliases),
        tags: JSON.stringify(note.tags),
        body: note.body,
        searchText: note.searchText,
        hash: note.hash,
        mtimeMs: note.mtimeMs,
        size: note.size,
        updatedAt: Date.now(),
      });
      this.db.prepare("DELETE FROM note_tags WHERE path = ?").run(note.path);
      const insertTag = this.db.prepare("INSERT INTO note_tags(path,tag) VALUES(?,?)");
      for (const tag of note.tags) insertTag.run(note.path, tag);
      if (this.ftsMode === "trigram") {
        this.db.prepare("DELETE FROM notes_fts WHERE path = ?").run(note.path);
        this.db.prepare("INSERT INTO notes_fts(path,title,aliases,tags,body) VALUES(?,?,?,?,?)").run(note.path, note.title, note.aliases.join(" "), note.tags.join(" "), note.body);
      }
      this.db.prepare("DELETE FROM links WHERE source_path = ?").run(note.path);
    });
    tx();
  }

  remove(path: string): void {
    this.db.prepare("DELETE FROM notes WHERE path = ?").run(path);
    if (this.ftsMode === "trigram") this.db.prepare("DELETE FROM notes_fts WHERE path = ?").run(path);
  }

  removeMissing(paths: Set<string>): number {
    const rows = this.db.prepare("SELECT path FROM notes").all() as Array<{ path: string }>;
    const tx = this.db.transaction(() => {
      let removed = 0;
      for (const row of rows) {
        if (!paths.has(row.path)) {
          this.db.prepare("DELETE FROM notes WHERE path = ?").run(row.path);
          if (this.ftsMode === "trigram") this.db.prepare("DELETE FROM notes_fts WHERE path = ?").run(row.path);
          removed += 1;
        }
      }
      return removed;
    });
    return tx();
  }

  resolveLinks(notes: Map<string, ParsedNote>): void {
    const byNoExt = new Map<string, string>();
    const byBase = new Map<string, string[]>();
    for (const path of notes.keys()) {
      const noExt = path.replace(/\.md$/i, "").toLowerCase();
      byNoExt.set(noExt, path);
      const base = noExt.split("/").pop() ?? noExt;
      byBase.set(base, [...(byBase.get(base) ?? []), path]);
    }
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM links");
      const insert = this.db.prepare("INSERT OR IGNORE INTO links(source_path,target_path,raw_target,heading,display,embed) VALUES(?,?,?,?,?,?)");
      for (const [source, note] of notes) {
        for (const link of note.links) {
          const normalized = link.rawTarget.replace(/^\//, "").replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
          const exact = byNoExt.get(normalized);
          const candidates = exact ? [exact] : (byBase.get(normalized.split("/").pop() ?? "") ?? []);
          if (candidates.length !== 1) continue;
          insert.run(source, candidates[0], link.rawTarget, link.heading ?? null, link.display ?? null, link.embed ? 1 : 0);
        }
      }
    });
    tx();
  }

  search(query: string, options: SearchOptions): NoteSearchResult[] {
    const q = query.trim();
    if (!q) return [];
    const params = { folder: options.folder?.replace(/^\/+|\/+$/g, "") ?? "", tag: options.tag?.replace(/^#/, "") ?? "", limit: Math.min(Math.max(options.limit, 1), 20) };
    let rows: Array<NoteRow & { outbound_count: number; backlink_count: number }>;
    if (this.ftsMode === "trigram" && [...q].length >= 3) {
      const match = `"${q.replaceAll('"', '""')}"`;
      rows = this.searchByFts.all({ ...params, match }) as typeof rows;
    } else {
      rows = this.searchBySubstring.all({ ...params, query: q }) as typeof rows;
    }
    return rows.map((row) => this.toSearchResult(row, q, options.vaultName));
  }

  getNote(path: string): (ParsedNote & { updatedAt: number }) | undefined {
    const row = this.db.prepare("SELECT * FROM notes WHERE path = ?").get(path) as (NoteRow & { updated_at: number }) | undefined;
    if (!row) return undefined;
    return { path: row.path, title: row.title, aliases: JSON.parse(row.aliases_json) as string[], tags: JSON.parse(row.tags_json) as string[], body: row.body, searchText: row.search_text, links: [], hash: row.hash, mtimeMs: row.mtime_ms, size: row.size, updatedAt: row.updated_at };
  }

  backlinks(targetPath: string, vaultName: string): BacklinkResult[] {
    const rows = this.db.prepare(`SELECT l.source_path, n.title AS source_title, l.target_path, t.title AS target_title, l.display, l.raw_target, l.embed FROM links l JOIN notes n ON n.path = l.source_path JOIN notes t ON t.path = l.target_path WHERE l.target_path = ? ORDER BY n.title COLLATE NOCASE`).all(targetPath) as Array<{ source_path: string; source_title: string; target_path: string; target_title: string; display?: string; raw_target: string; embed: number }>;
    return rows.map((row) => ({ sourcePath: row.source_path, sourceTitle: row.source_title, targetPath: row.target_path, targetTitle: row.target_title, display: row.display || undefined, rawTarget: row.raw_target, embed: Boolean(row.embed), uri: this.uri(vaultName, row.source_path) }));
  }

  outlinks(sourcePath: string, vaultName: string): BacklinkResult[] {
    const rows = this.db.prepare(`SELECT l.source_path, n.title AS source_title, l.target_path, t.title AS target_title, l.display, l.raw_target, l.embed FROM links l JOIN notes n ON n.path = l.source_path JOIN notes t ON t.path = l.target_path WHERE l.source_path = ? ORDER BY t.title COLLATE NOCASE`).all(sourcePath) as Array<{ source_path: string; source_title: string; target_path: string; target_title: string; display?: string; raw_target: string; embed: number }>;
    return rows.map((row) => ({ sourcePath: row.source_path, sourceTitle: row.source_title, targetPath: row.target_path, targetTitle: row.target_title, display: row.display || undefined, rawTarget: row.raw_target, embed: Boolean(row.embed), uri: this.uri(vaultName, row.target_path) }));
  }

  operationInsert(operation: unknown): void {
    const op = operation as Record<string, unknown>;
    this.db.prepare(`INSERT INTO operations(id,action,note_path,craft_title,craft_url,bridge_id,expected_hash,before_hash,after_hash,backup_path,status,patch,craft_markdown,new_content,created_at) VALUES(@id,@action,@notePath,@craftTitle,@craftUrl,@bridgeId,@expectedHash,@beforeHash,@afterHash,@backupPath,@status,@patch,@craftMarkdown,@newContent,@createdAt)`).run({
      id: op.id, action: op.action, notePath: op.notePath, craftTitle: op.craftTitle, craftUrl: op.craftUrl, bridgeId: op.bridgeId, expectedHash: op.expectedHash, beforeHash: op.beforeHash, afterHash: op.afterHash ?? null, backupPath: op.backupPath ?? null, status: op.status, patch: op.patch, craftMarkdown: op.craftMarkdown, newContent: op.newContent ?? "", createdAt: op.createdAt,
    });
  }

  operationGet(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  operationUpdate(id: string, values: { status: string; afterHash?: string; backupPath?: string }): void {
    this.db.prepare("UPDATE operations SET status = @status, after_hash = COALESCE(@afterHash, after_hash), backup_path = COALESCE(@backupPath, backup_path) WHERE id = @id").run({ id, status: values.status, afterHash: values.afterHash ?? null, backupPath: values.backupPath ?? null });
  }

  status(vaultRoot: string, lastScanAt?: string, lastScanDurationMs?: number, lastError?: string, watcher: "active" | "unavailable" = "unavailable"): IndexStatus {
    const indexedFiles = (this.db.prepare("SELECT count(*) AS count FROM notes").get() as { count: number }).count;
    const indexedLinks = (this.db.prepare("SELECT count(*) AS count FROM links").get() as { count: number }).count;
    return { vaultRoot, indexedFiles, indexedLinks, lastScanAt, lastScanDurationMs, lastError, ftsMode: this.ftsMode, watcher };
  }

  close(): void { this.db.close(); }

  private toSearchResult(row: NoteRow & { outbound_count: number; backlink_count: number }, query: string, vaultName: string): NoteSearchResult {
    const aliases = JSON.parse(row.aliases_json) as string[];
    const tags = JSON.parse(row.tags_json) as string[];
    const lower = query.toLocaleLowerCase();
    const matchedIn: string[] = [];
    if (row.title.toLocaleLowerCase().includes(lower)) matchedIn.push("title");
    if (aliases.some((value) => value.toLocaleLowerCase().includes(lower))) matchedIn.push("alias");
    if (tags.some((value) => value.toLocaleLowerCase().includes(lower))) matchedIn.push("tag");
    if (row.body.toLocaleLowerCase().includes(lower)) matchedIn.push("body");
    const haystack = row.body || row.title;
    const at = Math.max(0, haystack.toLocaleLowerCase().indexOf(lower));
    const start = Math.max(0, at - 100);
    const snippet = `${start ? "…" : ""}${haystack.slice(start, start + 240).replace(/\s+/g, " ")}${start + 240 < haystack.length ? "…" : ""}`;
    return { path: row.path, title: row.title, aliases, tags, snippet, matchedIn, outboundLinkCount: row.outbound_count, backlinkCount: row.backlink_count, modifiedAt: new Date(row.mtime_ms).toISOString(), uri: this.uri(vaultName, row.path) };
  }

  private uri(vaultName: string, path: string): string {
    return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path)}`;
  }
}
