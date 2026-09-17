import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CraftDocumentCache } from "./craft-cache.js";
import { CraftSpaceClient } from "./craft-api.js";
import { readCraftSpaceApiUrl } from "./keychain.js";
import { LinkTransactionManager } from "./link-transaction.js";
import { ObsidianBridge } from "./bridge.js";
import { DEFAULT_BRIDGE_PORT, loadConfig } from "./config.js";
import { corsHeaders } from "./http.js";

export class LocalBridgeDaemon {
  private readonly server: Server;
  private readonly token: string;
  private readonly cache: CraftDocumentCache;
  private readonly transactions: LinkTransactionManager | undefined;
  private latestObsidianContext?: Record<string, unknown>;
  private pendingEditorInstruction?: { previewId: string; bridgeId: string; label: string; url: string; claimed: boolean };

  private constructor(private readonly bridge: ObsidianBridge, private readonly craft: CraftSpaceClient | undefined, token: string, private readonly port: number) {
    this.token = token;
    this.cache = new CraftDocumentCache(join(bridge.config.stateDir, "craft-documents.json"));
    this.transactions = craft ? new LinkTransactionManager(bridge, craft) : undefined;
    this.server = createServer((request, response) => { void this.handle(request, response); });
  }

  static async create(): Promise<LocalBridgeDaemon> {
    const config = loadConfig();
    const bridge = await ObsidianBridge.create(config);
    await bridge.initialize();
    const token = await loadOrCreateToken(config.stateDir);
    const craftUrl = await readCraftSpaceApiUrl();
    const craft = craftUrl ? new CraftSpaceClient(craftUrl) : undefined;
    const port = config.port ?? DEFAULT_BRIDGE_PORT;
    const daemon = new LocalBridgeDaemon(bridge, craft, token, port);
    await daemon.cache.load();
    return daemon;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, "127.0.0.1");
    });
    process.stderr.write(`[obsidian-craft-bridge] local RPC listening on 127.0.0.1:${this.port}\n`);
  }

  async close(): Promise<void> {
    this.bridge.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get accessToken(): string { return this.token; }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      if (request.method === "OPTIONS") return respond(response, 204, undefined, origin);
      if (request.method === "GET" && request.url === "/health") return respond(response, 200, { ok: true, port: this.port }, origin);
      if (request.headers.authorization !== `Bearer ${this.token}`) return respond(response, 401, { error: "unauthorized" }, origin);
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const body = request.method === "POST" ? await readJson(request) : {};
      if (request.method === "GET" && url.pathname === "/status") return respond(response, 200, { obsidian: this.bridge.status(), craft: this.craft ? { configured: true, cachedDocuments: this.cache.size, updatedAt: this.cache.lastUpdatedAt } : { configured: false }, editor: { obsidianContext: this.latestObsidianContext ?? null, pendingInstruction: this.pendingEditorInstruction ? { ...this.pendingEditorInstruction, claimed: undefined } : null } }, origin);
      if (request.method === "GET" && url.pathname === "/editor/context") return respond(response, 200, this.latestObsidianContext ?? { app: "Obsidian", available: false }, origin);
      if (request.method === "GET" && url.pathname === "/editor/instruction") {
        if (this.pendingEditorInstruction) this.pendingEditorInstruction.claimed = true;
        return respond(response, 200, this.pendingEditorInstruction ?? null, origin);
      }
      if (request.method === "POST" && url.pathname === "/editor/context") { this.latestObsidianContext = body; return respond(response, 200, { ok: true }, origin); }
      if (request.method === "POST" && url.pathname === "/search/obsidian") return respond(response, 200, this.searchObsidian(body), origin);
      if (request.method === "POST" && url.pathname === "/search/craft") return respond(response, 200, await this.searchCraft(body), origin);
      if (request.method === "POST" && url.pathname === "/craft/refresh") return respond(response, 200, await this.refreshCraft(), origin);
      if (request.method === "POST" && url.pathname === "/transaction/preview/craft-to-obsidian") return respond(response, 200, await this.requireTransactions().previewCraftToObsidian(body as unknown as Parameters<LinkTransactionManager["previewCraftToObsidian"]>[0]), origin);
      if (request.method === "POST" && url.pathname === "/transaction/apply/craft-to-obsidian") return respond(response, 200, await this.requireTransactions().applyCraftToObsidian(stringField(body, "previewId")), origin);
      if (request.method === "POST" && url.pathname === "/transaction/preview/obsidian-to-craft") return respond(response, 200, await this.requireTransactions().previewObsidianToCraft(body as unknown as Parameters<LinkTransactionManager["previewObsidianToCraft"]>[0]), origin);
      if (request.method === "POST" && url.pathname === "/transaction/apply/obsidian-to-craft-card") {
        const staged = await this.requireTransactions().applyObsidianCard(stringField(body, "previewId"));
        this.pendingEditorInstruction = { previewId: staged.previewId, bridgeId: staged.bridgeId, label: staged.sourceLabel, url: staged.sourceUrl, claimed: false };
        return respond(response, 200, { ...staged, status: "awaiting_editor" }, origin);
      }
      if (request.method === "POST" && url.pathname === "/transaction/finalize/obsidian-to-craft") {
        const result = this.requireTransactions().finalizeObsidianCard(stringField(body, "previewId"), stringField(body, "insertionId"));
        if (this.pendingEditorInstruction?.previewId === result.id) this.pendingEditorInstruction = undefined;
        return respond(response, 200, result, origin);
      }
      if (request.method === "POST" && url.pathname === "/transaction/rollback/obsidian-to-craft") {
        const result = await this.requireTransactions().rollbackStagedObsidianCard(stringField(body, "previewId"));
        if (this.pendingEditorInstruction?.previewId === result.id) this.pendingEditorInstruction = undefined;
        return respond(response, 200, result, origin);
      }
      return respond(response, 404, { error: "not_found" }, origin);
    } catch (error) {
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      respond(response, 400, { error: error instanceof Error ? error.message : String(error) }, origin);
    }
  }

  private searchObsidian(body: Record<string, unknown>): unknown {
    const query = stringField(body, "query");
    const limit = numberField(body, "limit", 8, 20);
    return { source: "obsidian", results: this.bridge.index.search(query, optionalString(body, "folder"), optionalString(body, "tag"), limit), limit };
  }

  private async searchCraft(body: Record<string, unknown>): Promise<unknown> {
    const craft = this.craft;
    if (!craft) return { source: "craft", configured: false, results: [], message: "未配置 Craft Full Space API" };
    const query = stringField(body, "query");
    const limit = numberField(body, "limit", 8, 20);
    if (!this.cache.size) await this.refreshCraft();
    const local = this.cache.search(query, limit);
    let remote = [] as Awaited<ReturnType<CraftSpaceClient["searchDocuments"]>>;
    let remoteError: string | undefined;
    try { remote = await craft.searchDocuments(query, limit); } catch (error) { remoteError = error instanceof Error ? error.message : String(error); }
    const merged = new Map(remote.map((item) => {
      const cached = this.cache.get(item.id);
      return [item.id, cached ? { ...cached, ...item, title: cached.title } : item] as const;
    }));
    for (const item of local) if (!merged.has(item.id)) merged.set(item.id, item);
    return { source: "craft", configured: true, results: [...merged.values()].slice(0, limit), cachedDocuments: this.cache.size, staleCache: Boolean(remoteError), error: remoteError };
  }

  private async refreshCraft(): Promise<unknown> {
    if (!this.craft) return { configured: false, refreshed: false };
    const documents = await this.craft.listDocuments();
    await this.cache.refresh(documents);
    return { configured: true, refreshed: true, documents: documents.length, updatedAt: this.cache.lastUpdatedAt };
  }

  private requireTransactions(): LinkTransactionManager {
    if (!this.transactions) throw new Error("Craft Full Space API 尚未配置");
    return this.transactions;
  }
}

async function loadOrCreateToken(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "bridge.token");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch { /* create below */ }
  const token = randomBytes(32).toString("base64url");
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 1_000_000) throw new Error("请求体超过 1 MB");
    chunks.push(value);
  }
  if (!bytes) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("请求体必须是 JSON 对象");
  return parsed;
}

function respond(response: ServerResponse, status: number, value: unknown, origin?: string): void {
  if (response.headersSent) return;
  const body = value === undefined ? "" : JSON.stringify(value);
  response.writeHead(status, { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  response.end(body);
}

function stringField(body: Record<string, unknown>, key: string): string { const value = body[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key}_required`); return value.trim(); }
function optionalString(body: Record<string, unknown>, key: string): string | undefined { const value = body[key]; return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function numberField(body: Record<string, unknown>, key: string, fallback: number, max: number): number { const value = body[key]; const result = typeof value === "number" && Number.isInteger(value) ? value : fallback; return Math.min(Math.max(result, 1), max); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export async function startLocalDaemon(): Promise<LocalBridgeDaemon> {
  const daemon = await LocalBridgeDaemon.create();
  await daemon.start();
  return daemon;
}
