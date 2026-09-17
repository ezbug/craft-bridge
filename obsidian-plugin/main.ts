import { MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { pollingErrorNotice, shouldPollEditor } from "./polling.js";

interface BridgeSettings { port: number; token: string; }
interface EditorContext { app: "Obsidian"; path: string; title: string; selection: string; line: number; lineText: string; contextHash: string; }

const DEFAULT_SETTINGS: BridgeSettings = { port: 47832, token: "" };

export default class CraftObsidianBridgePlugin extends Plugin {
  settings: BridgeSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() as Partial<BridgeSettings> | null) };
    this.addSettingTab(new BridgeSettingTab(this.app, this));
    this.addCommand({ id: "get-editor-context", name: "Bridge: get current editor context", callback: () => this.showContext() });
    this.addCommand({ id: "insert-craft-link", name: "Bridge: insert Craft link at cursor", callback: () => this.insertFromPrompt() });
    this.registerEvent(this.app.workspace.on("editor-change", () => { void this.pushContextAndInstruction(); }));
    this.registerInterval(window.setInterval(() => { void this.pushContextAndInstruction(); }, 700));
    void this.pushContextAndInstruction();
  }

  async get_editor_context(): Promise<EditorContext> {
    return this.editorContext(this.activeView());
  }

  private async editorContext(view: MarkdownView): Promise<EditorContext> {
    const cursor = view.editor.getCursor();
    const lineText = view.editor.getLine(cursor.line);
    const path = view.file?.path ?? "";
    return { app: "Obsidian", path, title: view.file?.basename ?? path, selection: view.editor.getSelection(), line: cursor.line, lineText, contextHash: await digest(`${path}\n${cursor.line}\n${lineText}`) };
  }

  async insert_link_at_cursor(input: { label: string; url: string; expectedHash?: string }): Promise<{ insertionId: string; afterHash: string }> {
    const view = this.activeView();
    const before = await this.get_editor_context();
    if (input.expectedHash && input.expectedHash !== await digest(`${before.path}\n${input.url}`) && input.expectedHash !== before.contextHash) throw new Error("editor_context_changed");
    const selection = view.editor.getSelection();
    const markdown = `[${sanitize(input.label)}](${sanitizeUrl(input.url)})`;
    view.editor.replaceSelection(markdown);
    const after = await this.get_editor_context();
    return { insertionId: `${before.path}:${before.line}:${markdown}`, afterHash: after.contextHash };
  }

  async verify_inserted_link(input: { url: string }): Promise<{ verified: boolean; path: string }> {
    const view = this.activeView();
    return { verified: view.editor.getValue().includes(input.url), path: view.file?.path ?? "" };
  }

  async remove_inserted_link(input: { markdown: string }): Promise<void> {
    const view = this.activeView();
    const cursor = view.editor.getCursor();
    const line = view.editor.getLine(cursor.line);
    const at = line.indexOf(input.markdown);
    if (at < 0) throw new Error("inserted_link_not_found_or_user_edited");
    view.editor.replaceRange("", { line: cursor.line, ch: at }, { line: cursor.line, ch: at + input.markdown.length });
  }

  private async pushContextAndInstruction(): Promise<void> {
    const view = this.tryActiveView();
    if (!shouldPollEditor(Boolean(this.settings.token), Boolean(view)) || !view) return;
    let instruction: { previewId?: string; label?: string; url?: string } | null = null;
    try {
      const context = await this.editorContext(view);
      await this.rpc("POST", "/editor/context", context);
      instruction = await this.rpc("GET", "/editor/instruction") as { previewId?: string; label?: string; url?: string } | null;
      if (!instruction?.previewId || !instruction.label || !instruction.url) return;
      const inserted = await this.insert_link_at_cursor({ label: instruction.label, url: instruction.url });
      await this.rpc("POST", "/transaction/finalize/obsidian-to-craft", { previewId: instruction.previewId, insertionId: inserted.insertionId });
    } catch (error) {
      if (instruction?.previewId) {
        try { await this.rpc("POST", "/transaction/rollback/obsidian-to-craft", { previewId: instruction.previewId }); } catch { /* daemon will retain the staged card for manual rollback */ }
      }
      const message = pollingErrorNotice(instruction?.previewId, error instanceof Error ? error.message : String(error));
      if (message) new Notice(message);
    }
  }

  private async rpc(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.settings.port}${path}`, { method, headers: { Authorization: `Bearer ${this.settings.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json() as unknown;
    if (!response.ok) throw new Error(isRecord(payload) && typeof payload.error === "string" ? payload.error : `RPC HTTP ${response.status}`);
    return payload;
  }

  private tryActiveView(): MarkdownView | null { return this.app.workspace.getActiveViewOfType(MarkdownView); }
  private activeView(): MarkdownView { const view = this.tryActiveView(); if (!view) throw new Error("没有活动的 Markdown 笔记"); return view; }
  private async showContext(): Promise<void> { new Notice(JSON.stringify(await this.get_editor_context())); }
  private async insertFromPrompt(): Promise<void> { new Notice("请从 Craft Bridge 菜单栏搜索器选择 Craft 文档后再插入。"); }
}

class BridgeSettingTab extends PluginSettingTab {
  constructor(app: any, private readonly plugin: CraftObsidianBridgePlugin) { super(app, plugin); }
  display(): void {
    const container = this.containerEl;
    container.empty();
    new Setting(container).setName("Bridge Port").setDesc("默认 47832").addText((text) => text.setValue(String(this.plugin.settings.port)).onChange(async (value) => { const port = Number(value); if (Number.isInteger(port)) this.plugin.settings.port = port; await this.plugin.saveData(this.plugin.settings); }));
    new Setting(container).setName("Bridge Token").setDesc("从 Craft Bridge App 复制本机 Token 后粘贴。插件设置可能随 Vault 同步，请确认同步范围符合隐私要求").addText((text) => { text.setValue(this.plugin.settings.token); text.inputEl.type = "password"; text.onChange(async (value) => { this.plugin.settings.token = value.trim(); await this.plugin.saveData(this.plugin.settings); }); });
  }
}

function sanitize(value: string): string { return value.replace(/[\r\n\[\]]/g, " ").trim().slice(0, 300) || "Craft 文档"; }
function sanitizeUrl(value: string): string { const url = value.replace(/[\r\n)]/g, "").trim(); if (!/^[a-z][a-z0-9+.-]*:\S+$/i.test(url)) throw new Error("invalid_url"); return url; }
async function digest(value: string): Promise<string> { const bytes = new TextEncoder().encode(value); const hash = await crypto.subtle.digest("SHA-256", bytes); return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
