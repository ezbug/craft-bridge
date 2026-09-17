import { describe, expect, it } from "vitest";
import { CraftSpaceClient } from "../src/craft-api.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Craft Space API", () => {
  it("lists, searches, inserts and verifies a card", async () => {
    const calls: Array<{ url: string; method: string; body?: string; userAgent?: string }> = [];
    const client = new CraftSpaceClient("https://connect.craft.do/link/test/api/v1", { fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined, userAgent: headers.get("user-agent") ?? undefined });
      if (String(input).includes("documents/search")) return response({ items: [{ documentId: "doc-1", markdown: "摘要" }] });
      if (String(input).includes("documents")) return response({ items: [{ id: "doc-1", title: "桥" }] });
      if (init?.method === "POST") return response({ items: [{ id: "card-1", type: "page", textStyle: "card", cardLayout: "regular", content: [{ id: "text-1", markdown: "Bridge ID: ocb-1" }] }] });
      return response({ items: [{ id: "card-1", type: "page", content: [{ id: "text-1", markdown: "Bridge ID: ocb-1" }] }] });
    } });
    expect((await client.listDocuments())[0]?.title).toBe("桥");
    expect((await client.searchDocuments("桥"))[0]).toMatchObject({ id: "doc-1", snippet: "摘要" });
    const inserted = await client.insertCard("doc-1", { title: "桥", targetUrl: "obsidian://open?vault=Demo%20Vault&file=桥.md", sourceLabel: "Obsidian", sourcePath: "桥.md", bridgeId: "ocb-1", layout: "regular" }, { siblingId: "block-1", position: "after" });
    expect(inserted.rootBlockId).toBe("card-1");
    expect((await client.verifyCard("doc-1", "ocb-1")).verified).toBe(true);
    const postBody = JSON.parse(calls.find((call) => call.method === "POST")?.body ?? "{}") as Record<string, unknown>;
    expect(postBody).toMatchObject({
      markdown: expect.stringContaining("cardLayout='regular'"),
      position: { siblingId: "block-1", position: "after" },
    });
    expect(postBody).not.toHaveProperty("blocks");
    expect(calls.every((call) => call.userAgent === "Craft-Obsidian-Bridge/0.1.0")).toBe(true);
  });

  it("verifies a card when blocks returns a page root with nested content", async () => {
    const client = new CraftSpaceClient("https://connect.craft.do/link/test/api/v1", {
      fetchImpl: async () => response({
        id: "doc-1",
        type: "page",
        textStyle: "page",
        markdown: "测试文档",
        content: [
          {
            id: "card-1",
            type: "page",
            textStyle: "card",
            cardLayout: "regular",
            content: [{ id: "caption-1", type: "text", markdown: "Bridge ID: ocb-root-response" }],
          },
        ],
      }),
    });

    expect(await client.verifyCard("doc-1", "ocb-root-response")).toEqual({
      verified: true,
      blockId: "caption-1",
    });
  });

  it("resolves a page-root deep link to the uniquely selected paragraph", async () => {
    const client = new CraftSpaceClient("https://connect.craft.do/link/test/api/v1", {
      fetchImpl: async () => response({
        id: "page-1",
        type: "page",
        textStyle: "page",
        markdown: "Daily Note",
        content: [
          { id: "paragraph-1", type: "text", markdown: "第一段" },
          { id: "paragraph-2", type: "text", markdown: "这是需要连接的当前段落" },
        ],
      }),
    });

    await expect(client.resolveCardInsertPosition("page-1", "page-1", "需要连接的当前段落")).resolves.toEqual({
      siblingId: "paragraph-2",
      position: "after",
    });
  });

  it("refuses to use a page root as a sibling when no paragraph is uniquely selected", async () => {
    const client = new CraftSpaceClient("https://connect.craft.do/link/test/api/v1", {
      fetchImpl: async () => response({
        id: "page-1",
        type: "page",
        textStyle: "page",
        markdown: "Daily Note",
        content: [{ id: "paragraph-1", type: "text", markdown: "重复文字" }],
      }),
    });

    await expect(client.resolveCardInsertPosition("page-1", "page-1", "")).rejects.toThrow("请先在 Craft 中选中要连接的段落文字");
  });

  it("preserves Craft API error details for the transaction UI", async () => {
    const client = new CraftSpaceClient("https://connect.craft.do/link/test/api/v1", {
      fetchImpl: async () => response({ error: "siblingId must reference a non-page block" }, 400),
    });

    await expect(client.insertCard(
      "page-1",
      { title: "桥", targetUrl: "obsidian://open?vault=Demo%20Vault&file=桥.md", sourceLabel: "Obsidian", sourcePath: "桥.md", bridgeId: "ocb-1", layout: "regular" },
      { siblingId: "page-1", position: "after" },
    )).rejects.toThrow("siblingId must reference a non-page block");
  });
});
