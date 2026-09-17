#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
repo_dir="${script_dir:h:h:h}"
release_dir="${1:-$repo_dir/dist/release}"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$repo_dir/macos/CraftBridgeApp/Info.plist")"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/craft-bridge-install.XXXXXX")"

cleanup() {
  case "$test_root" in
    "${TMPDIR:-/tmp}"/craft-bridge-install.*) /bin/rm -rf "$test_root" ;;
    *) print -u2 "Refusing to remove unexpected test path: $test_root" ;;
  esac
}
trap cleanup EXIT INT TERM

"$script_dir/verify-release-artifacts.sh" "$release_dir"
unzip -q "$release_dir/CraftBridge-v${version}-macos-arm64.zip" -d "$test_root"
plugin_dir="$test_root/plugin"
/bin/mkdir -p "$plugin_dir"
unzip -q "$release_dir/craft-obsidian-bridge-plugin-v${version}.zip" -d "$plugin_dir"

app_bundle="$test_root/CraftBridge.app"
seed="$app_bundle/Contents/Resources/bridge-runtime-seed"
node="$seed/node/bin/node"
[[ "$(lipo -archs "$app_bundle/Contents/MacOS/CraftBridgeApp")" == "arm64" ]]
[[ "$(lipo -archs "$node")" == "arm64" ]]
[[ "$($node --version)" == "v22.23.2" ]]
"$node" --check "$seed/dist/src/daemon.js"
(
  cd "$seed"
  "$node" -e 'const Database=require("better-sqlite3"); const db=new Database(":memory:"); db.exec("CREATE TABLE smoke (id INTEGER)"); db.close();'
)
[[ -f "$plugin_dir/manifest.json" && -f "$plugin_dir/main.js" ]]
plugin_version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$plugin_dir/manifest.json")"
app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_bundle/Contents/Info.plist")"
bridge_version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$seed/package.json")"
[[ "$plugin_version" == "$app_version" && "$bridge_version" == "$app_version" ]]
/usr/bin/codesign --verify --deep --strict "$app_bundle"

if [[ "${CRAFT_BRIDGE_TEST_TRACE:-0}" == "1" ]]; then
  zsh -x "$script_dir/first-launch-test.sh" "$app_bundle"
else
  zsh "$script_dir/first-launch-test.sh" "$app_bundle"
fi
print "install-release-test: PASS (Node, native SQLite, plugin, code signature, clean App onboarding and bundled daemon)"
