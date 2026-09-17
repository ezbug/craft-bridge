import { describe, expect, it } from "vitest";
import { craftCardMarkdown, normalizeCraftCardFont } from "../src/craft-card.js";

describe("Craft native cards", () => {
  it("renders a regular card without forcing colors and escapes text", () => {
    const markdown = craftCardMarkdown({ title: "标题 <测试>", targetUrl: "obsidian://open?vault=Demo%20Vault&file=Draft/桥.md", sourceLabel: "Obsidian", sourcePath: "Draft/桥.md", summary: "短摘要\n第二行", bridgeId: "ocb-123", layout: "regular" });
    expect(markdown).toContain("textStyle='card'");
    expect(markdown).toContain("cardLayout='regular'");
    expect(markdown).not.toContain("background");
    expect(markdown).not.toContain("color=");
    expect(markdown).toContain("Bridge ID: ocb-123");
    expect(markdown).toContain("标题 &lt;测试&gt;");
  });

  it("accepts only Craft supported font values", () => {
    expect(normalizeCraftCardFont("serif")).toBe("serif");
    expect(normalizeCraftCardFont("comic-sans")).toBeUndefined();
  });
});
