import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Obsidian entrypoint is a CommonJS bundle", async () => {
  const output = await readFile(new URL("./dist/main.js", import.meta.url), "utf8");

  assert.doesNotMatch(output, /^\s*import\s/m);
  assert.match(output, /require\(["']obsidian["']\)/);
  assert.match(output, /module\.exports|exports\.default/);
});

test("RPC always sends the Bridge Token to loopback, never a configurable host", async () => {
  const output = await readFile(new URL("./dist/main.js", import.meta.url), "utf8");

  assert.match(output, /http:\/\/127\.0\.0\.1:\$\{this\.settings\.port\}/);
  assert.doesNotMatch(output, /this\.settings\.host/);
});
