declare module "obsidian" {
  export class Plugin {
    app: App;
    addCommand(command: { id: string; name: string; callback: () => void | Promise<void> }): void;
    addSettingTab(tab: PluginSettingTab): void;
    registerInterval(id: number): void;
    registerEvent(event: unknown): void;
    loadData(): Promise<unknown>;
    saveData(value: unknown): Promise<void>;
  }
  export class PluginSettingTab { constructor(app: App, plugin: Plugin); display(): void; containerEl: HTMLElement; }
  export class Setting { constructor(container: HTMLElement); setName(value: string): this; setDesc(value: string): this; addText(callback: (text: TextComponent) => void): this; }
  export class Notice { constructor(message: string); }
  export class TFile { path: string; basename: string; }
  export class MarkdownView { file?: TFile; editor: Editor; }
  export interface App { workspace: Workspace; }
  export interface Workspace { getActiveViewOfType<T>(type: new (...args: any[]) => T): T | null; on(name: string, callback: () => void): unknown; }
  export interface Editor { getSelection(): string; replaceSelection(value: string): void; getCursor(): { line: number; ch: number }; getLine(line: number): string; getValue(): string; setCursor(pos: { line: number; ch: number }): void; replaceRange(value: string, from: { line: number; ch: number }, to: { line: number; ch: number }): void; }
  export class TextComponent { setValue(value: string): this; onChange(callback: (value: string) => void): this; inputEl: HTMLInputElement; }
}

interface HTMLElement { empty(): void; }
