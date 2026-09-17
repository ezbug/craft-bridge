#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
repo_dir="${script_dir:h:h}"
node_version="22.23.2"
node_archive="node-v${node_version}-darwin-arm64.tar.gz"
node_url="https://nodejs.org/download/release/v${node_version}/${node_archive}"
node_sha256="61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6"
release_dir="${CRAFT_BRIDGE_RELEASE_DIR:-$repo_dir/dist/release}"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$script_dir/Info.plist")"
app_zip_name="CraftBridge-v${version}-macos-arm64.zip"
plugin_zip_name="craft-obsidian-bridge-plugin-v${version}.zip"
stage_root="$(mktemp -d "${TMPDIR:-/tmp}/craft-bridge-release.XXXXXX")"

cleanup() {
  case "$stage_root" in
    "${TMPDIR:-/tmp}"/craft-bridge-release.*) rm -rf "$stage_root" ;;
    *) print -u2 "Refusing to remove unexpected staging path: $stage_root" ;;
  esac
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  print -u2 'Release packaging requires macOS running on Apple Silicon.'
  exit 1
fi

mkdir -p "$release_dir"
node_tarball="$stage_root/$node_archive"
node_sums="$stage_root/SHASUMS256.txt"
curl --fail --location --silent --show-error "$node_url" --output "$node_tarball"
curl --fail --location --silent --show-error \
  "https://nodejs.org/download/release/v${node_version}/SHASUMS256.txt" \
  --output "$node_sums"

published_node_sha256="$(awk -v name="$node_archive" '$2 == name { print $1 }' "$node_sums")"
if [[ "$published_node_sha256" != "$node_sha256" ]]; then
  print -u2 "Official Node checksum changed or could not be read for $node_archive"
  exit 1
fi
actual_node_sha256="$(shasum -a 256 "$node_tarball" | awk '{ print $1 }')"
if [[ "$actual_node_sha256" != "$node_sha256" ]]; then
  print -u2 "Node archive checksum mismatch for $node_archive"
  exit 1
fi

tar -xzf "$node_tarball" -C "$stage_root"
node_root="$stage_root/node-v${node_version}-darwin-arm64"
node_bin="$node_root/bin/node"
if [[ ! -x "$node_bin" || "$("$node_bin" --version)" != "v${node_version}" ]]; then
  print -u2 'Verified Node runtime did not unpack as expected.'
  exit 1
fi
export PATH="$node_root/bin:$PATH"

# Build in a private staging tree so packaging never changes source build output.
bridge_stage="$stage_root/bridge"
mkdir -p "$bridge_stage"
cp -R "$repo_dir/obsidian-bridge/src" "$bridge_stage/src"
cp "$repo_dir/obsidian-bridge/package.json" "$repo_dir/obsidian-bridge/package-lock.json" \
  "$repo_dir/obsidian-bridge/tsconfig.json" "$bridge_stage/"
(cd "$bridge_stage" && "$node_root/bin/npm" ci --no-audit --no-fund)
"$node_root/bin/npm" --prefix "$bridge_stage" run build

plugin_source="$stage_root/plugin-source"
mkdir -p "$plugin_source"
cp "$repo_dir/obsidian-plugin/main.ts" \
  "$repo_dir/obsidian-plugin/polling.ts" \
  "$repo_dir/obsidian-plugin/obsidian.d.ts" \
  "$repo_dir/obsidian-plugin/tsconfig.json" \
  "$repo_dir/obsidian-plugin/build.mjs" \
  "$repo_dir/obsidian-plugin/package.json" \
  "$plugin_source/"
ln -s "$bridge_stage/node_modules" "$plugin_source/node_modules"
"$node_root/bin/npm" --prefix "$plugin_source" run build

manifest_version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version ?? "")' "$repo_dir/obsidian-plugin/manifest.json")"
bridge_version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version ?? "")' "$repo_dir/obsidian-bridge/package.json")"
if [[ "$manifest_version" != "$version" || "$bridge_version" != "$version" ]]; then
  print -u2 "Release version mismatch: app=$version, bridge=$bridge_version, plugin=$manifest_version"
  exit 1
fi

"$node_root/bin/npm" --prefix "$bridge_stage" prune --omit=dev --no-audit --no-fund

app_bundle="$stage_root/CraftBridge.app"
contents="$app_bundle/Contents"
resources="$contents/Resources"
seed="$resources/bridge-runtime-seed"
mkdir -p "$contents/MacOS" "$seed/node/bin" \
  "$seed/THIRD_PARTY_NOTICES" \
  "$resources/ObsidianPlugin"

swift_scratch="$stage_root/swift-build"
swift build --package-path "$script_dir" --scratch-path "$swift_scratch" \
  --configuration release --arch arm64
swift_bin_dir="$(swift build --package-path "$script_dir" --scratch-path "$swift_scratch" \
  --configuration release --arch arm64 --show-bin-path)"
cp "$swift_bin_dir/CraftBridgeApp" "$contents/MacOS/CraftBridgeApp"
cp "$script_dir/Info.plist" "$contents/Info.plist"
chmod 755 "$contents/MacOS/CraftBridgeApp"
if [[ "$(lipo -archs "$contents/MacOS/CraftBridgeApp")" != "arm64" ]]; then
  print -u2 'The packaged Craft Bridge app executable is not Apple Silicon arm64.'
  exit 1
fi

cp "$node_bin" "$seed/node/bin/node"
cp "$node_root/LICENSE" "$seed/THIRD_PARTY_NOTICES/Node-LICENSE.txt"
cp -R "$bridge_stage/dist" "$seed/dist"
cp -R "$bridge_stage/node_modules" "$seed/node_modules"
cp "$bridge_stage/package.json" "$bridge_stage/package-lock.json" "$seed/"
if [[ "$("$seed/node/bin/node" --version)" != "v${node_version}" ]]; then
  print -u2 'The copied Node runtime cannot start from its bundled path.'
  exit 1
fi
if [[ "$(lipo -archs "$seed/node/bin/node")" != "arm64" ]]; then
  print -u2 'The bundled Node runtime is not Apple Silicon arm64.'
  exit 1
fi
"$seed/node/bin/node" --check "$seed/dist/src/daemon.js"
cp "$repo_dir/obsidian-plugin/manifest.json" "$resources/ObsidianPlugin/manifest.json"
cp "$plugin_source/dist/main.js" "$resources/ObsidianPlugin/main.js"
if [[ -f "$repo_dir/obsidian-plugin/styles.css" ]]; then
  cp "$repo_dir/obsidian-plugin/styles.css" "$resources/ObsidianPlugin/styles.css"
fi

"$node_root/bin/node" -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const files = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(absolute);
    else if (entry.isFile()) {
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      files.push({ path: relative, sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") });
    }
  }
}
visit(root);
files.sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(path.join(root, "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, files }, null, 2) + "\n");
' "$seed"

/usr/bin/codesign --force --deep --sign - "$app_bundle" >/dev/null
/usr/bin/codesign --verify --deep --strict "$app_bundle"

staged_app_zip="$stage_root/$app_zip_name"
staged_plugin_zip="$stage_root/$plugin_zip_name"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$staged_app_zip"
(
  cd "$plugin_source/dist"
  cp "$repo_dir/obsidian-plugin/manifest.json" manifest.json
  /usr/bin/zip -X -q -r "$staged_plugin_zip" .
)
(cd "$stage_root" && shasum -a 256 "$app_zip_name" "$plugin_zip_name" > SHA256SUMS)

mv -f "$staged_app_zip" "$release_dir/$app_zip_name"
mv -f "$staged_plugin_zip" "$release_dir/$plugin_zip_name"
mv -f "$stage_root/SHA256SUMS" "$release_dir/SHA256SUMS"
"$script_dir/Tests/verify-release-artifacts.sh" "$release_dir"

print "Release files written to: $release_dir"
