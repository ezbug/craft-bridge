#!/bin/zsh
set -euo pipefail

app_bundle="${1:?Usage: zsh first-launch-test.sh /path/to/CraftBridge.app}"
app_executable="$app_bundle/Contents/MacOS/CraftBridgeApp"
if [[ ! -x "$app_executable" ]]; then
  print -u2 "App executable is missing: $app_executable"
  exit 1
fi

test_root="$(mktemp -d "${TMPDIR:-/tmp}/craft-bridge-first-launch.XXXXXX")"
support="$test_root/Application Support"
log="$support/craft-obsidian-bridge/CraftBridgeApp.log"
configuration="$support/craft-obsidian-bridge/config.json"
app_pid=""
daemon_pid=""

cleanup() {
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
    kill -TERM "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  if [[ -n "$daemon_pid" ]] && kill -0 "$daemon_pid" 2>/dev/null; then
    kill -TERM "$daemon_pid" 2>/dev/null || true
  fi
  case "$test_root" in
    "${TMPDIR:-/tmp}"/craft-bridge-first-launch.*) /bin/rm -rf "$test_root" ;;
    *) print -u2 "Refusing to remove unexpected test path: $test_root" ;;
  esac
}
trap cleanup EXIT INT TERM

start_app() {
  CRAFT_BRIDGE_APPLICATION_SUPPORT="$support" CRAFT_BRIDGE_DISABLE_CRAFT_API=1 "$app_executable" >/dev/null 2>&1 &
  app_pid=$!
}

wait_for_log() {
  for attempt in {1..80}; do
    if [[ -f "$log" ]] && grep -q 'launch pid=' "$log"; then return 0; fi
    if ! kill -0 "$app_pid" 2>/dev/null; then
      print -u2 'Craft Bridge exited before its first-launch diagnostics were written.'
      return 1
    fi
    sleep 0.25
  done
  print -u2 'Craft Bridge did not complete first-launch startup in 20 seconds.'
  return 1
}

stop_app() {
  [[ -n "$app_pid" ]] || return 0
  if kill -0 "$app_pid" 2>/dev/null; then kill -TERM "$app_pid"; fi
  wait "$app_pid" 2>/dev/null || true
  app_pid=""
  for attempt in {1..40}; do
    if [[ -z "$daemon_pid" ]] || ! kill -0 "$daemon_pid" 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  print -u2 'Craft Bridge did not stop its owned daemon after exit.'
  return 1
}

start_app
wait_for_log
if [[ -e "$configuration" ]]; then
  print -u2 'A fresh first launch unexpectedly created or consumed user configuration.'
  exit 1
fi
stop_app

vault="$test_root/Demo Vault"
/bin/mkdir -p "$vault/.obsidian"
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
python3 - "$configuration" "$vault" "$port" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps({
    "schemaVersion": 1,
    "vaultPath": sys.argv[2],
    "vaultName": "Demo Vault",
    "port": int(sys.argv[3]),
    "launchAtLogin": False,
}, indent=2) + "\n")
path.chmod(0o600)
PY

start_app
wait_for_log
for attempt in {1..120}; do
  daemon_pid="$(sed -n 's/.*daemon started pid=\([0-9][0-9]*\).*/\1/p' "$log" | tail -n 1)"
  if [[ -n "$daemon_pid" ]] && curl --silent --fail "http://127.0.0.1:$port/health" >/dev/null; then break; fi
  sleep 0.25
done
if [[ -z "$daemon_pid" ]] || ! curl --silent --fail "http://127.0.0.1:$port/health" >/dev/null; then
  print -u2 'Bundled Bridge runtime did not start its loopback RPC service.'
  exit 1
fi

runtime="$support/craft-obsidian-bridge/runtime"
[[ -L "$runtime/current" ]]
[[ -x "$runtime/current/node/bin/node" ]]
[[ -f "$runtime/current/dist/src/daemon.js" ]]
[[ -f "$support/craft-obsidian-bridge/bridge.token" ]]
[[ -f "$support/craft-obsidian-bridge/index.sqlite" ]]
"$runtime/current/node/bin/node" --version | grep -q '^v22\.23\.2$'
stop_app

print 'first-launch-test: PASS (clean onboarding, isolated Vault, bundled Node, RPC health, daemon shutdown)'
