import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import YAML from "yaml";
import type { ParsedNote } from "./types.js";

const WIKILINK = /(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

export async function parseNote(path: string, raw: string, absolutePath: string): Promise<ParsedNote> {
  const metadata = parseFrontmatter(raw);
  const body = semanticBody(raw, metadata.endOffset, path);
  const aliases = normalizeStringList(metadata.data.aliases);
  const tags = [...new Set([...normalizeTags(metadata.data.tags), ...inlineTags(body)])];
  const firstHeading = body.match(/^#{1,6}\s+(.+?)\s*$/m)?.[1]?.trim();
  const title = normalizeScalar(metadata.data.title) ?? firstHeading ?? basename(path, ".md");
  const links: ParsedNote["links"] = [];
  for (const match of body.matchAll(WIKILINK)) {
    const rawTarget = match[2]?.trim();
    if (!rawTarget) continue;
    links.push({ rawTarget, heading: match[3]?.trim() || undefined, display: match[4]?.trim() || undefined, embed: match[1] === "!" });
  }
  const info = await stat(absolutePath);
  const hash = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const searchText = [title, ...aliases, ...tags, body].join("\n");
  return { path, title, aliases, tags, body, searchText, links, hash, mtimeMs: info.mtimeMs, size: info.size };
}

export function semanticBody(raw: string, frontmatterEnd = 0, notePath = ""): string {
  let body = frontmatterEnd ? raw.slice(frontmatterEnd) : raw;
  if (/excalidraw/i.test(raw.slice(0, Math.min(raw.length, 500))) || /\.excalidraw\.md$/i.test(notePath)) {
    const drawingMarker = body.search(/^##\s+Drawing\s*$/mi);
    if (drawingMarker >= 0) body = body.slice(0, drawingMarker);
  }
  return body.replace(/data:[^\s)]+;base64,[A-Za-z0-9+/=]{100,}/g, "[embedded data omitted]").trim();
}

export function parseFrontmatter(raw: string): { data: Record<string, unknown>; endOffset: number } {
  if (!raw.startsWith("---")) return { data: {}, endOffset: 0 };
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match || match.index === undefined) return { data: {}, endOffset: 0 };
  try {
    const data = YAML.parse(match[1] ?? "");
    return { data: isRecord(data) ? data : {}, endOffset: match.index + match[0].length };
  } catch {
    return { data: looseFrontmatter(match[1] ?? ""), endOffset: match.index + match[0].length };
  }
}

function looseFrontmatter(value: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!key) continue;
    const scalar = match[2]?.trim() ?? "";
    if (scalar.startsWith("[") && scalar.endsWith("]")) {
      result[key] = scalar.slice(1, -1).split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
    } else {
      result[key] = scalar.replace(/^['\"]|['\"]$/g, "");
    }
  }
  return result;
}

export function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(normalizeStringList).filter(Boolean);
  const scalar = normalizeScalar(value);
  return scalar ? [scalar] : [];
}

function normalizeTags(value: unknown): string[] {
  return normalizeStringList(value).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean);
}

function inlineTags(value: string): string[] {
  return [...value.matchAll(/(?:^|\s)#([^\s#`]+?)(?=$|[\s.,;:!?，。；：！？)）])/gm)].map((match) => match[1] ?? "").filter(Boolean);
}

function normalizeScalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
