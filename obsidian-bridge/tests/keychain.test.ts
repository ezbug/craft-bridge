import { describe, expect, it } from "vitest";
import { readCraftSpaceApiUrl } from "../src/keychain.js";

describe("Craft API credential source", () => {
  it("allows an isolated first-launch smoke test to avoid the user's Keychain", async () => {
    await expect(readCraftSpaceApiUrl({
      CRAFT_BRIDGE_DISABLE_CRAFT_API: "1",
      CRAFT_SPACE_API_URL: "https://connect.craft.do/link/demo/api/v1",
    } as NodeJS.ProcessEnv)).resolves.toBeUndefined();
  });

  it("prefers an explicit development override without invoking Keychain", async () => {
    const apiConnection = "https://connect.craft.do/link/demo/api/v1";
    await expect(readCraftSpaceApiUrl({ CRAFT_SPACE_API_URL: apiConnection } as NodeJS.ProcessEnv)).resolves.toBe(apiConnection);
  });
});
