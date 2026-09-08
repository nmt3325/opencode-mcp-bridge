# OpenCode tools — standalone MCP server

OpenCode's file-editing and execution tools, extracted into an ordinary **Node.js MCP server**. **No OpenCode installation or source checkout, Bun, chat UI, agent loop, model provider or API key is required.** The MCP client does the reasoning; this server executes the selected operation.

Version **0.3.0** vendors the relevant tool leaves from OpenCode **v1.18.29**, commit `16747470f976aca3d362ad730bcd3fe82ecc2c9a` (MIT). This is a maintained extraction with explicit adapters, **not** a claim that the entire OpenCode runtime runs unchanged. See [provenance and adaptation notes](vendor/opencode/README.md).

```text
MCP client → stdio / authenticated Streamable HTTP
           → bounded jobs + permission controls
           → Node worker → extracted tools → files / processes / HTTP
```

There is no `opencode serve`, OpenCode HTTP client, runtime download, SQLite session database, project plugin loading, model inference, sampling, task/agent delegation, or chat endpoint.

## Tools

| Tool | Operation |
| --- | --- |
| `read` | Read numbered text, paginated directories, images or PDFs |
| `write` | Create or intentionally replace a file |
| `edit` | OpenCode's exact/fuzzy string replacement and diff logic |
| `apply_patch` | Add, update, delete and move files using OpenCode's patch parser |
| `glob` | Find files by glob pattern |
| `grep` | Search file contents using ripgrep |
| `bash` | Execute a command, returning actual output and exit status |
| `webfetch` | Fetch HTTP(S); return text, Markdown, HTML or an image |
| `todowrite` | Update a small JSON task list, shared by clients of this server process |

Tools retain their OpenCode input shapes where applicable. `apply_patch` takes `patchText`. Relative paths resolve inside the configured workspace. `bash.timeout` is **milliseconds**; `webfetch.timeout` is **seconds**, positive and at most 120. File reads have the original 2,000-line / 50 KiB output window; images/PDFs are limited to 5 MiB. Web response bodies are capped at 5 MiB while streaming.

## Install and run

Requirements: **Node.js 22+**, npm, and **ripgrep (`rg`)** for `glob`/`grep`. POSIX command execution uses `/bin/bash`; Windows uses `cmd.exe` with best-effort process-tree cancellation. CI exercises Linux with Node 22 and 24.

Install ripgrep using your OS package manager (for example, `sudo apt-get install ripgrep` or `brew install ripgrep`). The server never downloads executables on startup. Set `OPENCODE_MCP_RG` to an absolute binary path if it is not on `PATH`.

```bash
git clone https://github.com/nmt3325/opencode-mcp-bridge.git
cd opencode-mcp-bridge
npm ci --ignore-scripts
npm run build

# Use a separate directory for the files you want to edit.
mkdir -p /tmp/toolbox-workspace
OPENCODE_MCP_ROOT=/tmp/toolbox-workspace node dist/index.js
```

The clone above is **this server**, not OpenCode. Git is not needed to run a built package. `npm pack` includes the compiled worker, tool implementations, descriptions, attribution and license; it does not include or fetch an OpenCode workspace.

### stdio client configuration

```json
{
  "mcpServers": {
    "opencode-tools": {
      "command": "node",
      "args": ["/opt/opencode-mcp-bridge/dist/index.js"],
      "env": {
        "OPENCODE_MCP_ROOT": "/srv/workspace",
        "OPENCODE_MCP_STATE_DIR": "/var/lib/opencode-mcp"
      }
    }
  }
}
```

### Streamable HTTP

```bash
export OPENCODE_MCP_ROOT=/srv/workspace
export OPENCODE_MCP_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
node dist/index.js --http
# /mcp on 127.0.0.1:8787; supply Authorization: Bearer <token>
```

`x-mcp-token` is also accepted. Tokens must be at least 24 characters. Browser-Origin requests are rejected. `/health` contains no paths or tool data. Keep the default loopback binding or put the service behind authenticated TLS; never publish it as an unauthenticated command runner. Example configurations are in [`examples/`](examples/).

## Permissions and jobs

Reads/search/TODO updates are normally allowed. `.env` reads ask, while `.env.example` is allowed. File mutations (including patches), shell commands and web requests ask by default. Filesystem escape requests and delegation permissions are always denied.

`OPENCODE_MCP_PERMISSIONS` accepts an operator-controlled JSON map. Example:

```json
{
  "edit": "ask",
  "bash": "ask",
  "webfetch": { "*": "ask", "https://docs.example.com/*": "allow" }
}
```

Values are `allow`, `ask`, `deny`, or an ordered pattern-to-action map. Defaults are evaluated first, then overrides; the **last matching rule wins**. The extracted wildcard matcher supports `*` and `?`. `bash` patterns match the **whole command**, not an OpenCode AST. A compound command containing shell operators/substitution is never automatically allowed by a pattern rule: it asks again. Only explicit `"bash":"allow"` opts into blanket shell execution. Old per-subcommand rules must be reviewed when migrating.

A tool call can return `running` or `awaiting_permission`. That is **not completion** and must never cause the caller to execute the operation again.

- `opencode_job_result`: poll the same `job_id` (`wait_seconds`: 0–50).
- `opencode_permissions_pending`: inspect pending requests.
- `opencode_permission_reply`: reply `once` or `reject` using the matching job and permission IDs.
- `opencode_job_cancel`: cancel and wait for process cleanup.
- `opencode_job_list`: inspect retained jobs.
- `opencode_native_info`: compatibility name; reports `implementation: "vendored-tools"`, the source pin and the tool catalog.

Jobs survive HTTP transport reconnects, not a server restart. Commands are never replayed automatically. Shell output uses a bounded preview and saved output file, with a **64 MiB capture ceiling** that terminates excessive output. Search subprocess output has an 8 MiB ceiling and a 60-second timeout; refine broad searches if they exceed it. Saved output can be read only through the exact returned path, not by browsing private state directories. Disk outputs remain in the state directory for operator-managed retention; the in-memory job limits do not constitute a disk quota.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `OPENCODE_MCP_ROOT` | Required editable directory; `DEFAULT_DIRECTORY` remains an alias |
| `OPENCODE_MCP_STATE_DIR` | Private platform state directory, outside the workspace |
| `OPENCODE_MCP_RG` | `rg`; executable for search tools |
| `OPENCODE_MCP_PERMISSIONS` | JSON operator policy; defaults described above |
| `OPENCODE_MCP_WAIT_SECONDS` | 45; initial bounded wait (0–50) |
| `OPENCODE_MCP_JOB_TIMEOUT_SECONDS` | 600; job limit (5–3600), including permission wait |
| `OPENCODE_MCP_MAX_JOBS` | 64; retained jobs (8–256), additionally bounded to 32 MiB in memory |
| `OPENCODE_MCP_MAX_CONCURRENT_JOBS` | 8; active jobs (1–32, no greater than max jobs) |
| `OPENCODE_MCP_HOST`, `OPENCODE_MCP_PORT` | `127.0.0.1`, `8787` |
| `OPENCODE_MCP_TOKEN` | Required only for HTTP |

The package and private state must be outside the editable root; using the filesystem root is forbidden. File operations canonicalize paths and reject symlink escapes. Writes verify file contents/mode again after approval and use same-directory atomic replacement. A changed file causes a conflict instead of silently overwriting someone else's edit. A multi-file patch is **not a transaction**: all hunks are prevalidated, but an I/O failure/cancellation during application can leave partial changes; inspect files and progress before retrying.

**This is not an OS sandbox.** An approved shell command can access anything permitted to its OS account, including outside the workspace. Untrusted commands require a container/VM, unprivileged account, restricted mounts and network policy. The worker gets a private HOME/XDG/TMP environment and does not inherit model keys, GitHub tokens, SSH agents, MCP tokens or Node/Bun injection flags from the parent. This reduces accidental exposure but does not isolate an approved process from the host filesystem or network.

## Migration from 0.2

- Delete `setup:native` / `typecheck:native` from deployment steps. There is no upstream checkout to provision.
- Remove `OPENCODE_MCP_RUNTIME_DIR`, `OPENCODE_MCP_BUN` and `--runtime-dir`; they are rejected instead of selecting a fallback.
- LSP, formatter, provider/model and shell-backend switches are removed. No tool implicitly loads application configuration, plugins, AGENTS instructions, formatters or language servers.
- Existing TODO/session databases are not imported. Each worker owns a small private JSON task list; no chat history or OpenCode database is opened.
- Review shell permission patterns as described above. The job/permission control names and transport behavior are preserved.

## Verify and package

```bash
npm ci --ignore-scripts
npm test                    # builds and runs real filesystem/process/HTTP/stdio tests
npm run verify:vendor       # provenance hashes and source dependency boundary
npm run test:package        # npm pack → isolated production install → real MCP smoke
```

The package smoke test disables OpenCode, Bun and Git commands and executes tools using only the installed archive. CI does not install OpenCode or Bun. Tests cover actual edits/diffs, Unicode/BOM/CRLF, ambiguity, patch operations, approval conflicts, root/symlink restrictions, cancellation/child cleanup, timeouts, bounded output, HTTP authentication, secret stripping and absence of model/plugin execution.

## License

This project is MIT. Extracted OpenCode code retains its [MIT license](vendor/opencode/LICENSE), pinned source paths and SHA-256 provenance in [UPSTREAM.json](vendor/opencode/UPSTREAM.json).
