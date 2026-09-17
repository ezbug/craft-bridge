import { describe, expect, it, vi } from "vitest";
import { LinkTransactionManager } from "../src/link-transaction.js";

describe("Craft to Obsidian transaction positioning", () => {
  it("resolves the selected Craft paragraph before creating an Obsidian preview", async () => {
    const preview = vi.fn().mockResolvedValue({
      id: "operation-1",
      bridgeId: "ocb-1",
      expectedHash: "sha256:before",
      patch: "patch",
      craftTitle: "Demo Craft Page",
      craftUrl: "craftdocs://open?blockId=page-1",
    });
    const resolveCardInsertPosition = vi.fn().mockResolvedValue({ siblingId: "paragraph-2", position: "after" });
    const manager = new LinkTransactionManager(
      { links: { preview } } as any,
      { resolveCardInsertPosition, readDocumentFont: vi.fn().mockResolvedValue(undefined) } as any,
    );

    const result = await manager.previewCraftToObsidian({
      context: {
        app: "Craft",
        documentId: "page-1",
        focusedBlockId: "page-1",
        documentTitle: "Demo Craft Page",
        documentUrl: "craftdocs://open?blockId=page-1",
        selection: "需要连接的当前段落",
        contextHash: "accessibility",
      },
      targetNotePath: "journal/test.md",
      targetNoteTitle: "测试",
      targetSummary: "演示摘要内容",
      targetVaultName: "Demo Vault",
    });

    expect(resolveCardInsertPosition).toHaveBeenCalledWith("page-1", "page-1", "需要连接的当前段落");
    expect(preview).toHaveBeenCalledOnce();
    expect(result.source).toMatchObject({ position: { siblingId: "paragraph-2", position: "after" } });
    expect(result.source.cardMarkdown).toContain("演示摘要内容");
    expect(result.target).toMatchObject({ obsidianLink: "> - [Demo Craft Page](craftdocs://open?blockId=page-1)" });
  });

  it("does not create an Obsidian preview when Craft paragraph resolution fails", async () => {
    const preview = vi.fn();
    const manager = new LinkTransactionManager(
      { links: { preview } } as any,
      {
        resolveCardInsertPosition: vi.fn().mockRejectedValue(new Error("请先在 Craft 中选中要连接的段落文字")),
        readDocumentFont: vi.fn(),
      } as any,
    );

    await expect(manager.previewCraftToObsidian({
      context: { app: "Craft", documentId: "page-1", focusedBlockId: "page-1", selection: "", contextHash: "accessibility" },
      targetNotePath: "journal/test.md",
      targetNoteTitle: "测试",
      targetVaultName: "Demo Vault",
    })).rejects.toThrow("请先在 Craft 中选中要连接的段落文字");

    expect(preview).not.toHaveBeenCalled();
  });
});
