import assert from "node:assert/strict";
import test from "node:test";
import { pollingErrorNotice, shouldPollEditor } from "./polling.js";

test("background polling skips when no Markdown editor is active", () => {
  assert.equal(shouldPollEditor(true, false), false);
  assert.equal(shouldPollEditor(true, true), true);
  assert.equal(shouldPollEditor(false, true), false);
});

test("background RPC errors stay silent before a transaction instruction is claimed", () => {
  assert.equal(pollingErrorNotice(undefined, "没有活动的 Markdown 笔记"), undefined);
  assert.equal(pollingErrorNotice(undefined, "fetch failed"), undefined);
});

test("a claimed transaction failure remains visible", () => {
  assert.equal(
    pollingErrorNotice("preview-1", "editor_context_changed"),
    "Craft Bridge：editor_context_changed",
  );
});
