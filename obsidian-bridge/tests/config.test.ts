import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultStateDirectory, loadConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createSettingsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "craft-bridge-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("loadConfig", () => {
  it("uses portable platform-specific application state directories", () => {
    expect(defaultStateDirectory({}, "darwin", "/Users/example")).toBe(join("/Users/example", "Library", "Application Support", "craft-obsidian-bridge"));
    expect(defaultStateDirectory({ XDG_STATE_HOME: "/var/tmp/state" }, "linux", "/home/example")).toBe(join("/var/tmp/state", "craft-obsidian-bridge"));
  });

  it("loads the versioned non-secret user settings from Application Support config.json", async () => {
    const stateDir = await createSettingsDirectory();
    const vaultPath = join(stateDir, "Demo Vault");
    await writeFile(join(stateDir, "config.json"), JSON.stringify({
      schemaVersion: 1,
      vaultPath,
      vaultName: "Demo Vault",
      port: 48_210,
      launchAtLogin: true,
    }));

    const config = loadConfig({ OBSIDIAN_BRIDGE_STATE_DIR: stateDir });

    expect(config.vaultRoot).toBe(vaultPath);
    expect(config.vaultName).toBe("Demo Vault");
    expect(config.port).toBe(48_210);
    expect(config.launchAtLogin).toBe(true);
    expect(config.stateDir).toBe(stateDir);
  });

  it("fails with onboarding guidance when neither config.json nor an environment Vault is configured", async () => {
    const stateDir = await createSettingsDirectory();

    expect(() => loadConfig({ OBSIDIAN_BRIDGE_STATE_DIR: stateDir })).toThrow(/choose an Obsidian Vault|选择.*Vault/i);
  });

  it("lets advanced environment settings override user config values", async () => {
    const stateDir = await createSettingsDirectory();
    const configVault = join(stateDir, "Configured Vault");
    const envVault = join(stateDir, "Override Vault");
    await writeFile(join(stateDir, "config.json"), JSON.stringify({
      schemaVersion: 1,
      vaultPath: configVault,
      vaultName: "Configured Vault",
      port: 48_210,
      launchAtLogin: true,
    }));

    const config = loadConfig({
      OBSIDIAN_BRIDGE_STATE_DIR: stateDir,
      OBSIDIAN_VAULT: envVault,
      OBSIDIAN_VAULT_NAME: "Override Vault",
      CRAFT_BRIDGE_PORT: "49001",
      OBSIDIAN_BRIDGE_LAUNCH_AT_LOGIN: "false",
    });

    expect(config.vaultRoot).toBe(envVault);
    expect(config.vaultName).toBe("Override Vault");
    expect(config.port).toBe(49_001);
    expect(config.launchAtLogin).toBe(false);
  });

  it("rejects config files with an unknown schema version", async () => {
    const stateDir = await createSettingsDirectory();
    await writeFile(join(stateDir, "config.json"), JSON.stringify({
      schemaVersion: 2,
      vaultPath: join(stateDir, "Demo Vault"),
      vaultName: "Demo Vault",
      port: 47_832,
      launchAtLogin: false,
    }));

    expect(() => loadConfig({ OBSIDIAN_BRIDGE_STATE_DIR: stateDir })).toThrow(/unsupported.*schema|schemaVersion/i);
  });

  it("uses the app default port and disables launch-at-login for environment-only setup", async () => {
    const stateDir = await createSettingsDirectory();
    const vaultPath = join(stateDir, "Demo Vault");

    const config = loadConfig({ OBSIDIAN_BRIDGE_STATE_DIR: stateDir, OBSIDIAN_VAULT: vaultPath });

    expect(config.vaultRoot).toBe(vaultPath);
    expect(config.port).toBe(47_832);
    expect(config.launchAtLogin).toBe(false);
  });
});
