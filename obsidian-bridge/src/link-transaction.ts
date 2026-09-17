import { createHash, randomUUID } from "node:crypto";
import type { ObsidianBridge } from "./bridge.js";
import type { CraftSpaceClient } from "./craft-api.js";
import { craftCardMarkdown } from "./craft-card.js";
import { renderManagedLink } from "./link-manager.js";
import { noteUri } from "./config.js";
import type {
  CraftCardSpec,
  CraftEditorContext,
  CraftInsertPosition,
  LinkTransactionPreview,
  LinkTransactionResult,
} from "./types.js";

export interface ObsidianEditorPort {
  insertLinkAtCursor(input: { label: string; url: string; expectedHash: string }): Promise<{ insertionId: string; afterHash: string }>;
  removeInsertedLink(input: { insertionId: string; expectedHash: string }): Promise<void>;
}

export interface StagedCraftCard {
  previewId: string;
  bridgeId: string;
  craftBlockId: string;
  sourceUrl: string;
  sourceLabel: string;
}

export interface CraftToObsidianInput {
  context: CraftEditorContext;
  targetNotePath: string;
  targetNoteTitle: string;
  targetSummary?: string;
  targetVaultName: string;
}

export interface ObsidianToCraftInput {
  sourceNotePath: string;
  sourceNoteTitle: string;
  sourceSummary?: string;
  sourceVaultName: string;
  targetDocumentId: string;
  targetDocumentTitle: string;
  targetDocumentUrl?: string;
  targetPosition?: CraftInsertPosition;
  selectedText?: string;
}

export class LinkTransactionManager {
  private readonly previews = new Map<string, PendingPreview>();
  private readonly staged = new Map<string, { pending: Extract<PendingPreview, { kind: "obsidian-to-craft" }>; craftBlockId: string }>();

  constructor(private readonly bridge: ObsidianBridge, private readonly craft: CraftSpaceClient) {}

  async previewCraftToObsidian(input: CraftToObsidianInput): Promise<LinkTransactionPreview> {
    assertCraftContext(input.context);
    const position = await this.craft.resolveCardInsertPosition(
      input.context.documentId,
      input.context.focusedBlockId,
      input.context.selection,
    );
    const craftUrl = input.context.documentUrl ?? `craftdocs://open?blockId=${encodeURIComponent(input.context.documentId)}`;
    const operation = await this.bridge.links.preview("add", input.targetNotePath, input.context.documentTitle ?? "Craft 文档", craftUrl);
    const bridgeId = operation.bridgeId;
    const spec = cardSpec({
      title: input.targetNoteTitle,
      targetUrl: noteUri(input.targetVaultName, input.targetNotePath),
      sourceLabel: "Obsidian 目标笔记",
      sourcePath: input.targetNotePath,
      summary: input.targetSummary,
      bridgeId,
      font: await this.craft.readDocumentFont(input.context.documentId).catch(() => undefined),
    });
    const preview = { id: randomUUID(), direction: "craft-to-obsidian" as const, source: { ...input.context, cardMarkdown: craftCardMarkdown(spec), position }, target: { notePath: input.targetNotePath, operationId: operation.id, expectedHash: operation.expectedHash, patch: operation.patch, obsidianLink: renderManagedLink(operation.craftTitle, operation.craftUrl) }, bridgeId, status: "preview" as const };
    this.previews.set(preview.id, { kind: "craft-to-obsidian", preview, operationId: operation.id, craftDocumentId: input.context.documentId, spec, position });
    return preview;
  }

  async applyCraftToObsidian(previewId: string): Promise<LinkTransactionResult> {
    const pending = this.takeCraft(previewId);
    const operationId = pending.operationId;
    let applied = false;
    let createdCraftBlockId: string | undefined;
    try {
      await this.bridge.links.apply(operationId, pending.preview.target.expectedHash as string, "apply");
      applied = true;
      const inserted = await this.craft.insertCardIdempotent(pending.craftDocumentId, pending.spec, pending.position);
      if (inserted.created) createdCraftBlockId = inserted.rootBlockId;
      const verified = await this.craft.verifyCard(pending.craftDocumentId, pending.spec.bridgeId);
      if (!verified.verified) throw new Error("Craft Card 写入后无法验证 Bridge ID");
      return { id: previewId, bridgeId: pending.spec.bridgeId, status: "applied", craftBlockId: inserted.rootBlockId, obsidianOperationId: operationId };
    } catch (error) {
      if (createdCraftBlockId) {
        try { await this.craft.deleteBlocks([createdCraftBlockId]); } catch (cleanupError) { return { id: previewId, bridgeId: pending.spec.bridgeId, status: "conflict", craftBlockId: createdCraftBlockId, obsidianOperationId: operationId, message: `${message(error)}；Craft Card 清理失败：${message(cleanupError)}` }; }
      }
      if (applied) {
        try { await this.bridge.links.rollback(operationId, "rollback"); } catch (rollbackError) {
          return { id: previewId, bridgeId: pending.spec.bridgeId, status: "conflict", obsidianOperationId: operationId, message: `${message(error)}；回滚失败：${message(rollbackError)}` };
        }
      }
      return { id: previewId, bridgeId: pending.spec.bridgeId, status: "failed", obsidianOperationId: operationId, message: message(error) };
    }
  }

  async previewObsidianToCraft(input: ObsidianToCraftInput): Promise<LinkTransactionPreview> {
    const craftUrl = input.targetDocumentUrl ?? `craftdocs://open?blockId=${encodeURIComponent(input.targetDocumentId)}`;
    const bridgeId = makeTransactionBridgeId(input.sourceNotePath, input.targetDocumentId);
    const spec = cardSpec({
      title: input.selectedText?.trim() || input.sourceNoteTitle,
      targetUrl: noteUri(input.sourceVaultName, input.sourceNotePath),
      sourceLabel: "Obsidian 来源笔记",
      sourcePath: input.sourceNotePath,
      summary: input.sourceSummary,
      bridgeId,
      font: await this.craft.readDocumentFont(input.targetDocumentId).catch(() => undefined),
    });
    const sourceUrl = craftUrl;
    const preview = { id: randomUUID(), direction: "obsidian-to-craft" as const, source: { notePath: input.sourceNotePath, link: { label: input.selectedText?.trim() || input.targetDocumentTitle, url: sourceUrl } }, target: { documentId: input.targetDocumentId, title: input.targetDocumentTitle, cardMarkdown: craftCardMarkdown(spec) }, bridgeId, status: "preview" as const };
    this.previews.set(preview.id, { kind: "obsidian-to-craft", preview, craftDocumentId: input.targetDocumentId, spec, position: input.targetPosition ?? { pageId: input.targetDocumentId, position: "end" }, sourceUrl, sourceLabel: input.selectedText?.trim() || input.targetDocumentTitle });
    return preview;
  }

  async applyObsidianToCraft(previewId: string, editor: ObsidianEditorPort): Promise<LinkTransactionResult> {
    const pending = this.takeObsidian(previewId);
    let insertedBlockId: string | undefined;
    try {
      const inserted = await this.craft.insertCardIdempotent(pending.craftDocumentId, pending.spec, pending.position);
      insertedBlockId = inserted.created ? inserted.rootBlockId : undefined;
      const verified = await this.craft.verifyCard(pending.craftDocumentId, pending.spec.bridgeId);
      if (!verified.verified) throw new Error("Craft Card 写入后无法验证 Bridge ID");
      const sourceHash = sha256(`${pending.preview.source.notePath}\n${pending.sourceUrl}`);
      const link = await editor.insertLinkAtCursor({ label: pending.sourceLabel, url: pending.sourceUrl, expectedHash: sourceHash });
      return { id: previewId, bridgeId: pending.spec.bridgeId, status: "applied", craftBlockId: insertedBlockId, message: link.insertionId };
    } catch (error) {
      if (insertedBlockId) {
        try { await this.craft.deleteBlocks([insertedBlockId]); } catch (rollbackError) { return { id: previewId, bridgeId: pending.spec.bridgeId, status: "conflict", craftBlockId: insertedBlockId, message: `${message(error)}；Craft 回滚失败：${message(rollbackError)}` }; }
      }
      if (isVerificationPending(error)) return { id: previewId, bridgeId: pending.spec.bridgeId, status: "verification_pending", message: message(error) };
      return { id: previewId, bridgeId: pending.spec.bridgeId, status: "failed", message: message(error) };
    }
  }

  async applyObsidianCard(previewId: string): Promise<StagedCraftCard> {
    const pending = this.takeObsidian(previewId);
    try {
      const inserted = await this.craft.insertCardIdempotent(pending.craftDocumentId, pending.spec, pending.position);
      const verified = await this.craft.verifyCard(pending.craftDocumentId, pending.spec.bridgeId);
      if (!verified.verified) throw new Error("Craft Card 写入后无法验证 Bridge ID");
      this.staged.set(previewId, { pending, craftBlockId: inserted.rootBlockId });
      return { previewId, bridgeId: pending.spec.bridgeId, craftBlockId: inserted.rootBlockId, sourceUrl: pending.sourceUrl, sourceLabel: pending.sourceLabel };
    } catch (error) {
      throw new Error(`craft_card_stage_failed: ${message(error)}`);
    }
  }

  finalizeObsidianCard(previewId: string, insertionId: string): LinkTransactionResult {
    const staged = this.staged.get(previewId);
    if (!staged) throw new Error("staged_transaction_not_found");
    if (!insertionId.trim()) throw new Error("editor_insertion_id_required");
    this.staged.delete(previewId);
    return { id: previewId, bridgeId: staged.pending.spec.bridgeId, status: "applied", craftBlockId: staged.craftBlockId, message: insertionId };
  }

  async rollbackStagedObsidianCard(previewId: string): Promise<LinkTransactionResult> {
    const staged = this.staged.get(previewId);
    if (!staged) throw new Error("staged_transaction_not_found");
    await this.craft.deleteBlocks([staged.craftBlockId]);
    this.staged.delete(previewId);
    return { id: previewId, bridgeId: staged.pending.spec.bridgeId, status: "rolled_back", craftBlockId: staged.craftBlockId };
  }

  private takeCraft(id: string): Extract<PendingPreview, { kind: "craft-to-obsidian" }> {
    const value = this.previews.get(id);
    if (!value || value.kind !== "craft-to-obsidian") throw new Error("transaction_preview_not_found_or_direction_mismatch");
    this.previews.delete(id);
    return value;
  }

  private takeObsidian(id: string): Extract<PendingPreview, { kind: "obsidian-to-craft" }> {
    const value = this.previews.get(id);
    if (!value || value.kind !== "obsidian-to-craft") throw new Error("transaction_preview_not_found_or_direction_mismatch");
    this.previews.delete(id);
    return value;
  }
}

interface PendingBase { preview: LinkTransactionPreview; craftDocumentId: string; spec: CraftCardSpec; position: CraftInsertPosition; }
type PendingPreview =
  | (PendingBase & { kind: "craft-to-obsidian"; operationId: string })
  | (PendingBase & { kind: "obsidian-to-craft"; sourceUrl: string; sourceLabel: string });

function cardSpec(spec: Omit<CraftCardSpec, "layout">): CraftCardSpec { return { ...spec, layout: "regular" }; }
function assertCraftContext(context: CraftEditorContext): void { if (!context.documentId || !context.focusedBlockId) throw new Error("Craft 当前段落无法唯一定位；请把光标放在一个正文块中重试"); }
function makeTransactionBridgeId(notePath: string, documentId: string): string { return `ocb-${createHash("sha256").update(`${notePath}\n${documentId}`).digest("hex").slice(0, 16)}`; }
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isVerificationPending(error: unknown): boolean { return /verification|timeout|network|请求失败/i.test(message(error)); }
