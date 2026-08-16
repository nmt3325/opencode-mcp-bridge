#!/usr/bin/env bash
# Smoke test against a REAL `opencode serve` instance (no mock).
# Usage: opencode serve --port 4096 --hostname 127.0.0.1 &
#        bash test/smoke-real.sh
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

OPENCODE_URL="${OPENCODE_BASE_URL:-http://127.0.0.1:4096}"
BRIDGE_PORT="${BRIDGE_PORT:-8801}"
HDR="$(mktemp)"
MCP_SESSION=""

if ! curl -sS -m 5 -o /dev/null "$OPENCODE_URL/session"; then
	echo "opencode is not reachable at $OPENCODE_URL - start it with: opencode serve --port 4096"
	exit 2
fi

OPENCODE_BASE_URL="$OPENCODE_URL" OPENCODE_MCP_PORT="$BRIDGE_PORT" node dist/index.js --http >/tmp/bridge-real.log 2>&1 &
BRIDGE_PID=$!
trap 'kill $BRIDGE_PID 2>/dev/null' EXIT
for _ in $(seq 1 30); do curl -sS -m 2 -o /dev/null "http://127.0.0.1:$BRIDGE_PORT/healthz" && break; sleep 0.5; done

post() {
	if [ -n "$MCP_SESSION" ]; then
		curl -sS -m 60 -D "$HDR" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
			-H 'mcp-protocol-version: 2025-06-18' -H "mcp-session-id: $MCP_SESSION" \
			-X POST "http://127.0.0.1:$BRIDGE_PORT/mcp" --data "$1"
	else
		curl -sS -m 60 -D "$HDR" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
			-X POST "http://127.0.0.1:$BRIDGE_PORT/mcp" --data "$1"
	fi
}
call() { post "$(jq -nc --arg n "$1" --argjson a "$2" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')" | { read -r line; echo "$line"; } ; }

post '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' >/dev/null
MCP_SESSION=$(grep -i '^mcp-session-id:' "$HDR" | tail -n1 | cut -d' ' -f2 | tr -d '\r')
post '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' >/dev/null
echo "session: $MCP_SESSION"

echo "--- opencode_health ---"
call opencode_health '{}' | jq -r '.result.content[0].text' | jq .
echo "--- opencode_shell ---"
call opencode_shell '{"command":"echo real-opencode-ok && uname -s","wait_seconds":15}' | jq -r '.result.content[0].text' | jq .
echo "--- opencode_read ---"
call opencode_read '{"path":"package.json","limit":3}' | jq -r '.result.content[0].text' | jq '.ok, .path'
