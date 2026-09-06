# Notion client provenance
Copied from nmt3325/notion-ai-mcp, commit fa773f022b08ec43884927ed865c3ef3dbec8711.
Only the client library and its local dependencies are included. No MCP server,
watchdog, workspace-rotation loop, or process entrypoint is started by the plugin.
The adapter explicitly sets maxWorkspaceRetries to zero and disables keep-awake.
The upstream API is unofficial and may change. Preserve this pin when updating.
