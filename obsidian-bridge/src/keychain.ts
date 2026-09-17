import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readKeychainSecret(service: string, account: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { timeout: 5_000, maxBuffer: 64 * 1024 });
    return result.stdout.trim() || undefined;
  } catch { return undefined; }
}

export async function writeKeychainSecret(service: string, account: string, value: string): Promise<void> {
  if (!value.trim()) throw new Error("Keychain value 不能为空");
  await execFileAsync("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value], { timeout: 5_000, maxBuffer: 64 * 1024 });
}

export async function readCraftSpaceApiUrl(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.CRAFT_BRIDGE_DISABLE_CRAFT_API === "1") return undefined;
  return env.CRAFT_SPACE_API_URL?.trim() || readKeychainSecret("craft-obsidian-bridge", "full-space");
}
