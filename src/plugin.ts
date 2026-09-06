import type { Plugin, PluginModule, Hooks } from "@opencode-ai/plugin"
import { startRuntime } from "./plugin/runtime.js"
import type { PluginOptions } from "./plugin/config.js"
import { AGENT_HEADER, CHAT_MODEL, MESSAGE_HEADER, META_MODEL, PROVIDER, SESSION_HEADER, type NotionTransport } from "./plugin/transport.js"
// Separated from startup so the real hooks can be tested with a mock backend.
export function providerHooks(transport: Pick<NotionTransport, "fetch">, close: () => Promise<void>): Hooks {
  return {
    config: async legacy => {
      // The published plugin still references the old root SDK Config type.
      // These fields exist in the pinned runtime core/v1/config/config.ts.
      const config = legacy as typeof legacy & { default_agent?: string; compaction?: { auto?: boolean; prune?: boolean } }
      config.provider ??= {}
      config.provider[PROVIDER] = { name: "Notion AI", npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://opencode-notion.invalid/v1", apiKey: "local-adapter-not-a-credential", fetch: transport.fetch, timeout: false, includeUsage: false },
        models: {
          [CHAT_MODEL]: { name: "Notion AI", tool_call: false, attachment: false, reasoning: false, limit: { context: 200000, output: 32000 } },
          [META_MODEL]: { name: "Notion local metadata", tool_call: false, attachment: false, reasoning: false, limit: { context: 200000, output: 1000 } },
        } }
      config.model = `${PROVIDER}/${CHAT_MODEL}`; config.small_model = `${PROVIDER}/${META_MODEL}`
      config.default_agent = "notion"; config.agent ??= {}
      config.agent.notion = { description: "Notion AI chat with the local execution MCP", mode: "primary", model: `${PROVIDER}/${CHAT_MODEL}`,
        tools: { "*": false }, permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" },
        prompt: "Notion AI owns this conversation and executes work through its dedicated MCP. This OpenCode agent is only a display adapter." }
      config.compaction = { ...config.compaction, auto: false, prune: false }
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== PROVIDER) return
      output.headers[SESSION_HEADER] = input.sessionID; output.headers[MESSAGE_HEADER] = input.message.id; output.headers[AGENT_HEADER] = input.agent
    },
    dispose: close,
  }
}
const server: Plugin = async (input, options) => {
  try {
    const runtime = await startRuntime(input.directory, (options ?? {}) as PluginOptions)
    return providerHooks(runtime.transport, runtime.close)
  } catch (error) {
    // Keep Notion selected on failure; never silently execute with a local LLM.
    const message = error instanceof Error ? error.message : "Notion plugin setup failed"
    return providerHooks({ fetch: async () => Response.json({ error: { message, type: "notion_plugin_setup_error" } }, { status: 400 }) }, async () => {})
  }
}
const plugin: PluginModule = { id: "opencode-notion-bridge", server }
export default plugin
