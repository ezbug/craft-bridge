import { build } from "esbuild";

await build({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "node",
  target: "es2020",
  outfile: "dist/main.js",
  sourcemap: false,
  logLevel: "info",
});
