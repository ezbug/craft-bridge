#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
repo_dir="${script_dir:h:h:h}"
release_dir="${1:-$repo_dir/dist/release}"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$repo_dir/macos/CraftBridgeApp/Info.plist")"
app_zip="CraftBridge-v${version}-macos-arm64.zip"
plugin_zip="craft-obsidian-bridge-plugin-v${version}.zip"

for artifact in "$app_zip" "$plugin_zip" SHA256SUMS; do
  if [[ ! -f "$release_dir/$artifact" ]]; then
    print -u2 "Missing release artifact: $release_dir/$artifact"
    exit 1
  fi
done

checksum_lines="$(wc -l < "$release_dir/SHA256SUMS" | tr -d '[:space:]')"
if [[ "$checksum_lines" != "2" ]]; then
  print -u2 'SHA256SUMS must contain exactly the App ZIP and plugin ZIP.'
  exit 1
fi
(cd "$release_dir" && shasum -a 256 -c SHA256SUMS)

zip_has_entry() {
  unzip -Z1 "$1" | rg -Fx "$2" >/dev/null
}

for required in \
  'CraftBridge.app/Contents/Info.plist' \
  'CraftBridge.app/Contents/MacOS/CraftBridgeApp' \
  'CraftBridge.app/Contents/Resources/bridge-runtime-seed/node/bin/node' \
  'CraftBridge.app/Contents/Resources/bridge-runtime-seed/runtime-manifest.json' \
  'CraftBridge.app/Contents/Resources/bridge-runtime-seed/THIRD_PARTY_NOTICES/Node-LICENSE.txt' \
  'CraftBridge.app/Contents/Resources/bridge-runtime-seed/dist/src/daemon.js' \
  'CraftBridge.app/Contents/Resources/bridge-runtime-seed/package.json' \
  'CraftBridge.app/Contents/Resources/bridge-runtime-seed/node_modules/better-sqlite3/package.json' \
  'CraftBridge.app/Contents/Resources/ObsidianPlugin/manifest.json' \
  'CraftBridge.app/Contents/Resources/ObsidianPlugin/main.js'; do
  if ! zip_has_entry "$release_dir/$app_zip" "$required"; then
    print -u2 "App ZIP is missing required path: $required"
    exit 1
  fi
done

runtime_manifest="$(unzip -p "$release_dir/$app_zip" CraftBridge.app/Contents/Resources/bridge-runtime-seed/runtime-manifest.json)"
print -r -- "$runtime_manifest" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);if(m.schemaVersion!==1||!Array.isArray(m.files)||!m.files.length||m.files.some(f=>typeof f.path!=="string"||typeof f.sha256!=="string"))process.exit(1)})'

plugin_entries="$(unzip -Z1 "$release_dir/$plugin_zip")"
if print -r -- "$plugin_entries" | rg -e '(^|/)\._|^__MACOSX/' >/dev/null; then
  print -u2 'Plugin ZIP must not contain macOS resource-fork metadata.'
  exit 1
fi
plugin_manifest_path="$(print -r -- "$plugin_entries" | rg '(^|/)manifest\.json$' | head -n 1)"
plugin_main_path="$(print -r -- "$plugin_entries" | rg '(^|/)main\.js$' | head -n 1)"
if [[ -z "$plugin_manifest_path" || -z "$plugin_main_path" ]]; then
  print -u2 'Plugin ZIP must include manifest.json and main.js.'
  exit 1
fi

manifest_version="$(unzip -p "$release_dir/$plugin_zip" "$plugin_manifest_path" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version ?? ""))')"
app_manifest_version="$(unzip -p "$release_dir/$app_zip" CraftBridge.app/Contents/Resources/ObsidianPlugin/manifest.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version ?? ""))')"
bridge_version="$(unzip -p "$release_dir/$app_zip" CraftBridge.app/Contents/Resources/bridge-runtime-seed/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version ?? ""))')"
if [[ "$manifest_version" != "$version" || "$app_manifest_version" != "$version" || "$bridge_version" != "$version" ]]; then
  print -u2 "Version mismatch: app=$version, bridge=$bridge_version, plugin zip=$manifest_version, bundled plugin=$app_manifest_version"
  exit 1
fi

print "Release artifacts verified: $app_zip, $plugin_zip, SHA256SUMS"
