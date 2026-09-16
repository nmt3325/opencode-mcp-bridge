# Extracted OpenCode sources

Upstream: https://github.com/anomalyco/opencode

Pin: **v1.18.29**, `16747470f976aca3d362ad730bcd3fe82ecc2c9a`, MIT (see LICENSE).

`UPSTREAM.json` records the original source path/hash and the extracted file/hash for every vendored unit. `npm run verify:vendor` checks the latter and the source import boundary without contacting GitHub. Upstream is a provenance reference, **not** a build/runtime dependency. The implementations are under `src/vendor/opencode` and compile into the npm archive.

## What is retained

- Read's numbering, line windows, directory results, binary detection and attachment formatting.
- Write/edit's BOM/CRLF handling, diff generation, literal/fuzzy replacement and ambiguity checks.
- Glob/grep's input schemas, result formatting and limits.
- Webfetch's headers, HTML text extraction, Turndown conversion and image results.
- TODO's leaf/schema, pure core patch parsing/hunk matching, wildcard matching, shell command schema, UTF-8-safe tail and preview algorithms, JSON Schema normalization, BOM/media helpers.

## Intentional adaptations

- Imports target local Node adapters instead of OpenCode's workspace aliases. `.txt` descriptions become compiled ESM strings. Effect remains a normal pinned npm dependency; neither Bun nor any OpenCode package is installed.
- Application services are **removed**, not bootstrapped with dummy model/provider/session objects: LSP, formatter, instructions/system-reminder injection, plugins, event bus, SQLite/projector, agent/config/model/session infrastructure. Edit diagnostics are empty because no language server runs.
- The execution-only `Tool.define` supplies schema validation, permission callbacks that only enforce a fixed deny list, abort signals and output bounds. Node filesystem adapters provide only the methods consumed by the extracted leaves, plus path guards and per-file atomic/conflict-checked writes.
- Ripgrep is explicitly provisioned by the operator, with no automatic binary fetch, no symlink following, bounded subprocess capture, and exact-file restriction for grep.
- The shell uses Node process groups and private environment/state rather than OpenCode's tree-sitter/plugin/config/process service graph. Schema and output algorithms are extracted; shell parsing and permission handling are explicitly different: there is no interactive approval flow, only a fixed deny list, as documented in the main README.
- `apply_patch` uses the upstream pure parser/deriver with a new workspace adapter. Existing add/move destinations and duplicate targets are rejected. It is atomic per file, not a multi-file transaction.
- Webfetch enforces a streaming 5 MiB cap and a timeout covering body consumption; timeout values must be positive and no greater than 120 seconds. Descriptions no longer promise HTTPS upgrading or model summarization.
- Read attachments are limited to 5 MiB. Automatic AGENTS/instruction loading is absent. Edit's description recommends reading but does not claim a nonexistent session-history requirement.
- A regression fix makes `replaceAll` insert replacement dollars (`$&`, `$1`) literally, matching the single-replacement behavior.
- TODO persistence is one small atomic JSON file per worker, not an OpenCode session database. It has no LLM or task-execution behavior.

To update the extraction, review the pinned upstream diff, update only the needed leaves/helpers, record all adaptations and source/vendored hashes, and run the full test and production-package suites. Do not reconnect a tool import to OpenCode's application service graph.
