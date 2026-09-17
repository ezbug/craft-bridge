import type { CraftCardSpec, CraftFont } from "./types.js";

const SUPPORTED_FONTS = new Set<CraftFont>(["system", "serif", "rounded", "mono"]);

export function craftCardMarkdown(spec: CraftCardSpec): string {
  const title = inlineLink(spec.title, spec.targetUrl);
  const open = inlineLink("打开 Obsidian 笔记", spec.targetUrl);
  const source = escapeText(`${spec.sourceLabel} · ${spec.sourcePath}`);
  const summary = spec.summary ? `\n${escapeText(compact(spec.summary))}` : "";
  const font = spec.font && SUPPORTED_FONTS.has(spec.font) ? ` font='${spec.font}'` : "";
  return `<page textStyle='card' cardLayout='regular'${font}>\n  <pageTitle>${title}</pageTitle>\n  <content>\n${open}\n<caption>${source} · Bridge ID: ${escapeText(spec.bridgeId)}</caption>${summary}\n  </content>\n</page>`;
}

export function normalizeCraftCardFont(value: unknown): CraftFont | undefined {
  return typeof value === "string" && SUPPORTED_FONTS.has(value as CraftFont) ? value as CraftFont : undefined;
}

export function extractBridgeId(markdown: string): string | undefined {
  return markdown.match(/Bridge ID:\s*([^<\n]+)/i)?.[1]?.trim();
}

function inlineLink(label: string, url: string): string {
  return `[${escapeText(label)}](${cleanUrl(url)})`;
}

function cleanUrl(value: string): string {
  const url = value.trim().replace(/[\r\n]/g, "");
  if (!/^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(url) || url.includes(")")) throw new Error("invalid_craft_card_url");
  return url.slice(0, 2_000);
}

function escapeText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 280);
}
