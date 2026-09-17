import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { assertRelativeNotePath } from "./config.js";

export function absoluteNotePath(vaultRoot: string, notePath: string): string {
  const relativePath = assertRelativeNotePath(notePath);
  const absolute = resolve(vaultRoot, relativePath);
  const outside = relative(vaultRoot, absolute);
  if (outside.startsWith("..") || isAbsolute(outside)) throw new Error("笔记路径逃逸 Vault 根目录");
  return absolute;
}

export async function assertExistingNote(vaultRoot: string, notePath: string): Promise<string> {
  const absolute = absoluteNotePath(vaultRoot, notePath);
  const canonicalRoot = await realpath(vaultRoot);
  const canonicalFile = await realpath(absolute);
  const outside = relative(canonicalRoot, canonicalFile);
  if (outside.startsWith("..") || isAbsolute(outside)) throw new Error("笔记 symlink 逃逸 Vault 根目录");
  if (!canonicalFile.toLowerCase().endsWith(".md")) throw new Error("目标不是 Markdown 文件");
  return canonicalFile;
}
