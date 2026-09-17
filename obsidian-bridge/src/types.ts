export interface BridgeUserSettings {
  schemaVersion: 1;
  vaultPath: string;
  vaultName: string;
  port: number;
  launchAtLogin: boolean;
}

export interface BridgeConfig extends Partial<Pick<BridgeUserSettings, "port" | "launchAtLogin">> {
  vaultRoot: string;
  vaultName: string;
  stateDir: string;
  dbPath: string;
  backupDir: string;
  lockPath: string;
  backupRetentionDays: number;
  maxReadChars: number;
}

export interface ParsedNote {
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  body: string;
  searchText: string;
  links: Array<{ rawTarget: string; display?: string; heading?: string; embed: boolean }>;
  hash: string;
  mtimeMs: number;
  size: number;
}

export interface NoteSearchResult {
  path: string;
  title: string;
  aliases: string[];
  tags: string[];
  snippet: string;
  matchedIn: string[];
  outboundLinkCount: number;
  backlinkCount: number;
  modifiedAt: string;
  uri: string;
}

export interface BacklinkResult {
  sourcePath: string;
  sourceTitle: string;
  targetPath?: string;
  targetTitle?: string;
  display?: string;
  rawTarget: string;
  embed: boolean;
  uri: string;
}

export type LinkChangeAction = "add" | "remove";

export interface LinkOperation {
  id: string;
  action: LinkChangeAction;
  notePath: string;
  craftTitle: string;
  craftUrl: string;
  bridgeId: string;
  expectedHash: string;
  beforeHash: string;
  afterHash?: string;
  backupPath?: string;
  status: "preview" | "applied" | "rolled_back" | "failed";
  patch: string;
  craftMarkdown: string;
  changed?: boolean;
  newContent?: string;
  createdAt: string;
}

export interface IndexStatus {
  vaultRoot: string;
  indexedFiles: number;
  indexedLinks: number;
  lastScanAt?: string;
  lastScanDurationMs?: number;
  lastError?: string;
  ftsMode: "trigram" | "substring";
  watcher: "active" | "unavailable";
}

export type CraftFont = "system" | "serif" | "rounded" | "mono";

export interface CraftDocumentSummary {
  id: string;
  title: string;
  url?: string;
  location?: string;
  folderId?: string;
  lastModifiedAt?: string;
  createdAt?: string;
  snippet?: string;
  matchedIn?: string[];
}

export interface CraftSearchResult extends CraftDocumentSummary {
  source: "cache" | "remote";
}

export interface CraftEditorContext {
  app: "Craft";
  documentId: string;
  documentTitle?: string;
  documentUrl?: string;
  focusedBlockId?: string;
  focusedBlockText?: string;
  precedingBlockText?: string;
  followingBlockText?: string;
  selection?: string;
  contextHash: string;
}

export interface CraftCardSpec {
  title: string;
  targetUrl: string;
  sourceLabel: string;
  sourcePath: string;
  summary?: string;
  bridgeId: string;
  font?: CraftFont;
  layout: "regular";
}

export interface CraftInsertPosition {
  pageId?: string;
  siblingId?: string;
  position: "start" | "end" | "before" | "after";
}

export interface CraftInsertedBlock {
  id: string;
  type?: string;
  textStyle?: string;
  cardLayout?: string;
  markdown?: string;
  content?: CraftInsertedBlock[];
  font?: CraftFont;
}

export interface CraftInsertResult {
  blocks: CraftInsertedBlock[];
  rootBlockId: string;
  insertedAt: CraftInsertPosition;
  verification: "pending" | "verified";
  created: boolean;
}

export interface LinkTransactionPreview {
  id: string;
  direction: "craft-to-obsidian" | "obsidian-to-craft";
  source: Record<string, unknown>;
  target: Record<string, unknown>;
  bridgeId: string;
  status: "preview";
}

export interface LinkTransactionResult {
  id: string;
  bridgeId: string;
  status: "applied" | "rolled_back" | "verification_pending" | "conflict" | "failed";
  craftBlockId?: string;
  obsidianOperationId?: string;
  message?: string;
}
