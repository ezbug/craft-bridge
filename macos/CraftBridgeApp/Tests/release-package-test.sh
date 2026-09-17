#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
repo_dir="${script_dir:h:h:h}"
verifier="$script_dir/verify-release-artifacts.sh"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/craft-bridge-release-test.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$repo_dir/macos/CraftBridgeApp/Info.plist")"
release_dir="$temp_dir/release"
mkdir -p "$release_dir/stage/CraftBridge.app/Contents/MacOS" \
  "$release_dir/stage/CraftBridge.app/Contents/Resources/bridge-runtime-seed/node/bin" \
  "$release_dir/stage/CraftBridge.app/Contents/Resources/bridge-runtime-seed/THIRD_PARTY_NOTICES" \
  "$release_dir/stage/CraftBridge.app/Contents/Resources/bridge-runtime-seed/dist/src" \
  "$release_dir/stage/CraftBridge.app/Contents/Resources/bridge-runtime-seed/node_modules/better-sqlite3" \
  "$release_dir/stage/CraftBridge.app/Contents/Resources/ObsidianPlugin" \
  "$release_dir/stage/plugin"

cp "$repo_dir/macos/CraftBridgeApp/Info.plist" "$release_dir/stage/CraftBridge.app/Contents/Info.plist"
printf 'app binary fixture\n' > "$release_dir/stage/CraftBridge.app/Contents/MacOS/CraftBridgeApp"
printf 'node runtime fixture\n' > "$release_dir/stage/CraftBridge.app/Contents/Resources/bridge-runtime-seed/node/bin/node"
printf 'Node license fixture\n' > "$release_dir/stage/CraftBridge.app/Contents/Resources/bridge-runtime-seed/THIRD_PARTY_NOTICES/Node-LICENSE.txt"
printf 'daemon fixture\n' > "$release_dir/stage/CraftBridge.app/Contents/Resources/bridge-runtime-seed/dist/src/daemon.js"
printf '{"name":"obsidian-craft-bridge","version":"%s"}\n' "$version" > "$release_dir/stage/CraftBridge.app/Contents/Resources/bridge-runtime-seed/package.json"
printf '{"name":"better-sqlite3"}\n' > "$release_dir/stage/CraftBridge.app/Contents/Resources/bridge-runtime-seed/node_modules/better-sqlite3/package.json"
printf '{"id":"craft-obsidian-bridge","version":"%s"}\n' "$version" > "$release_dir/stage/plugin/manifest.json"
printf 'plugin bundle fixture\n' > "$release_dir/stage/plugin/main.js"
cp "$release_dir/stage/plugin/manifest.json" "$release_dir/stage/CraftBridge.app/Contents/Resources/ObsidianPlugin/manifest.json"
cp "$release_dir/stage/plugin/main.js" "$release_dir/stage/CraftBridge.app/Contents/Resources/ObsidianPlugin/main.js"
node -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const files = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(absolute);
    else if (entry.isFile()) files.push({ path: path.relative(root, absolute).split(path.sep).join("/"), sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") });
  }
}
visit(root);
files.sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(path.join(root, "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, files }, null, 2) + "\n");
' "$release_dir/stage/CraftBridge.app/Contents/Resources/bridge-runtime-seed"

(cd "$release_dir/stage" && /usr/bin/ditto -c -k --sequesterRsrc --keepParent CraftBridge.app "$release_dir/CraftBridge-v${version}-macos-arm64.zip")
(cd "$release_dir/stage/plugin" && /usr/bin/zip -X -q -r "$release_dir/craft-obsidian-bridge-plugin-v${version}.zip" .)
(cd "$release_dir" && shasum -a 256 CraftBridge-v"${version}"-macos-arm64.zip craft-obsidian-bridge-plugin-v"${version}".zip > SHA256SUMS)

"$verifier" "$release_dir"

printf 'tampered fixture\n' >> "$release_dir/CraftBridge-v${version}-macos-arm64.zip"
if "$verifier" "$release_dir" >/dev/null 2>&1; then
  print -u2 'release verifier accepted an artifact with a bad checksum'
  exit 1
fi

print 'release-package-test: PASS'
