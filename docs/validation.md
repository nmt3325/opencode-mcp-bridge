# Validation record

## Live integration — 2026-09-06

Verified on an owned GitHub Actions Linux runner with Node 22, Bun 1.3.14 and the unchanged OpenCode 1.18.29 source pin.

- Supplied token_v2 authenticated against app.notion.com.
- Production plugin loaded in the real OpenCode host (not a mock UI).
- Standard chat returned a unique marker from the real Notion AI.
- Plugin automatically started the authenticated execution MCP and registered exactly one dedicated Notion connection.
- Both read/write auto-run policies were enabled.
- Restarted OpenCode and continued the same mapped Notion conversation.
- Notion called real native write, read, edit and bash tools. Final file bytes and a shell-created marker were checked independently on disk.
- Completed-turn journal contained both turns; no duplicate connection was created.
- Temporary MCP connection removal was verified; pre-existing connections remained present.
- Temporary tunnel, credential copies and scratch workspace were removed. Exact credential scan of repository and built output found zero matches.

Notion supplied the reasoning and selected the execution tools. No second OpenCode LLM was used. Native file edits were not simulated. The UI protocol was exercised through the standard CLI; no TUI pixel/screenshot test was performed.

Routine automated tests use mock Notion responses and never use a live Cookie. The one-time live credential and private session/connection identifiers are deliberately absent from this record and the repository.
