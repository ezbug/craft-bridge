import { describe, expect, it } from "vitest";
import { corsHeaders } from "../src/http.js";

describe("local RPC CORS policy", () => {
  it("allows the Obsidian app origin", () => {
    expect(corsHeaders("app://obsidian.md")).toMatchObject({
      "Access-Control-Allow-Origin": "app://obsidian.md",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
  });

  it("does not reflect an untrusted origin", () => {
    expect(corsHeaders("https://attacker.example")).not.toHaveProperty("Access-Control-Allow-Origin");
  });
});
