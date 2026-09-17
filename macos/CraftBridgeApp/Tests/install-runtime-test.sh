#!/bin/zsh
set -euo pipefail

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

source_dir="$test_dir/source"
runtime_root="$test_dir/Application Support/craft-obsidian-bridge/runtime"
app_bundle="$test_dir/CraftBridge.app"
node_path="$(command -v node)"
mkdir -p "$source_dir/dist/src" "$source_dir/node_modules/example" \
  "$source_dir/node_modules/better-sqlite3" "$app_bundle/Contents/MacOS"
printf '%s\n' "console.log('version-one')" > "$source_dir/dist/src/daemon.js"
printf '%s\n' '{"name":"fixture","type":"module"}' > "$source_dir/package.json"
printf '%s\n' '{"lockfileVersion":3}' > "$source_dir/package-lock.json"
printf '%s\n' 'dependency' > "$source_dir/node_modules/example/marker.txt"
printf '%s\n' 'native dependency fixture' > "$source_dir/node_modules/better-sqlite3/marker.txt"
printf '%s\n' 'fixed-shell' > "$app_bundle/Contents/MacOS/CraftBridgeApp"

shell_hash_before="$(shasum -a 256 "$app_bundle/Contents/MacOS/CraftBridgeApp" | awk '{print $1}')"

CRAFT_BRIDGE_RUNTIME_SOURCE="$source_dir" \
CRAFT_BRIDGE_RUNTIME_ROOT="$runtime_root" \
CRAFT_BRIDGE_NODE_MODULES_SOURCE="$source_dir/node_modules" \
CRAFT_BRIDGE_NODE="$node_path" \
CRAFT_BRIDGE_SKIP_BUILD=1 \
"${0:A:h}/../install-runtime.sh"

test -L "$runtime_root/current"
test -x "$runtime_root/current/node/bin/node"
cmp -s "$node_path" "$runtime_root/current/node/bin/node"
grep -q 'version-one' "$runtime_root/current/dist/src/daemon.js"
test -f "$runtime_root/current/node_modules/example/marker.txt"
test -f "$runtime_root/current/node_modules/better-sqlite3/marker.txt"
first_release="$(readlink "$runtime_root/current")"

printf '%s\n' "console.log('version-two')" > "$source_dir/dist/src/daemon.js"
CRAFT_BRIDGE_RUNTIME_SOURCE="$source_dir" \
CRAFT_BRIDGE_RUNTIME_ROOT="$runtime_root" \
CRAFT_BRIDGE_NODE_MODULES_SOURCE="$source_dir/node_modules" \
CRAFT_BRIDGE_NODE="$node_path" \
CRAFT_BRIDGE_SKIP_BUILD=1 \
"${0:A:h}/../install-runtime.sh"

second_release="$(readlink "$runtime_root/current")"
test "$first_release" != "$second_release"
cmp -s "$node_path" "$runtime_root/current/node/bin/node"
grep -q 'version-two' "$runtime_root/current/dist/src/daemon.js"
test -f "$runtime_root/$first_release/dist/src/daemon.js"

shell_hash_after="$(shasum -a 256 "$app_bundle/Contents/MacOS/CraftBridgeApp" | awk '{print $1}')"
test "$shell_hash_before" = "$shell_hash_after"
test ! -e "$app_bundle/Contents/Resources/bridge-runtime"

printf '%s\n' 'install-runtime-test: PASS'
