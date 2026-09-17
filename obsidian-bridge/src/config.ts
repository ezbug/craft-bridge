import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import type { BridgeConfig, BridgeUserSettings } from "./types.js";

export const DEFAULT_BRIDGE_PORT = 47_832;
const SETTINGS_SCHEMA_VERSION = 1;
const APPLICATION_DIRECTORY = "craft-obsidian-bridge";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const stateDir = resolve(env.OBSIDIAN_BRIDGE_STATE_DIR ?? defaultStateDirectory(env));
  const settingsPath = resolve(env.OBSIDIAN_BRIDGE_CONFIG ?? join(stateDir, "config.json"));
  const settings = readUserSettings(settingsPath);
  const configuredVault = env.OBSIDIAN_VAULT?.trim() || settings?.vaultPath;
  if (!configuredVault) {
    throw new Error(`尚未配置 Obsidian Vault。首次运行请在 Craft Bridge App 中选择 Vault，或设置 OBSIDIAN_VAULT。配置文件：${settingsPath}`);
  }
  const vaultRoot = resolve(configuredVault);
  const vaultName = env.OBSIDIAN_VAULT_NAME?.trim() || settings?.vaultName || basename(vaultRoot);
  const port = parsePort(env.CRAFT_BRIDGE_PORT ?? settings?.port ?? DEFAULT_BRIDGE_PORT);
  const launchAtLogin = env.OBSIDIAN_BRIDGE_LAUNCH_AT_LOGIN === undefined
    ? settings?.launchAtLogin ?? false
    : parseBoolean(env.OBSIDIAN_BRIDGE_LAUNCH_AT_LOGIN, "OBSIDIAN_BRIDGE_LAUNCH_AT_LOGIN");
  const backupRetentionDays = Number(env.OBSIDIAN_BRIDGE_BACKUP_RETENTION_DAYS ?? 30);
  if (!Number.isInteger(backupRetentionDays) || backupRetentionDays < 1 || backupRetentionDays > 3650) {
    throw new Error("OBSIDIAN_BRIDGE_BACKUP_RETENTION_DAYS 必须是 1 到 3650 的整数");
  }
  return {
    vaultRoot,
    vaultName,
    port,
    launchAtLogin,
    stateDir,
    dbPath: resolve(env.OBSIDIAN_BRIDGE_DB ?? `${stateDir}/index.sqlite`),
    backupDir: resolve(env.OBSIDIAN_BRIDGE_BACKUPS ?? `${stateDir}/backups`),
    lockPath: resolve(env.OBSIDIAN_BRIDGE_LOCK ?? `${stateDir}/vault.lock`),
    backupRetentionDays,
    maxReadChars: Number(env.OBSIDIAN_BRIDGE_MAX_READ_CHARS ?? 20_000),
  };
}

export function defaultStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  if (platform === "darwin") return join(homeDirectory, "Library", "Application Support", APPLICATION_DIRECTORY);
  if (platform === "win32") return join(env.LOCALAPPDATA || join(homeDirectory, "AppData", "Local"), APPLICATION_DIRECTORY);
  return join(env.XDG_STATE_HOME || join(homeDirectory, ".local", "state"), APPLICATION_DIRECTORY);
}

function readUserSettings(path: string): BridgeUserSettings | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`无法读取 Craft Bridge 配置文件 ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`Craft Bridge 配置文件不是有效 JSON：${path}`);
  }
  if (!isRecord(value)) throw new Error(`Craft Bridge 配置文件必须是 JSON 对象：${path}`);
  if (value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new Error(`不支持的 Craft Bridge 配置 schemaVersion：${String(value.schemaVersion)}（当前支持 ${SETTINGS_SCHEMA_VERSION}）`);
  }
  if (typeof value.vaultPath !== "string" || !value.vaultPath.trim() || !isAbsolute(value.vaultPath)) {
    throw new Error("Craft Bridge 配置 vaultPath 必须是非空绝对路径");
  }
  if (typeof value.vaultName !== "string" || !value.vaultName.trim()) {
    throw new Error("Craft Bridge 配置 vaultName 必须是非空字符串");
  }
  if (typeof value.port !== "number") throw new Error("Craft Bridge 配置 port 必须是整数");
  const port = parsePort(value.port);
  if (typeof value.launchAtLogin !== "boolean") throw new Error("Craft Bridge 配置 launchAtLogin 必须是布尔值");
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    vaultPath: value.vaultPath,
    vaultName: value.vaultName.trim(),
    port,
    launchAtLogin: value.launchAtLogin,
  };
}

function parsePort(value: string | number): number {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("CRAFT_BRIDGE_PORT 必须是 1024-65535 的整数");
  return port;
}

function parseBoolean(value: string, name: string): boolean {
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

export function assertRelativeNotePath(value: string): string {
  const path = value.replaceAll("\\", "/").trim();
  if (!path || isAbsolute(path) || normalize(path).startsWith("..") || path.includes("\0")) {
    throw new Error("笔记路径必须是 Vault 内的相对路径");
  }
  if (!path.toLowerCase().endsWith(".md")) throw new Error("只允许访问 Markdown 笔记");
  return normalize(path).replaceAll("\\", "/");
}

export function noteUri(vaultName: string, relativePath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativePath)}`;
}
