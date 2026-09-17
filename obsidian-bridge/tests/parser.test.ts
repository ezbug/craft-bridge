import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNote, semanticBody } from "../src/parser.js";

describe("Obsidian Markdown semantic parser", () => {
  it("extracts frontmatter, inline tags and wikilinks", async () => {
    const raw = `---\ntitle: 人工智能\naliases: [AI, 智能]\ntags: [知识库, #研究]\n---\n# 正文标题\n\n关联 [[Draft/桥接|桥]] 和 ![[附件]]。\n\n#额外标签`;
    const root = await mkdtemp(join(tmpdir(), "obsidian-parser-"));
    await mkdir(join(root, "Draft"), { recursive: true });
    const absolute = join(root, "Draft", "人工智能.md");
    await writeFile(absolute, raw, "utf8");
    const note = await parseNote("Draft/人工智能.md", raw, absolute);
    expect(note.title).toBe("人工智能");
    expect(note.aliases).toEqual(["AI", "智能"]);
    expect(note.tags).toEqual(expect.arrayContaining(["知识库", "研究", "额外标签"]));
    expect(note.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawTarget: "Draft/桥接", display: "桥", embed: false }),
      expect.objectContaining({ rawTarget: "附件", embed: true }),
    ]));
  });

  it("removes Excalidraw compressed drawing while retaining text elements", () => {
    const raw = `---\nexcalidraw-plugin: parsed\n---\n# 图示\n## Text Elements\n这是可搜索的说明。\n## Drawing\nimage/png;base64,${"A".repeat(400)}`;
    const body = semanticBody(raw, raw.indexOf("# 图示"), "图示.excalidraw.md");
    expect(body).toContain("可搜索的说明");
    expect(body).not.toContain("image/png;base64");
  });
});
