#!/usr/bin/env bash
# End to end test: drives the MCP server over plain HTTP with curl, against a
# mock opencode server (v2 API first, then the legacy API to exercise the
# fallback paths).
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

RUN_DIR="$ROOT_DIR/.run"
mkdir -p "$RUN_DIR"
HDR="$RUN_DIR/headers.txt"

MOCK_PORT="${MOCK_PORT:-4599}"
BRIDGE_PORT="${BRIDGE_PORT:-8799}"
LEGACY_MOCK_PORT="${LEGACY_MOCK_PORT:-4600}"
LEGACY_BRIDGE_PORT="${LEGACY_BRIDGE_PORT:-8800}"

PASS=0
FAIL=0
MCP_SESSION=""
BASE=""
INIT_RESPONSE=""
RPC_ID=0

pass() {
	PASS=$((PASS + 1))
	echo "  ok   $1"
}

failure() {
	FAIL=$((FAIL + 1))
	echo "  FAIL $1"
	echo "       payload: $(echo "$2" | head -c 700)"
}

check() { # name, jq filter, payload
	if echo "$3" | jq -e "$2" >/dev/null 2>&1; then pass "$1"; else failure "$1" "$3"; fi
}

normalize() { # accepts raw JSON or an SSE stream on stdin, prints one JSON doc
	local raw
	raw="$(cat)"
	case "$raw" in
		"{"*) printf '%s' "$raw" ;;
		*) printf '%s' "$raw" | sed -n 's/^data: //p' | tail -n 1 ;;
	esac
}

mcp_post() {
	if [ -n "$MCP_SESSION" ]; then
		curl -sS -D "$HDR" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
			-H 'mcp-protocol-version: 2025-06-18' -H "mcp-session-id: $MCP_SESSION" \
			-X POST "$BASE/mcp" --data "$1"
	else
		curl -sS -D "$HDR" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
			-X POST "$BASE/mcp" --data "$1"
	fi
}

rpc() { # method, params -> full JSON-RPC response
	RPC_ID=$((RPC_ID + 1))
	local body
	body=$(jq -nc --arg m "$1" --argjson p "$2" --argjson i "$RPC_ID" '{jsonrpc:"2.0",id:$i,method:$m,params:$p}')
	mcp_post "$body" | normalize
}

notify() {
	local body
	body=$(jq -nc --arg m "$1" '{jsonrpc:"2.0",method:$m,params:{}}')
	mcp_post "$body" >/dev/null
}

call_tool() { # name, arguments -> full JSON-RPC response
	rpc "tools/call" "$(jq -nc --arg n "$1" --argjson a "$2" '{name:$n,arguments:$a}')"
}

payload() { # full response on stdin -> the tool's JSON payload
	jq -r '.result.content[0].text // empty'
}

wait_http() {
	for _ in $(seq 1 40); do
		if curl -sS -o /dev/null "$1" 2>/dev/null; then return 0; fi
		sleep 0.5
	done
	return 1
}

start_stack() { # mock_port bridge_port [--legacy]
	local mock_port="$1" bridge_port="$2" extra="${3:-}"
	node test/mock-opencode.mjs --port "$mock_port" --root "$ROOT_DIR" $extra >"$RUN_DIR/mock-$mock_port.log" 2>&1 &
	echo $! >"$RUN_DIR/mock-$mock_port.pid"
	OPENCODE_BASE_URL="http://127.0.0.1:$mock_port" \
		OPENCODE_MCP_PORT="$bridge_port" \
		OPENCODE_MCP_WAIT_GRACE_MS=400 \
		OPENCODE_MCP_POLL_INTERVAL_MS=300 \
		node dist/index.js --http >"$RUN_DIR/bridge-$bridge_port.log" 2>&1 &
	echo $! >"$RUN_DIR/bridge-$bridge_port.pid"
	wait_http "http://127.0.0.1:$mock_port/doc" || echo "mock did not start"
	wait_http "http://127.0.0.1:$bridge_port/healthz" || echo "bridge did not start"
}

stop_all() {
	for pidfile in "$RUN_DIR"/*.pid; do
		[ -f "$pidfile" ] || continue
		kill "$(cat "$pidfile")" 2>/dev/null
		rm -f "$pidfile"
	done
}
trap stop_all EXIT

# NOTE: must not be called in a command substitution, it sets globals.
handshake() { # base_url -> sets BASE, MCP_SESSION, INIT_RESPONSE
	BASE="$1"
	MCP_SESSION=""
	rpc "initialize" '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-e2e","version":"0"}}' >"$RUN_DIR/init.json"
	MCP_SESSION=$(grep -i '^mcp-session-id:' "$HDR" | tail -n 1 | cut -d' ' -f2 | tr -d '\r')
	notify "notifications/initialized"
	INIT_RESPONSE=$(cat "$RUN_DIR/init.json")
}

numeric() { # value -> echoes the value when it is an integer, otherwise 0
	case "${1:-}" in
		"" | *[!0-9]*) echo 0 ;;
		*) echo "$1" ;;
	esac
}

echo "=== stack 1: opencode v2 API ==="
start_stack "$MOCK_PORT" "$BRIDGE_PORT"
handshake "http://127.0.0.1:$BRIDGE_PORT"
INIT="$INIT_RESPONSE"
check "initialize returns serverInfo" '.result.serverInfo.name == "opencode-mcp-bridge"' "$INIT"
[ -n "$MCP_SESSION" ] && pass "session id issued ($MCP_SESSION)" || failure "session id issued" "$(cat "$HDR")"

TOOLS=$(rpc "tools/list" '{}')
check "tools/list exposes >=18 tools" '.result.tools | length >= 18' "$TOOLS"
check "tools/list contains opencode_shell" '[.result.tools[].name] | index("opencode_shell") != null' "$TOOLS"
check "tools/list contains opencode_permission_reply" '[.result.tools[].name] | index("opencode_permission_reply") != null' "$TOOLS"

HEALTH=$(call_tool opencode_health '{}' | payload)
check "health: reachable" '.capabilities.reachable == true' "$HEALTH"
check "health: detects v2 shell API" '.capabilities.shellApi == "v2"' "$HEALTH"

echo "--- shell ---"
SH=$(call_tool opencode_shell '{"command":"echo hello-from-bridge","wait_seconds":6}' | payload)
check "shell: fast command completes inline" '.status == "completed" and .exit_code == 0' "$SH"
check "shell: stdout captured" '.output | test("hello-from-bridge")' "$SH"

LONG=$(call_tool opencode_shell '{"command":"for i in 1 2 3 4 5; do echo line-$i; sleep 1; done","wait_seconds":2}' | payload)
check "shell: long command returns while still running" '.status == "running"' "$LONG"
SHELL_ID=$(echo "$LONG" | jq -r '.shell_id')
CURSOR=$(numeric "$(echo "$LONG" | jq -r '.cursor // 0')")
OUT=$(call_tool opencode_shell_output "$(jq -nc --arg id "$SHELL_ID" --argjson c "$CURSOR" '{shell_id:$id,cursor:$c,wait_seconds:10}')" | payload)
TOTAL="$(echo "$LONG" | jq -r '.output')$(echo "$OUT" | jq -r '.output')"
for _ in 1 2 3 4 5 6; do
	STATUS=$(echo "$OUT" | jq -r '.status')
	[ "$STATUS" != "running" ] && break
	CURSOR=$(numeric "$(echo "$OUT" | jq -r '.cursor // 0')")
	OUT=$(call_tool opencode_shell_output "$(jq -nc --arg id "$SHELL_ID" --argjson c "$CURSOR" '{shell_id:$id,cursor:$c,wait_seconds:5}')" | payload)
	TOTAL="$TOTAL$(echo "$OUT" | jq -r '.output')"
done
check "shell: incremental polling reaches completion" '.status == "completed" and .exit_code == 0' "$OUT"
case "$TOTAL" in *line-5*) pass "shell: cursor paging returned every line" ;; *) failure "shell: cursor paging returned every line" "$TOTAL" ;; esac

KILLME=$(call_tool opencode_shell '{"command":"sleep 45","timeout_seconds":5,"wait_seconds":0}' | payload)
KILL_ID=$(echo "$KILLME" | jq -r '.shell_id')
check "shell: wait_seconds=0 returns instantly" '.status == "running"' "$KILLME"
EXT=$(call_tool opencode_shell_extend "$(jq -nc --arg id "$KILL_ID" '{shell_id:$id,timeout_seconds:600}')" | payload)
check "shell: timeout extended" '.result.timeout == 600' "$EXT"
STAT=$(call_tool opencode_shell_status "$(jq -nc --arg id "$KILL_ID" '{shell_id:$id}')" | payload)
check "shell: status reports running" '.shell.status == "running"' "$STAT"
KILLED=$(call_tool opencode_shell_kill "$(jq -nc --arg id "$KILL_ID" '{shell_id:$id}')" | payload)
check "shell: kill works" '.result.status == "killed"' "$KILLED"
LIST=$(call_tool opencode_shell_list '{}' | payload)
check "shell: list returns jobs" '.shells | length >= 3' "$LIST"

GUARD=$(call_tool opencode_shell '{"command":"rm -rf /"}')
check "guard: destructive command is refused" '.result.isError == true' "$GUARD"
check "guard: reason mentions the deny list" '(.result.content[0].text | fromjson | .error) | test("guard")' "$GUARD"

echo "--- agent sessions ---"
START=$(call_tool opencode_start '{"prompt":"delay=2000 summarise the repo"}' | payload)
check "start: returns immediately with a session" '.ok == true and (.session_id | length > 0)' "$START"
check "start: used prompt_async" '.dispatch == "async"' "$START"
SID=$(echo "$START" | jq -r '.session_id')
WAIT=$(call_tool opencode_wait "$(jq -nc --arg s "$SID" '{session_id:$s,timeout_seconds:20}')" | payload)
check "wait: reports finished" '.finished == true and .status == "idle"' "$WAIT"
check "wait: returns the assistant answer" '[.messages[].text] | join(" ") | test("done: delay=2000")' "$WAIT"
RESULT=$(call_tool opencode_result "$(jq -nc --arg s "$SID" '{session_id:$s}')" | payload)
check "result: paginates the transcript" '.total_messages >= 2 and (.messages | length >= 2)' "$RESULT"

echo "--- permission approval flow ---"
PSTART=$(call_tool opencode_start '{"prompt":"ask-permission and push the branch"}' | payload)
PSID=$(echo "$PSTART" | jq -r '.session_id')
PWAIT=$(call_tool opencode_wait "$(jq -nc --arg s "$PSID" '{session_id:$s,timeout_seconds:4}')" | payload)
check "permission: wait reports the block instead of hanging" '.finished == false and (.pending_permissions | length > 0)' "$PWAIT"
PENDING=$(call_tool opencode_permissions_pending '{}' | payload)
check "permission: pending list is populated" '.count >= 1' "$PENDING"
PID_=$(echo "$PENDING" | jq -r '.permissions[0].id')
REPLY=$(call_tool opencode_permission_reply "$(jq -nc --arg id "$PID_" '{request_id:$id,reply:"once"}')" | payload)
check "permission: reply accepted" '.ok == true' "$REPLY"
PWAIT2=$(call_tool opencode_wait "$(jq -nc --arg s "$PSID" '{session_id:$s,timeout_seconds:10}')" | payload)
check "permission: session resumes after approval" '.finished == true and ([.messages[].text] | join(" ") | test("permission once"))' "$PWAIT2"

echo "--- files, search, vcs ---"
READ=$(call_tool opencode_read '{"path":"package.json","limit":5}' | payload)
check "read: returns file content" '.content | test("opencode-mcp-bridge")' "$READ"
GREP=$(call_tool opencode_grep '{"pattern":"opencode_shell_output","limit":5}' | payload)
check "grep: finds matches" '.matches | length > 0' "$GREP"
FIND=$(call_tool opencode_find_file '{"query":"mock-opencode"}' | payload)
check "find_file: finds the mock" '.files | length > 0' "$FIND"
DIFF=$(call_tool opencode_diff '{}' | payload)
check "diff: returns something" '.ok == true' "$DIFF"
SESS=$(call_tool opencode_sessions '{}' | payload)
check "sessions: lists created sessions" '.sessions | length >= 2' "$SESS"
ABORT=$(call_tool opencode_abort "$(jq -nc --arg s "$SID" '{session_id:$s}')" | payload)
check "abort: succeeds" '.ok == true' "$ABORT"

echo "--- protocol level checks ---"
UNKNOWN=$(call_tool opencode_does_not_exist '{}')
check "unknown tool is rejected" '(.error != null) or (.result.isError == true)' "$UNKNOWN"
NOSESSION=$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
	-X POST "http://127.0.0.1:$BRIDGE_PORT/mcp" --data '{"jsonrpc":"2.0","id":99,"method":"tools/list","params":{}}')
[ "$NOSESSION" = "400" ] && pass "request without a session is rejected (400)" || failure "request without a session is rejected" "$NOSESSION"
HEALTHZ=$(curl -sS "http://127.0.0.1:$BRIDGE_PORT/healthz")
check "healthz endpoint" '.ok == true and .server == "opencode-mcp-bridge"' "$HEALTHZ"

echo
echo "=== stack 2: legacy opencode API (no /api/shell, no prompt_async) ==="
start_stack "$LEGACY_MOCK_PORT" "$LEGACY_BRIDGE_PORT" "--legacy"
handshake "http://127.0.0.1:$LEGACY_BRIDGE_PORT"
INIT2="$INIT_RESPONSE"
check "legacy: handshake" '.result.serverInfo.name == "opencode-mcp-bridge"' "$INIT2"
LHEALTH=$(call_tool opencode_health '{}' | payload)
check "legacy: falls back to the legacy shell API" '.capabilities.shellApi == "legacy"' "$LHEALTH"
LSH=$(call_tool opencode_shell '{"command":"echo hello-legacy","wait_seconds":8}' | payload)
check "legacy: shell runs through a bridge managed job" '.api == "legacy" and (.shell_id | test("^local-"))' "$LSH"
check "legacy: shell output captured" '.output | test("hello-legacy")' "$LSH"
LSTART=$(call_tool opencode_start '{"prompt":"delay=1500 legacy path"}' | payload)
check "legacy: start falls back to background dispatch" '.dispatch == "background"' "$LSTART"
LSID=$(echo "$LSTART" | jq -r '.session_id')
LWAIT=$(call_tool opencode_wait "$(jq -nc --arg s "$LSID" '{session_id:$s,timeout_seconds:15}')" | payload)
check "legacy: wait works without /session/status" '.finished == true' "$LWAIT"
check "legacy: answer returned" '[.messages[].text] | join(" ") | test("done: delay=1500")' "$LWAIT"

echo
echo "==================================="
echo " passed: $PASS   failed: $FAIL"
echo "==================================="
[ "$FAIL" -eq 0 ] || exit 1
