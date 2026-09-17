import type {
  CraftCardSpec,
  CraftDocumentSummary,
  CraftFont,
  CraftInsertPosition,
  CraftInsertedBlock,
  CraftInsertResult,
  CraftSearchResult,
} from "./types.js";
import { craftCardMarkdown, normalizeCraftCardFont } from "./craft-card.js";

export interface CraftApiOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CraftApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: string) {
    super(message);
    this.name = "CraftApiError";
  }
}

export class CraftSpaceClient {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(apiUrl: string, options: CraftApiOptions = {}) {
    const normalized = apiUrl.trim().endsWith("/") ? apiUrl.trim() : `${apiUrl.trim()}/`;
    if (!/^https:\/\//i.test(normalized)) throw new Error("Craft Space API URL 必须使用 HTTPS");
    this.baseUrl = normalized;
    this.request = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async listDocuments(): Promise<CraftDocumentSummary[]> {
    const payload = await this.get("documents");
    return asArray(payload, "items").map(normalizeDocument).filter((item): item is CraftDocumentSummary => Boolean(item));
  }

  async searchDocuments(query: string, limit = 8): Promise<CraftSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const url = this.url("documents/search");
    url.searchParams.set("include", trimmed);
    url.searchParams.set("fetchMetadata", "true");
    const payload = await this.call(url, { headers: { Accept: "application/json" } });
    return asArray(payload, "items")
      .map((item) => normalizeSearchResult(item))
      .filter((item): item is CraftSearchResult => Boolean(item))
      .slice(0, Math.min(Math.max(limit, 1), 20));
  }

  async getBlocks(documentId: string): Promise<CraftInsertedBlock[]> {
    if (!documentId.trim()) throw new Error("Craft documentId 不能为空");
    const url = this.url("blocks");
    url.searchParams.set("id", documentId);
    url.searchParams.set("maxDepth", "-1");
    url.searchParams.set("fetchMetadata", "true");
    const payload = await this.call(url, { headers: { Accept: "application/json" } });
    const values = isRecord(payload) && stringValue(payload, "id") ? [payload] : asArray(payload, "items");
    return values.map(normalizeBlock).filter((item): item is CraftInsertedBlock => Boolean(item));
  }

  async readDocumentFont(documentId: string): Promise<CraftFont | undefined> {
    const blocks = await this.getBlocks(documentId);
    return blocks[0]?.font;
  }

  async resolveCardInsertPosition(documentId: string, focusedBlockId?: string, selection?: string): Promise<CraftInsertPosition> {
    const blocks = flatten(await this.getBlocks(documentId));
    const focused = focusedBlockId ? blocks.find((block) => block.id === focusedBlockId) : undefined;
    if (focused && !isDocumentPage(focused)) return { siblingId: focused.id, position: "after" };

    const selectedText = cleanText(selection ?? "");
    if (!selectedText) throw new Error("Craft 当前深链指向页面而非段落；请先在 Craft 中选中要连接的段落文字，再按快捷键");
    const matches = blocks.filter((block) => {
      if (block.id === documentId || !block.markdown) return false;
      return cleanText(block.markdown).includes(selectedText);
    });
    const match = matches[0];
    if (matches.length === 1 && match) return { siblingId: match.id, position: "after" };
    if (!matches.length) throw new Error("Craft 中找不到与选中文字对应的段落；请重新选中完整段落后再试");
    throw new Error("Craft 选中文字匹配到多个段落；请扩大选择范围使其唯一后再试");
  }

  async insertCard(documentId: string, spec: CraftCardSpec, position: CraftInsertPosition): Promise<CraftInsertResult> {
    const payload = await this.post("blocks", {
      markdown: craftCardMarkdown(spec),
      position: normalizePosition(documentId, position),
    });
    const blocks = asArray(payload, "items").map(normalizeBlock).filter((item): item is CraftInsertedBlock => Boolean(item));
    const rootBlockId = blocks[0]?.id;
    if (!rootBlockId) throw new Error("Craft API 插入成功但未返回 block ID");
    return { blocks, rootBlockId, insertedAt: position, verification: "pending", created: true };
  }

  async insertCardIdempotent(documentId: string, spec: CraftCardSpec, position: CraftInsertPosition): Promise<CraftInsertResult> {
    const existing = await this.verifyCard(documentId, spec.bridgeId);
    if (existing.verified && existing.blockId) return { blocks: [{ id: existing.blockId, type: "page", textStyle: "card", cardLayout: "regular" }], rootBlockId: existing.blockId, insertedAt: position, verification: "verified", created: false };
    const inserted = await this.insertCard(documentId, spec, position);
    const verified = await this.verifyCard(documentId, spec.bridgeId);
    if (!verified.verified) {
      try { await this.deleteBlocks([inserted.rootBlockId]); } catch { /* leave the original error and mark verification failure */ }
      throw new Error("Craft Card 写入后无法验证 Bridge ID");
    }
    return { ...inserted, verification: "verified" };
  }

  async deleteBlocks(blockIds: string[]): Promise<string[]> {
    const ids = [...new Set(blockIds.map((value) => value.trim()).filter(Boolean))];
    if (!ids.length) return [];
    const payload = await this.call(this.url("blocks"), {
      method: "DELETE",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ blockIds: ids }),
    });
    return asArray(payload, "items").map((item) => typeof item === "string" ? item : (isRecord(item) ? stringValue(item, "id") : undefined)).filter((item): item is string => Boolean(item));
  }

  async verifyCard(documentId: string, bridgeId: string): Promise<{ verified: boolean; blockId?: string }> {
    const blocks = await this.getBlocks(documentId);
    const match = flatten(blocks).find((block) => block.markdown?.includes(bridgeId));
    return { verified: Boolean(match), blockId: match?.id };
  }

  private async get(path: string): Promise<unknown> {
    return this.call(this.url(path), { headers: { Accept: "application/json" } });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.call(this.url(path), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private url(path: string): URL {
    return new URL(path.replace(/^\/+/, ""), this.baseUrl);
  }

  private async call(url: URL, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      if (!headers.has("User-Agent")) headers.set("User-Agent", "Craft-Obsidian-Bridge/0.1.0");
      response = await this.request(url, { ...init, headers, signal: controller.signal });
    } catch (error) {
      throw new Error(`Craft Space API 请求失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) {
      const body = text.slice(0, 500);
      const detail = craftApiErrorDetail(body);
      throw new CraftApiError(response.status, `Craft Space API 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`, body);
    }
    if (!text.trim()) return {};
    try { return JSON.parse(text) as unknown; } catch { throw new Error("Craft Space API 返回了无效 JSON"); }
  }
}

function normalizeDocument(value: unknown): CraftDocumentSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value, "id") ?? stringValue(value, "documentId");
  if (!id) return undefined;
  const title = stringValue(value, "title") ?? stringValue(value, "name") ?? `未命名 · ${id.slice(0, 8)}`;
  return {
    id,
    title: cleanText(title),
    url: stringValue(value, "url") ?? stringValue(value, "deepLink") ?? stringValue(value, "link") ?? `craftdocs://open?blockId=${encodeURIComponent(id)}`,
    location: stringValue(value, "location"),
    folderId: stringValue(value, "folderId"),
    lastModifiedAt: stringValue(value, "lastModifiedAt"),
    createdAt: stringValue(value, "createdAt"),
  };
}

function normalizeSearchResult(value: unknown): CraftSearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const document = normalizeDocument(value.document ?? value);
  if (!document) return undefined;
  const snippet = stringValue(value, "snippet") ?? stringValue(value, "content") ?? stringValue(value, "markdown");
  return { ...document, snippet: snippet ? cleanText(snippet).slice(0, 280) : undefined, matchedIn: ["body"], source: "remote" };
}

function normalizeBlock(value: unknown): CraftInsertedBlock | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value, "id");
  if (!id) return undefined;
  const content = Array.isArray(value.content) ? value.content.map(normalizeBlock).filter((item): item is CraftInsertedBlock => Boolean(item)) : undefined;
  return { id, type: stringValue(value, "type"), textStyle: stringValue(value, "textStyle"), cardLayout: stringValue(value, "cardLayout"), markdown: stringValue(value, "markdown"), content, font: normalizeCraftCardFont(value.font) };
}

function normalizePosition(documentId: string, position: CraftInsertPosition): CraftInsertPosition {
  if (position.siblingId && (position.position === "before" || position.position === "after")) return { siblingId: position.siblingId, position: position.position };
  return { pageId: position.pageId ?? documentId, position: position.position === "start" ? "start" : "end" };
}

function flatten(blocks: CraftInsertedBlock[]): CraftInsertedBlock[] {
  return blocks.flatMap((block) => [block, ...(block.content ? flatten(block.content) : [])]);
}

function isDocumentPage(block: CraftInsertedBlock): boolean {
  return block.type === "page" && block.textStyle === "page";
}

function asArray(payload: unknown, key: string): unknown[] {
  if (isRecord(payload) && Array.isArray(payload[key])) return payload[key] as unknown[];
  if (Array.isArray(payload)) return payload;
  return [];
}

function stringValue(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  return typeof result === "string" && result.trim() ? result.trim() : undefined;
}

function cleanText(value: string): string { return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim(); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null; }

function craftApiErrorDetail(body: string): string | undefined {
  if (!body.trim()) return undefined;
  try {
    const payload = JSON.parse(body) as unknown;
    if (isRecord(payload)) return stringValue(payload, "error") ?? stringValue(payload, "message") ?? body;
  } catch { /* keep a short plain-text response below */ }
  return cleanText(body);
}
