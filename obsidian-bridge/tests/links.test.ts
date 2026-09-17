import { readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { makeBridgeId } from "../src/link-manager.js";
import { fixtureForLinks } from "./support.js";

describe("reversible managed Craft links", () => {
  it("previews without writing, applies idempotently, rejects stale hashes, and rolls back", async () => {
    const { bridge, notePath } = await fixtureForLinks();
    const before = await readFile(notePath, "utf8");
    const preview = await bridge.links.preview("add", "笔记.md", "Craft 文档", "craftdocs://open?id=123");
    expect(preview.craftMarkdown).toContain("textStyle='card'");
    expect(preview.craftMarkdown).toContain("cardLayout='regular'");
    expect(await readFile(notePath, "utf8")).toBe(before);
    const applied = await bridge.links.apply(preview.id, preview.expectedHash, "apply");
    expect(applied.status).toBe("applied");
    const calloutContent = await readFile(notePath, "utf8");
    expect(calloutContent).toContain("obsidian-craft-bridge:start");
    expect(calloutContent).toContain("> [!info] 🔗 Craft 连接");
    expect(calloutContent).toContain("> <!-- obsidian-craft-bridge:entry ");
    expect(calloutContent).toContain("> - [Craft 文档](craftdocs://open?id=123)");
    expect(calloutContent).not.toContain("## 🔗 Craft 连接");
    const noOp = await bridge.links.preview("add", "笔记.md", "Craft 文档", "craftdocs://open?id=123");
    expect(noOp.changed).toBe(false);
    const stale = await bridge.links.preview("add", "笔记.md", "另一个", "craftdocs://open?id=456");
    const appliedContent = await readFile(notePath, "utf8");
    await writeFile(notePath, `${appliedContent}\n用户新编辑\n`, "utf8");
    const conflict = await bridge.links.apply(stale.id, stale.expectedHash, "apply");
    expect(conflict.conflict).toContain("file_changed");
    await expect(bridge.links.rollback(preview.id, "rollback")).rejects.toThrow("rollback_conflict");
    await writeFile(notePath, appliedContent, "utf8");
    const rolled = await bridge.links.rollback(preview.id, "rollback");
    expect(rolled.status).toBe("rolled_back");
    expect(await readFile(notePath, "utf8")).toBe(before);
    expect((await stat(applied.backupPath!)).isFile()).toBe(true);
    const addAgain = await bridge.links.preview("add", "笔记.md", "Craft 文档", "craftdocs://open?id=123");
    await bridge.links.apply(addAgain.id, addAgain.expectedHash, "apply");
    const remove = await bridge.links.preview("remove", "笔记.md", "Craft 文档", "craftdocs://open?id=123");
    await bridge.links.apply(remove.id, remove.expectedHash, "apply");
    expect(await readFile(notePath, "utf8")).toBe(before);
    bridge.close();
  });

  it("migrates a legacy managed block once without duplicating the connection", async () => {
    const { bridge, notePath } = await fixtureForLinks();
    const before = await readFile(notePath, "utf8");
    const url = "craftdocs://open?id=123";
    const bridgeId = makeBridgeId("笔记.md", url);
    const legacy = `${before.trimEnd()}\n\n<!-- obsidian-craft-bridge:start -->\n## 🔗 Craft 连接\n<!-- obsidian-craft-bridge:entry ${JSON.stringify({ id: bridgeId, title: "Craft 文档", url })} -->\n- [Craft 文档](${url})\n<!-- obsidian-craft-bridge:end -->\n`;
    await writeFile(notePath, legacy, "utf8");

    const migration = await bridge.links.preview("add", "笔记.md", "Craft 文档", url);
    expect(migration.changed).toBe(true);
    expect(migration.newContent).toContain("> [!info] 🔗 Craft 连接");
    expect(migration.newContent).not.toContain("## 🔗 Craft 连接");
    const applied = await bridge.links.apply(migration.id, migration.expectedHash, "apply");
    expect(applied.status).toBe("applied");

    const migrated = await readFile(notePath, "utf8");
    expect(migrated.match(/obsidian-craft-bridge:entry/g)).toHaveLength(1);
    const noOp = await bridge.links.preview("add", "笔记.md", "Craft 文档", url);
    expect(noOp.changed).toBe(false);
    bridge.close();
  });

  it("keeps multiple Craft connections inside one shared callout", async () => {
    const { bridge, notePath } = await fixtureForLinks();
    const before = await readFile(notePath, "utf8");
    const first = await bridge.links.preview("add", "笔记.md", "Craft 一", "craftdocs://open?id=1");
    await bridge.links.apply(first.id, first.expectedHash, "apply");
    const second = await bridge.links.preview("add", "笔记.md", "Craft 二", "craftdocs://open?id=2");
    await bridge.links.apply(second.id, second.expectedHash, "apply");

    const content = await readFile(notePath, "utf8");
    expect(content.match(/> \[!info\] 🔗 Craft 连接/g)).toHaveLength(1);
    expect(content.match(/obsidian-craft-bridge:entry/g)).toHaveLength(2);
    expect(content).toContain("> - [Craft 一](craftdocs://open?id=1)");
    expect(content).toContain("> - [Craft 二](craftdocs://open?id=2)");

    const removeFirst = await bridge.links.preview("remove", "笔记.md", "Craft 一", "craftdocs://open?id=1");
    await bridge.links.apply(removeFirst.id, removeFirst.expectedHash, "apply");
    const removeSecond = await bridge.links.preview("remove", "笔记.md", "Craft 二", "craftdocs://open?id=2");
    await bridge.links.apply(removeSecond.id, removeSecond.expectedHash, "apply");
    expect(await readFile(notePath, "utf8")).toBe(before);
    bridge.close();
  });
});
