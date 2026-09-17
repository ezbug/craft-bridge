#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
repo_dir="${script_dir:h:h}"
source_dir="${CRAFT_BRIDGE_RUNTIME_SOURCE:-$repo_dir/obsidian-bridge}"
runtime_root="${CRAFT_BRIDGE_RUNTIME_ROOT:-$HOME/Library/Application Support/craft-obsidian-bridge/runtime}"
node_modules_source="${CRAFT_BRIDGE_NODE_MODULES_SOURCE:-$source_dir/node_modules}"
node_path="${CRAFT_BRIDGE_NODE:-$(command -v node || true)}"

if [[ "${CRAFT_BRIDGE_SKIP_BUILD:-0}" != "1" ]]; then
  if [[ -z "$node_path" ]]; then
    print -u2 'Node.js is required for the development runtime installer. Add node to PATH or set CRAFT_BRIDGE_NODE.'
    exit 1
  fi
  npm --prefix "$source_dir" run build
fi

daemon_source="$source_dir/dist/src/daemon.js"
for required_path in "$daemon_source" "$source_dir/package.json" "$source_dir/package-lock.json" \
  "$node_modules_source/better-sqlite3"; do
  if [[ ! -e "$required_path" ]]; then
    print -u2 "Craft Bridge runtime source missing: $required_path"
    exit 1
  fi
done
if [[ -z "$node_path" || ! -x "$node_path" ]]; then
  print -u2 'Node.js executable not found. Add node to PATH or set CRAFT_BRIDGE_NODE.'
  exit 1
fi

runtime_fingerprint="$({
  find "$source_dir/dist" -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done
  shasum -a 256 "$source_dir/package.json" "$source_dir/package-lock.json" "$node_path"
} | shasum -a 256 | awk '{print $1}')"

releases_dir="$runtime_root/releases"
release_dir="$releases_dir/$runtime_fingerprint"
mkdir -p "$releases_dir"

if [[ ! -d "$release_dir" ]]; then
  release_stage="$releases_dir/.release-$runtime_fingerprint-$$"
  mkdir -p "$release_stage/node/bin"
  cp -R "$source_dir/dist" "$release_stage/dist"
  cp -R "$node_modules_source" "$release_stage/node_modules"
  cp "$source_dir/package.json" "$source_dir/package-lock.json" "$release_stage/"
  cp "$node_path" "$release_stage/node/bin/node"
  chmod 755 "$release_stage/node/bin/node"
  if ! "$release_stage/node/bin/node" --check "$release_stage/dist/src/daemon.js"; then
    rm -rf "$release_stage"
    print -u2 'The installed Node runtime rejected the Craft Bridge daemon.'
    exit 1
  fi
  if ! mv "$release_stage" "$release_dir" 2>/dev/null; then
    rm -rf "$release_stage"
    [[ -d "$release_dir" ]] || exit 1
  fi
fi

current_stage="$runtime_root/.current-$runtime_fingerprint-$$"
ln -s "releases/$runtime_fingerprint" "$current_stage"
mv -h -f "$current_stage" "$runtime_root/current"

print -r -- "$runtime_root/current"
