import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type JsonObject = Record<string, unknown>;

/** Every authentication style the Notion "Custom MCP" connect form supports. */
export type McpAuth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "token"; token: string }
  | { type: "apiKey"; key: string; headerName?: string }
  | { type: "basic"; username: string; password: string }
  | { type: "header"; headers: Record<string, string> }
  | { type: "oauth" };

export type McpApprovalIntent = "approve_on_connect";
export type McpTransport = "streamableHttp" | "sse";
export interface McpToolSettings {
  /** Undefined means every discovered tool is enabled. */
  enabledToolNames?: string[];
  /** Undefined follows Notion's default: read tools run automatically. */
  runReadToolsAutomatically?: boolean;
  /** Undefined follows Notion's default: write tools require confirmation. */
  runWriteToolsAutomatically?: boolean;
}
export interface McpHeader { name: string; value: string }
export interface McpContext { spaceId: string; userId: string; spaceViewId: string }

export interface McpConnectionRecord {
  id: string;
  name: string;
  serverUrl: string;
  spaceId: string;
  /** Optional so registries written by older releases continue to load. */
  spaceViewId?: string;
  authType: McpAuth["type"] | "unknown";
  transport: string;
  toolNames: string[];
  enabledToolNames?: string[];
  runReadToolsAutomatically?: boolean;
  runWriteToolsAutomatically?: boolean;
  createdAt: string;
}

export interface McpConnectionSummary {
  id: string;
  name: string;
  serverUrl: string;
  spaceId: string;
  spaceViewId: string;
  authType: McpAuth["type"] | "unknown";
  transport: string;
  toolNames: string[];
  /** null means every discovered tool is enabled. */
  enabledToolNames: string[] | null;
  runReadToolsAutomatically: boolean;
  runWriteToolsAutomatically: boolean;
  createdAt: string | null;
  source: "notion" | "notion_and_registry" | "registry_only";
  alive: boolean | null;
  linked: boolean;
  defaultEnabled: boolean;
}

export interface McpApi {
  post(endpoint: string, body: JsonObject): Promise<JsonObject>;
  context(): Promise<McpContext>;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
function unwrapRecord(value: unknown): JsonObject {
  let current = object(value);
  for (let index = 0; index < 5; index += 1) {
    const nested = current.value;
    if (nested === undefined || nested === null || typeof nested !== "object" || Array.isArray(nested)) break;
    current = object(nested);
  }
  return current;
}
function asString(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function asIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function linkedModuleId(value: unknown): string { return asString(object(object(value).pointer).id); }
function linkedModules(settings: JsonObject): unknown[] { return Array.isArray(settings.agent_chat_modules) ? settings.agent_chat_modules : []; }

/** Turns a declarative auth choice into the legacy header map used by callers. */
export function buildAuthHeaders(auth: McpAuth | undefined): Record<string, string> {
  if (!auth) return {};
  switch (auth.type) {
    case "none":
    case "oauth":
      return {};
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` };
    case "token":
      return { Authorization: `Token ${auth.token}` };
    case "apiKey":
      return { [auth.headerName?.trim() || "X-API-Key"]: auth.key };
    case "basic":
      return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` };
    case "header":
      return { ...auth.headers };
    default: {
      const exhaustive: never = auth;
      throw new Error(`Unsupported MCP auth type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Current Notion APIs expect authHeaders as [{name,value}], not an object map. */
export function buildAuthHeaderList(auth: McpAuth | undefined): McpHeader[] {
  return Object.entries(buildAuthHeaders(auth))
    .map(([name, value]) => ({ name: name.trim(), value }))
    .filter(({ name, value }) => Boolean(name) && Boolean(value.trim()));
}

export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("serverUrl is required");
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new Error(`serverUrl is not a valid URL: ${value}`); }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("serverUrl must use https (localhost is allowed for testing)");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeTransport(value?: string): McpTransport {
  const normalized = value?.trim() || "streamableHttp";
  if (normalized === "streamableHttp" || normalized === "streamable-http" || normalized === "http") return "streamableHttp";
  if (normalized === "sse") return "sse";
  throw new Error("transport must be streamableHttp or sse");
}

export function toolNamesFrom(value: unknown): string[] {
  const tools = Array.isArray(value) ? value : Array.isArray(object(value).tools) ? (object(value).tools as unknown[]) : [];
  return tools.map((tool) => asString(object(tool).name)).filter(Boolean);
}

const MAX_PRECONFIGURED_SERVERS = 200;
const MAX_PRECONFIGURED_TEXT = 8_192;

function boundedString(value: unknown, maximum = MAX_PRECONFIGURED_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : undefined;
}

function boundedStringList(value: unknown, maximum = 100): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value.slice(0, maximum)) {
    const normalized = boundedString(item, 1_024);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function catalogUrl(value: unknown): string | undefined {
  const text = boundedString(value);
  if (!text) return undefined;
  try { return normalizeServerUrl(text); } catch { return undefined; }
}

function validRegex(pattern: string): boolean {
  if (pattern.length > 2_048) return false;
  try { new RegExp(pattern); return true; } catch { return false; }
}

function sanitizeServerUrlConfig(value: unknown): PreconfiguredServerUrlConfig | undefined {
  const raw = object(value);
  switch (asString(raw.type)) {
    case "fixed": {
      const url = catalogUrl(raw.url);
      return url ? { type: "fixed", url } : undefined;
    }
    case "variant": {
      const source = Array.isArray(raw.variants) ? raw.variants.slice(0, 100) : [];
      const variants: Array<{ name: string; url: string }> = [];
      const names = new Set<string>();
      for (const item of source) {
        const candidate = object(item);
        const name = boundedString(candidate.name, 200);
        const url = catalogUrl(candidate.url);
        if (!name || !url || names.has(name.toLowerCase())) continue;
        names.add(name.toLowerCase());
        variants.push({ name, url });
      }
      if (variants.length === 0) return undefined;
      const rawDefault = raw.defaultVariantIndex;
      const defaultVariantIndex = typeof rawDefault === "number" && Number.isInteger(rawDefault)
        && rawDefault >= 0 && rawDefault < variants.length ? rawDefault : undefined;
      return { type: "variant", variants, ...(defaultVariantIndex !== undefined ? { defaultVariantIndex } : {}) };
    }
    case "template": {
      const urlTemplate = boundedString(raw.urlTemplate);
      const source = Array.isArray(raw.placeholders) ? raw.placeholders.slice(0, 100) : [];
      if (!urlTemplate || !(urlTemplate.startsWith("https://") || urlTemplate.startsWith("http://localhost"))) return undefined;
      const placeholders: Array<{ key: string; label: string; description?: string; pattern?: string }> = [];
      const keys = new Set<string>();
      for (const item of source) {
        const candidate = object(item);
        const key = boundedString(candidate.key, 100);
        const label = boundedString(candidate.label, 300);
        const description = boundedString(candidate.description, 2_000);
        const pattern = boundedString(candidate.pattern, 2_048);
        if (!key || !/^[A-Za-z0-9_-]+$/.test(key) || !label || keys.has(key)) return undefined;
        if (pattern && !validRegex(pattern)) return undefined;
        keys.add(key);
        placeholders.push({ key, label, ...(description ? { description } : {}), ...(pattern ? { pattern } : {}) });
      }
      if (placeholders.length === 0 || placeholders.some(({ key }) => !urlTemplate.includes(`{${key}}`))) return undefined;
      return { type: "template", urlTemplate, placeholders };
    }
    case "pattern": {
      const validationPattern = boundedString(raw.validationPattern, 2_048);
      if (!validationPattern || !validRegex(validationPattern)) return undefined;
      const description = boundedString(raw.description, 2_000);
      const label = boundedString(raw.label, 300);
      const placeholder = boundedString(raw.placeholder, 2_000);
      return {
        type: "pattern", validationPattern,
        ...(description ? { description } : {}),
        ...(label ? { label } : {}),
        ...(placeholder ? { placeholder } : {})
      };
    }
    default:
      return undefined;
  }
}

/** Allowlist and normalize the live Notion catalog; hidden entries and unknown fields never escape. */
export function sanitizePreconfiguredCatalog(value: unknown): PreconfiguredMcpServer[] {
  const rawServers = Array.isArray(object(value).servers) ? object(value).servers as unknown[] : [];
  const result: PreconfiguredMcpServer[] = [];
  const ids = new Set<string>();
  for (const item of rawServers.slice(0, MAX_PRECONFIGURED_SERVERS)) {
    const raw = object(item);
    if (asString(raw.visibility) === "hidden") continue;
    const id = boundedString(raw.id, 512);
    const name = boundedString(raw.name, 512);
    if (!id || !name || ids.has(id)) continue;
    const serverUrl = catalogUrl(raw.serverUrl);
    const serverUrlConfig = sanitizeServerUrlConfig(raw.serverUrlConfig);
    if (!serverUrl && !serverUrlConfig) continue;
    ids.add(id);
    const tagline = boundedString(raw.tagline, 2_000);
    result.push({
      id,
      name,
      ...(tagline ? { tagline } : {}),
      visibility: asString(raw.visibility) === "enabled" ? "enabled" : "disabled",
      ...(serverUrl ? { serverUrl } : {}),
      ...(serverUrlConfig ? { serverUrlConfig } : {}),
      supportedAuthSchemes: boundedStringList(raw.supportedAuthSchemes),
      supportedOAuthScopes: boundedStringList(raw.supportedOAuthScopes),
      ...(raw.mcpApprovalIntent === "approve_on_connect" ? { mcpApprovalIntent: "approve_on_connect" as const } : {})
    });
  }
  return result;
}

/** Match the current Web client resolver for fixed, variant, template, and pattern URL configs. */
export function resolvePreconfiguredServerUrl(
  server: PreconfiguredMcpServer,
  selection: PreconfiguredMcpSelection = {}
): string {
  const config = server.serverUrlConfig;
  if (!config) {
    if (!server.serverUrl) throw new Error(`${server.name} does not define a server URL`);
    return normalizeServerUrl(server.serverUrl);
  }
  switch (config.type) {
    case "fixed":
      return normalizeServerUrl(config.url);
    case "variant": {
      let index: number | undefined;
      const requested = selection.variant?.trim();
      if (requested) index = config.variants.findIndex(({ name }) => name.toLowerCase() === requested.toLowerCase());
      else if (config.defaultVariantIndex !== undefined) index = config.defaultVariantIndex;
      else if (server.serverUrl) index = config.variants.findIndex(({ url }) => normalizeServerUrl(url) === normalizeServerUrl(server.serverUrl as string));
      if (index === undefined || index < 0) index = 0;
      const selected = config.variants[index];
      if (!selected || (requested && selected.name.toLowerCase() !== requested.toLowerCase())) {
        throw new Error(`Unknown ${server.name} variant; choose one of: ${config.variants.map(({ name }) => name).join(", ")}`);
      }
      return normalizeServerUrl(selected.url);
    }
    case "template": {
      let resolved = config.urlTemplate;
      const values = selection.templateValues ?? {};
      for (const placeholder of config.placeholders) {
        const raw = values[placeholder.key];
        const normalized = raw?.trim();
        if (!normalized) throw new Error(`templateValues.${placeholder.key} is required for ${server.name}`);
        if (placeholder.pattern && !new RegExp(placeholder.pattern).test(normalized)) {
          throw new Error(`templateValues.${placeholder.key} does not match the catalog pattern`);
        }
        resolved = resolved.replaceAll(`{${placeholder.key}}`, encodeURIComponent(normalized));
      }
      if (/\{[A-Za-z0-9_-]+\}/.test(resolved)) throw new Error(`${server.name} URL template has unresolved placeholders`);
      return normalizeServerUrl(resolved);
    }
    case "pattern": {
      const raw = selection.serverUrl?.trim();
      if (!raw) throw new Error(`serverUrl is required for ${server.name}`);
      if (!new RegExp(config.validationPattern).test(raw)) throw new Error(`serverUrl does not match the ${server.name} catalog pattern`);
      return normalizeServerUrl(raw);
    }
    default: {
      const exhaustive: never = config;
      throw new Error(`Unsupported preconfigured URL config: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const MCP_NO_TOOLS_SENTINEL = "__NONE__";

/** Notion persists disable-all with a sentinel because an empty array is normalized away. */
function persistedToolNames(value: string[]): string[] {
  return value.length === 0 ? [MCP_NO_TOOLS_SENTINEL] : [...value];
}

/** Decode Notion's sentinel while keeping the public API free of internal marker values. */
function storedToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || name === MCP_NO_TOOLS_SENTINEL || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Normalize a selection and reject names that were not returned by validation. */
export function normalizeEnabledToolNames(value: string[], availableToolNames: string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = item.trim();
    if (!name) throw new Error("enabledToolNames cannot contain empty names");
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  const available = new Set(availableToolNames);
  const unknown = names.filter((name) => name === MCP_NO_TOOLS_SENTINEL || !available.has(name));
  if (unknown.length > 0) throw new Error(`Unknown MCP tool name(s): ${unknown.join(", ")}`);
  return names;
}

/** Normalize optional OAuth scopes exactly as the current connect UI resolves them. */
export function normalizeOAuthScopes(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.length > 100) throw new Error("selectedScopes supports at most 100 scopes");
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const scope = item.trim();
    if (!scope) throw new Error("selectedScopes cannot contain empty scopes");
    if (scope.length > 1_024) throw new Error("selectedScopes contains an excessively long scope");
    if (seen.has(scope)) continue;
    seen.add(scope);
    scopes.push(scope);
  }
  if (scopes.length === 0) throw new Error("selectedScopes must contain at least one scope when provided");
  return scopes;
}

const SAFE_OAUTH_RESPONSE_FIELDS = ["authorizationUrl", "completionFlowId", "oauthFlowId"] as const;

/** Keep transient credentials request-only, even if a future API response accidentally echoes them. */
function safeOAuthResponse(response: JsonObject, integrationId: string, clientSecret?: string): JsonObject {
  const safe: JsonObject = { integrationId };
  const secretVariants = clientSecret
    ? new Set([clientSecret, encodeURIComponent(clientSecret), JSON.stringify(clientSecret).slice(1, -1)])
    : new Set<string>();
  for (const key of SAFE_OAUTH_RESPONSE_FIELDS) {
    const value = response[key];
    if (typeof value !== "string" || !value) continue;
    if ([...secretVariants].some((variant) => variant.length > 0 && value.includes(variant))) {
      throw new Error("Notion returned an unsafe OAuth response containing supplied credentials");
    }
    safe[key] = value;
  }
  return safe;
}

const OAUTH_FLOW_TTL_MS = 3 * 60 * 1_000;
const OAUTH_POLL_INTERVAL_MS = 5_000;
const MAX_PENDING_OAUTH_FLOWS = 100;
const MAX_OAUTH_FLOW_ID_LENGTH = 2_048;
const MAX_OAUTH_CONNECTION_ID_LENGTH = 8_192;
const OAUTH_CONNECTION_HEADER = "__oauth_connection_id";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizePendingToolNames(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = item.trim();
    if (!name) throw new Error("enabledToolNames cannot contain empty names");
    if (name === MCP_NO_TOOLS_SENTINEL) throw new Error(`Unknown MCP tool name(s): ${name}`);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function nativeOAuthBrowserUrl(authorizationUrl: string): string {
  let target: URL;
  try { target = new URL(authorizationUrl); }
  catch { throw new Error("Notion returned an invalid OAuth authorization URL"); }
  if (target.protocol !== "https:" && target.hostname !== "localhost" && target.hostname !== "127.0.0.1") {
    throw new Error("OAuth authorization URL must use https (localhost is allowed for testing)");
  }
  const wrapper = new URL("https://app.notion.com/initiateExternalAuthenticationFromDesktop");
  wrapper.searchParams.set("redirectUri", target.toString());
  return wrapper.toString();
}

function oauthFailureMessage(value: unknown): string {
  const raw = typeof value === "string" ? value : asString(object(value).message);
  return (raw.trim() || "OAuth authorization failed").slice(0, 2_048);
}

/** Local mirror of the modules we created, so the tools keep working across restarts. */
export class McpRegistry {
  private records: McpConnectionRecord[] = [];

  constructor(private readonly path?: string) { this.load(); }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      const list = Array.isArray(parsed) ? parsed : object(parsed).connections;
      this.records = (Array.isArray(list) ? list : []).map((item) => object(item) as unknown as McpConnectionRecord).filter((item) => Boolean(item.id));
    } catch { this.records = []; }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ connections: this.records }, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  list(): McpConnectionRecord[] { return [...this.records]; }
  get(id: string): McpConnectionRecord | undefined { return this.records.find((record) => record.id === id); }
  upsert(record: McpConnectionRecord): void {
    const index = this.records.findIndex((item) => item.id === record.id);
    if (index >= 0) this.records[index] = record; else this.records.push(record);
    this.save();
  }
  remove(id: string): boolean {
    const next = this.records.filter((record) => record.id !== id);
    const removed = next.length !== this.records.length;
    this.records = next;
    if (removed) this.save();
    return removed;
  }
}

export interface AddConnectionInput extends McpToolSettings {
  name: string;
  serverUrl: string;
  auth?: McpAuth;
  transport?: string;
  approvalIntent?: McpApprovalIntent;
}

export interface UpdateConnectionInput {
  name?: string;
  serverUrl?: string;
  auth?: McpAuth;
  transport?: string;
  approvalIntent?: McpApprovalIntent;
  /** null removes the filter so all discovered tools are enabled. */
  enabledToolNames?: string[] | null;
  runReadToolsAutomatically?: boolean;
  runWriteToolsAutomatically?: boolean;
}

export interface StartOAuthOptions extends McpToolSettings {
  selectedScopes?: string[];
  workflowId?: string;
  /** Supplying a verified current-workspace module enables reconnect context. */
  existingModuleId?: string;
  /** Local display name used when the completed flow creates a Personal Agent module. */
  connectionName?: string;
  transport?: string;
  approvalIntent?: McpApprovalIntent;
  /** BYO OAuth credentials are transient and are never persisted or returned. */
  userProvidedOAuthClientId?: string;
  userProvidedOAuthClientSecret?: string;
}

export interface CompleteOAuthOptions {
  /** Override the display name captured when the flow started. */
  connectionName?: string;
  transport?: string;
  /** null removes an existing reconnect filter; [] disables all discovered tools. */
  enabledToolNames?: string[] | null;
  runReadToolsAutomatically?: boolean;
  runWriteToolsAutomatically?: boolean;
  /** Bounded polling window. Zero performs one immediate status check. */
  waitSeconds?: number;
}

interface PendingOAuthFlow {
  oauthFlowId: string;
  integrationId: string;
  completionFlowId?: string;
  serverUrl: string;
  spaceId: string;
  spaceViewId: string;
  connectionName: string;
  transport: McpTransport;
  enabledToolNames?: string[];
  runReadToolsAutomatically: boolean;
  runWriteToolsAutomatically: boolean;
  approvalIntent: McpApprovalIntent;
  existingModuleId?: string;
  workflowId?: string;
  expiresAt: number;
}

export type PreconfiguredServerUrlConfig =
  | { type: "fixed"; url: string }
  | { type: "variant"; variants: Array<{ name: string; url: string }>; defaultVariantIndex?: number }
  | { type: "template"; urlTemplate: string; placeholders: Array<{ key: string; label: string; description?: string; pattern?: string }> }
  | { type: "pattern"; validationPattern: string; description?: string; label?: string; placeholder?: string };

export interface PreconfiguredMcpServer {
  id: string;
  name: string;
  tagline?: string;
  visibility: "enabled" | "disabled";
  serverUrl?: string;
  serverUrlConfig?: PreconfiguredServerUrlConfig;
  supportedAuthSchemes: string[];
  supportedOAuthScopes: string[];
  mcpApprovalIntent?: McpApprovalIntent;
}

export interface PreconfiguredMcpSelection {
  /** Case-insensitive variant name such as US or EU. */
  variant?: string;
  /** Required only for pattern-configured catalog entries. */
  serverUrl?: string;
  /** Required only for template-configured catalog entries. */
  templateValues?: Record<string, string>;
}

export interface ConnectPreconfiguredOptions extends PreconfiguredMcpSelection, McpToolSettings {
  auth?: McpAuth;
  transport?: string;
  selectedScopes?: string[];
  userProvidedOAuthClientId?: string;
  userProvidedOAuthClientSecret?: string;
}

export class McpConnectionManager {
  private readonly registry: McpRegistry;
  /** Credential-free, process-local flow bindings. They intentionally do not survive a restart. */
  private readonly pendingOAuthFlows = new Map<string, PendingOAuthFlow>();
  private readonly completingOAuthFlows = new Set<string>();

  constructor(private readonly api: McpApi, registryPath?: string) {
    this.registry = new McpRegistry(registryPath);
  }

  private prunePendingOAuthFlows(now = Date.now()): void {
    for (const [flowId, flow] of this.pendingOAuthFlows) {
      if (flow.expiresAt <= now) this.pendingOAuthFlows.delete(flowId);
    }
  }

  private async context(): Promise<McpContext> {
    const context = await this.api.context();
    if (!context.spaceId || !context.userId || !context.spaceViewId) {
      throw new Error("MCP connection management requires a resolved user, workspace, and space view");
    }
    return context;
  }

  async checkOAuthSupport(serverUrl: string): Promise<JsonObject> {
    const { spaceId } = await this.context();
    return this.api.post("checkMcpOAuthSupport", { serverUrl: normalizeServerUrl(serverUrl), spaceId });
  }

  private async validateInContext(
    context: McpContext,
    serverUrl: string,
    auth?: McpAuth,
    approvalIntent: McpApprovalIntent = "approve_on_connect",
    oauthConnectionId?: string
  ): Promise<JsonObject> {
    const connectionId = oauthConnectionId?.trim();
    if (oauthConnectionId !== undefined && !connectionId) throw new Error("OAuth connectionId cannot be empty");
    const response = await this.api.post("validateMcpConnection", {
      serverUrl: normalizeServerUrl(serverUrl),
      spaceId: context.spaceId,
      authHeaders: buildAuthHeaderList(auth),
      ...(connectionId ? { connectionId } : {}),
      approvalIntent
    });
    if (response.success === false) {
      const detail = asString(object(response.error).message, "connection validation failed");
      throw new Error(`Notion rejected the MCP server: ${detail}`);
    }
    return response;
  }

  async validate(serverUrl: string, auth?: McpAuth, approvalIntent: McpApprovalIntent = "approve_on_connect"): Promise<JsonObject> {
    return this.validateInContext(await this.context(), serverUrl, auth, approvalIntent);
  }

  /** Exact workflow_module record shape emitted by Notion's current model factory. */
  buildCreateTransaction(moduleId: string, context: McpContext, input: AddConnectionInput, toolList: unknown[], now = Date.now()): JsonObject {
    const enabledToolNames = input.enabledToolNames === undefined
      ? undefined
      : normalizeEnabledToolNames(input.enabledToolNames, toolNamesFrom(toolList));
    const data: JsonObject = {
      id: moduleId,
      name: input.name,
      icon: "🤖",
      serverUrl: normalizeServerUrl(input.serverUrl),
      preferredTransport: normalizeTransport(input.transport),
      ...(toolList.length ? { tools: toolList } : {}),
      ...(enabledToolNames !== undefined ? { enabledToolNames: persistedToolNames(enabledToolNames) } : {}),
      runReadToolsAutomatically: input.runReadToolsAutomatically ?? true,
      runWriteToolsAutomatically: input.runWriteToolsAutomatically ?? false
    };
    return {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: context.spaceId,
        operations: [{
          pointer: { table: "workflow_module", id: moduleId, spaceId: context.spaceId },
          path: [],
          command: "set",
          args: {
            alive: true,
            created_by_id: context.userId,
            created_by_table: "notion_user",
            created_time: now,
            id: moduleId,
            last_edited_by_id: context.userId,
            last_edited_by_table: "notion_user",
            last_edited_time: now,
            parent_id: context.userId,
            parent_table: "notion_user",
            version: 1,
            module_type: "mcpServer",
            space_id: context.spaceId,
            data
          }
        }]
      }]
    };
  }

  private async loadSpaceViewSettings(context: McpContext): Promise<JsonObject> {
    const response = await this.api.post("syncRecordValuesMain", {
      requests: [{ pointer: { table: "space_view", id: context.spaceViewId }, version: -1 }],
      spacePointer: { table: "space", id: context.spaceId }
    });
    const recordMap = object(response.recordMap);
    const record = unwrapRecord(object(recordMap.space_view)[context.spaceViewId]);
    if (asString(record.id) !== context.spaceViewId || asString(record.space_id) !== context.spaceId || record.alive !== true) {
      throw new Error(`Current space_view ${context.spaceViewId} is missing or invalid`);
    }
    return object(record.settings);
  }

  private async loadSpaceRecords(context: McpContext, pointers: Array<{ table: string; id: string; spaceId: string }>): Promise<Map<string, JsonObject>> {
    const unique = new Map<string, { table: string; id: string; spaceId: string }>();
    for (const pointer of pointers) {
      if (!pointer.table || !pointer.id || pointer.spaceId !== context.spaceId) continue;
      unique.set(`${pointer.table}:${pointer.id}`, pointer);
    }
    if (unique.size === 0) return new Map();
    const response = await this.api.post("syncRecordValues", {
      requests: [...unique.values()].map((pointer) => ({ pointer, version: -1 }))
    });
    const recordMap = object(response.recordMap);
    const records = new Map<string, JsonObject>();
    for (const [key, pointer] of unique) {
      const record = unwrapRecord(object(recordMap[pointer.table])[pointer.id]);
      if (asString(record.id) === pointer.id) records.set(key, record);
    }
    return records;
  }

  private async loadSpaceRecord(context: McpContext, table: string, id: string, pointerSpaceId = context.spaceId): Promise<JsonObject> {
    const records = await this.loadSpaceRecords(context, [{ table, id, spaceId: pointerSpaceId }]);
    const record = records.get(`${table}:${id}`);
    if (!record) throw new Error(`${table} ${id} was not found`);
    return record;
  }

  private settingsOperation(context: McpContext, settings: JsonObject, moduleId: string, linked: boolean): JsonObject {
    const existing = linkedModules(settings).filter((entry) => linkedModuleId(entry) !== moduleId);
    const agentChatModules = linked
      ? [...existing, { pointer: { table: "workflow_module", id: moduleId, spaceId: context.spaceId }, defaultEnabled: false }]
      : existing;
    return {
      pointer: { table: "space_view", id: context.spaceViewId, spaceId: context.spaceId },
      path: ["settings"],
      command: "update",
      args: { ...settings, agent_chat_modules: agentChatModules }
    };
  }

  private settingsTransaction(context: McpContext, settings: JsonObject, moduleId: string, linked: boolean): JsonObject {
    return {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: context.spaceId,
        operations: [this.settingsOperation(context, settings, moduleId, linked)]
      }]
    };
  }


  private moduleDataTransaction(moduleId: string, spaceId: string, data: JsonObject): JsonObject {
    return {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId,
        operations: [{
          pointer: { table: "workflow_module", id: moduleId, spaceId },
          path: ["data"],
          command: "set",
          args: data
        }]
      }]
    };
  }

  private deadOperation(moduleId: string, spaceId: string): JsonObject {
    return {
      pointer: { table: "workflow_module", id: moduleId, spaceId },
      path: [],
      command: "update",
      args: { alive: false }
    };
  }

  private deadTransaction(moduleId: string, spaceId: string): JsonObject {
    return {
      requestId: randomUUID(),
      transactions: [{ id: randomUUID(), spaceId, operations: [this.deadOperation(moduleId, spaceId)] }]
    };
  }

  private deactivateTransaction(context: McpContext, settings: JsonObject, moduleId: string): JsonObject {
    return {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: context.spaceId,
        operations: [this.deadOperation(moduleId, context.spaceId), this.settingsOperation(context, settings, moduleId, false)]
      }]
    };
  }

  private async deactivateAndUnlink(moduleId: string, context: McpContext): Promise<void> {
    try {
      const settings = await this.loadSpaceViewSettings(context);
      await this.api.post("saveTransactionsFanout", this.deactivateTransaction(context, settings, moduleId));
    } catch (error) {
      await this.api.post("saveTransactionsFanout", this.deadTransaction(moduleId, context.spaceId));
      throw error;
    }
  }

  private assertActiveWorkspace(record: McpConnectionRecord | undefined, context: McpContext): void {
    if (record?.spaceId && record.spaceId !== context.spaceId) {
      throw new Error(`MCP connection belongs to workspace ${record.spaceId}; switch to that workspace first`);
    }
    if (record?.spaceViewId && record.spaceViewId !== context.spaceViewId) {
      throw new Error("MCP connection belongs to a different space view; switch workspaces first");
    }
  }

  async add(input: AddConnectionInput): Promise<McpConnectionRecord & { validation: JsonObject }> {
    const context = await this.context();
    const name = input.name.trim();
    if (!name) throw new Error("name is required");
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const approvalIntent = input.approvalIntent ?? "approve_on_connect";
    const transport = normalizeTransport(input.transport);
    const validation = await this.validateInContext(context, serverUrl, input.auth, approvalIntent);
    const toolList = Array.isArray(validation.tools) ? (validation.tools as unknown[]) : [];
    const enabledToolNames = input.enabledToolNames === undefined
      ? undefined
      : normalizeEnabledToolNames(input.enabledToolNames, toolNamesFrom(toolList));
    const runReadToolsAutomatically = input.runReadToolsAutomatically ?? true;
    const runWriteToolsAutomatically = input.runWriteToolsAutomatically ?? false;
    const normalizedInput: AddConnectionInput = {
      ...input,
      name,
      serverUrl,
      transport,
      ...(enabledToolNames !== undefined ? { enabledToolNames } : {}),
      runReadToolsAutomatically,
      runWriteToolsAutomatically
    };
    const moduleId = randomUUID();
    await this.api.post("saveTransactionsFanout", this.buildCreateTransaction(moduleId, context, normalizedInput, toolList));
    try {
      await this.api.post("postWorkflowsMcpServerConnect", {
        integrationId: moduleId,
        spaceId: context.spaceId,
        authHeaders: buildAuthHeaderList(input.auth),
        initiationContext: "connect",
        approvalIntent
      });
      const settings = await this.loadSpaceViewSettings(context);
      await this.api.post("saveTransactionsFanout", this.settingsTransaction(context, settings, moduleId, true));
    } catch (error) {
      await this.deactivateAndUnlink(moduleId, context).catch(() => undefined);
      throw error;
    }
    const record: McpConnectionRecord = {
      id: moduleId,
      name,
      serverUrl,
      spaceId: context.spaceId,
      spaceViewId: context.spaceViewId,
      authType: input.auth?.type ?? "none",
      transport,
      toolNames: toolNamesFrom(toolList),
      ...(enabledToolNames !== undefined ? { enabledToolNames: [...enabledToolNames] } : {}),
      runReadToolsAutomatically,
      runWriteToolsAutomatically,
      createdAt: new Date().toISOString()
    };
    try { this.registry.upsert(record); }
    catch (error) {
      await this.deactivateAndUnlink(moduleId, context).catch(() => undefined);
      throw error;
    }
    return { ...record, validation };
  }

  async update(id: string, changes: UpdateConnectionInput): Promise<McpConnectionRecord> {
    if (changes.name === undefined
      && changes.serverUrl === undefined
      && changes.auth === undefined
      && changes.transport === undefined
      && changes.enabledToolNames === undefined
      && changes.runReadToolsAutomatically === undefined
      && changes.runWriteToolsAutomatically === undefined) {
      throw new Error("At least one MCP connection update is required");
    }
    const existing = this.registry.get(id);
    const context = await this.context();
    this.assertActiveWorkspace(existing, context);
    const settings = await this.loadSpaceViewSettings(context);
    const linked = linkedModules(settings).some((entry) => {
      const pointer = object(object(entry).pointer);
      return asString(pointer.table) === "workflow_module"
        && asString(pointer.id) === id
        && asString(pointer.spaceId) === context.spaceId;
    });
    if (!linked) throw new Error(`MCP connection ${id} is not linked to the current Personal Agent`);

    const moduleRecord = await this.loadSpaceRecord(context, "workflow_module", id);
    if (asString(moduleRecord.id) !== id
      || asString(moduleRecord.module_type) !== "mcpServer"
      || moduleRecord.alive !== true
      || asString(moduleRecord.space_id) !== context.spaceId) {
      throw new Error(`${id} is not a live MCP module in the active workspace`);
    }
    const currentData = object(moduleRecord.data);
    const currentName = asString(currentData.name, asString(currentData.officialName, existing?.name ?? id));
    const currentServerUrl = asString(currentData.serverUrl, existing?.serverUrl ?? "");
    if (!currentServerUrl) throw new Error(`MCP connection ${id} has no server URL`);
    const currentTransport = normalizeTransport(asString(currentData.preferredTransport, existing?.transport ?? "streamableHttp"));
    const name = changes.name === undefined ? currentName : changes.name.trim();
    if (!name) throw new Error("name is required");
    const serverUrl = changes.serverUrl === undefined ? currentServerUrl : normalizeServerUrl(changes.serverUrl);
    const transport = changes.transport === undefined ? currentTransport : normalizeTransport(changes.transport);
    const serverSettingsChanged = serverUrl !== currentServerUrl || transport !== currentTransport;
    if (serverSettingsChanged && changes.auth === undefined) {
      throw new Error("Changing serverUrl or transport requires auth to validate and reconnect the MCP server");
    }

    const reconnect = changes.auth !== undefined || serverSettingsChanged;
    let validatedTools: unknown[] | undefined;
    if (reconnect) {
      const validation = await this.validateInContext(context, serverUrl, changes.auth, changes.approvalIntent ?? "approve_on_connect");
      validatedTools = Array.isArray(validation.tools) ? validation.tools : [];
    }
    const enabledToolNames = Array.isArray(changes.enabledToolNames)
      ? normalizeEnabledToolNames(changes.enabledToolNames, toolNamesFrom(validatedTools ?? currentData.tools))
      : undefined;
    const data: JsonObject = {
      ...currentData,
      id,
      name,
      serverUrl,
      preferredTransport: transport,
      ...(validatedTools && validatedTools.length > 0 ? { tools: validatedTools } : {}),
      ...(enabledToolNames !== undefined ? { enabledToolNames: persistedToolNames(enabledToolNames) } : {}),
      ...(changes.runReadToolsAutomatically !== undefined ? { runReadToolsAutomatically: changes.runReadToolsAutomatically } : {}),
      ...(changes.runWriteToolsAutomatically !== undefined ? { runWriteToolsAutomatically: changes.runWriteToolsAutomatically } : {})
    };
    if (changes.enabledToolNames === null) delete data.enabledToolNames;
    await this.api.post("saveTransactionsFanout", {
      requestId: randomUUID(),
      transactions: [{
        id: randomUUID(),
        spaceId: context.spaceId,
        operations: [{
          pointer: { table: "workflow_module", id, spaceId: context.spaceId },
          path: ["data"],
          command: changes.enabledToolNames === null ? "set" : "update",
          args: data
        }]
      }]
    });
    if (reconnect) {
      await this.api.post("postWorkflowsMcpServerConnect", {
        integrationId: id,
        spaceId: context.spaceId,
        authHeaders: buildAuthHeaderList(changes.auth),
        initiationContext: "reconnect",
        approvalIntent: changes.approvalIntent ?? "approve_on_connect"
      });
    }
    const remoteToolNames = toolNamesFrom(data.tools);
    const storedEnabled = storedToolNames(data.enabledToolNames);
    const record: McpConnectionRecord = {
      id,
      name,
      serverUrl,
      spaceId: context.spaceId,
      spaceViewId: context.spaceViewId,
      authType: changes.auth?.type ?? existing?.authType ?? "unknown",
      transport,
      toolNames: remoteToolNames.length > 0 ? remoteToolNames : [...(existing?.toolNames ?? [])],
      ...(storedEnabled !== undefined ? { enabledToolNames: storedEnabled } : {}),
      runReadToolsAutomatically: data.runReadToolsAutomatically !== false,
      runWriteToolsAutomatically: data.runWriteToolsAutomatically === true,
      createdAt: existing?.createdAt ?? asIsoTimestamp(moduleRecord.created_time) ?? new Date().toISOString()
    };
    this.registry.upsert(record);
    return record;
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    const existing = this.registry.get(id);
    const context = await this.context();
    this.assertActiveWorkspace(existing, context);
    await this.deactivateAndUnlink(id, context);
    this.registry.remove(id);
    return { removed: true };
  }

  async list(): Promise<McpConnectionSummary[]> {
    const context = await this.context();
    const settings = await this.loadSpaceViewSettings(context);
    const localRecords = this.registry.list().filter((record) =>
      record.spaceId === context.spaceId && (!record.spaceViewId || record.spaceViewId === context.spaceViewId)
    );
    const localById = new Map(localRecords.map((record) => [record.id, record]));
    const linked: Array<{ id: string; spaceId: string; defaultEnabled: boolean }> = [];
    const seen = new Set<string>();
    for (const entry of linkedModules(settings)) {
      const rawEntry = object(entry);
      const pointer = object(rawEntry.pointer);
      const id = asString(pointer.id);
      const spaceId = asString(pointer.spaceId, context.spaceId);
      if (asString(pointer.table) !== "workflow_module" || !id || spaceId !== context.spaceId || seen.has(id)) continue;
      seen.add(id);
      linked.push({ id, spaceId, defaultEnabled: rawEntry.defaultEnabled === true });
    }
    const records = await this.loadSpaceRecords(context, linked.map(({ id, spaceId }) => ({ table: "workflow_module", id, spaceId })));
    const summaries: McpConnectionSummary[] = [];
    for (const link of linked) {
      const record = records.get(`workflow_module:${link.id}`);
      if (!record || asString(record.module_type) !== "mcpServer") continue;
      const recordSpaceId = asString(record.space_id, context.spaceId);
      if (recordSpaceId !== context.spaceId) continue;
      const data = object(record.data);
      const local = localById.get(link.id);
      const remoteToolNames = toolNamesFrom(data.tools);
      const enabledToolNames = storedToolNames(data.enabledToolNames);
      summaries.push({
        id: link.id,
        name: asString(data.name, asString(data.officialName, local?.name ?? link.id)),
        serverUrl: asString(data.serverUrl, local?.serverUrl ?? ""),
        spaceId: context.spaceId,
        spaceViewId: context.spaceViewId,
        authType: local?.authType ?? "unknown",
        transport: asString(data.preferredTransport, local?.transport ?? ""),
        toolNames: remoteToolNames.length > 0 ? remoteToolNames : [...(local?.toolNames ?? [])],
        enabledToolNames: enabledToolNames ?? null,
        runReadToolsAutomatically: data.runReadToolsAutomatically !== false,
        runWriteToolsAutomatically: data.runWriteToolsAutomatically === true,
        createdAt: asIsoTimestamp(record.created_time) ?? local?.createdAt ?? null,
        source: local ? "notion_and_registry" : "notion",
        alive: record.alive === true,
        linked: true,
        defaultEnabled: link.defaultEnabled
      });
      localById.delete(link.id);
    }
    for (const local of localRecords) {
      if (!localById.has(local.id)) continue;
      summaries.push({
        id: local.id,
        name: local.name,
        serverUrl: local.serverUrl,
        spaceId: context.spaceId,
        spaceViewId: context.spaceViewId,
        authType: local.authType,
        transport: local.transport,
        toolNames: [...local.toolNames],
        enabledToolNames: local.enabledToolNames ? [...local.enabledToolNames] : null,
        runReadToolsAutomatically: local.runReadToolsAutomatically !== false,
        runWriteToolsAutomatically: local.runWriteToolsAutomatically === true,
        createdAt: local.createdAt,
        source: "registry_only",
        alive: null,
        linked: false,
        defaultEnabled: false
      });
    }
    return summaries;
  }

  async status(id: string): Promise<JsonObject> {
    const existing = this.registry.get(id);
    const context = await this.context();
    this.assertActiveWorkspace(existing, context);
    const settings = await this.loadSpaceViewSettings(context);
    const moduleRecord = await this.loadSpaceRecord(context, "workflow_module", id);
    if (asString(moduleRecord.module_type) !== "mcpServer") throw new Error(`${id} is not an MCP workflow module`);
    const moduleData = object(moduleRecord.data);
    const connectionPointer = object(moduleData.connectionPointer);
    const connectionId = asString(connectionPointer.id);
    const connectionTable = asString(connectionPointer.table);
    const connectionSpaceId = asString(connectionPointer.spaceId, context.spaceId);
    const alive = moduleRecord.alive === true;
    const linked = linkedModules(settings).some((entry) => linkedModuleId(entry) === id);
    let connectionStatus: "connected" | "needs_reauth" | "needs_setup" | "disconnected" = alive && linked ? "needs_setup" : "disconnected";
    if (alive && linked && connectionId && connectionTable) {
      const externalConnection = await this.loadSpaceRecord(context, connectionTable, connectionId, connectionSpaceId);
      connectionStatus = object(externalConnection.data).authenticated === false ? "needs_reauth" : "connected";
    }
    return {
      moduleId: id,
      spaceId: context.spaceId,
      moduleType: "mcpServer",
      alive,
      linked,
      status: connectionStatus,
      connected: connectionStatus === "connected",
      authType: existing?.authType ?? "unknown",
      transport: asString(moduleData.preferredTransport, existing?.transport ?? ""),
      enabledToolNames: storedToolNames(moduleData.enabledToolNames) ?? null,
      runReadToolsAutomatically: moduleData.runReadToolsAutomatically !== false,
      runWriteToolsAutomatically: moduleData.runWriteToolsAutomatically === true,
      ...(connectionId && connectionTable ? {
        connectionPointer: { table: connectionTable, id: connectionId, spaceId: connectionSpaceId }
      } : {})
    };
  }

  async startOAuth(serverUrl: string, options: StartOAuthOptions | string = {}): Promise<JsonObject> {
    // Accept the old optional name string without forwarding the obsolete field.
    const resolved = typeof options === "string" ? {} : options;
    const normalizedServerUrl = normalizeServerUrl(serverUrl);
    const selectedScopes = normalizeOAuthScopes(resolved.selectedScopes);
    const workflowId = resolved.workflowId?.trim();
    const existingModuleId = resolved.existingModuleId?.trim();
    const suppliedName = resolved.connectionName?.trim();
    if (resolved.workflowId !== undefined && !workflowId) throw new Error("workflowId cannot be empty");
    if (resolved.existingModuleId !== undefined && !existingModuleId) throw new Error("existingModuleId cannot be empty");
    if (resolved.connectionName !== undefined && !suppliedName) throw new Error("connectionName cannot be empty");
    if (suppliedName && suppliedName.length > 500) throw new Error("connectionName must not exceed 500 characters");

    const rawClientId = resolved.userProvidedOAuthClientId;
    const rawClientSecret = resolved.userProvidedOAuthClientSecret;
    if ((rawClientId === undefined) !== (rawClientSecret === undefined)) {
      throw new Error("userProvidedOAuthClientId and userProvidedOAuthClientSecret must be provided together");
    }
    const clientId = rawClientId?.trim();
    if (rawClientId !== undefined && !clientId) throw new Error("userProvidedOAuthClientId cannot be empty");
    if (rawClientSecret !== undefined && !rawClientSecret.trim()) throw new Error("userProvidedOAuthClientSecret cannot be empty");

    const context = await this.context();
    let connectionName = suppliedName ?? new URL(normalizedServerUrl).hostname;
    let transport = normalizeTransport(resolved.transport);
    let runReadToolsAutomatically = resolved.runReadToolsAutomatically ?? true;
    let runWriteToolsAutomatically = resolved.runWriteToolsAutomatically ?? false;
    const enabledToolNames = normalizePendingToolNames(resolved.enabledToolNames);
    if (existingModuleId) {
      const moduleRecord = await this.loadSpaceRecord(context, "workflow_module", existingModuleId);
      const moduleData = object(moduleRecord.data);
      if (moduleRecord.alive !== true || asString(moduleRecord.module_type) !== "mcpServer") {
        throw new Error(`${existingModuleId} is not a live MCP workflow module`);
      }
      if (asString(moduleRecord.space_id, context.spaceId) !== context.spaceId) {
        throw new Error(`${existingModuleId} is not in the active workspace`);
      }
      const currentServerUrl = asString(moduleData.serverUrl);
      if (!currentServerUrl || normalizeServerUrl(currentServerUrl) !== normalizedServerUrl) {
        throw new Error("OAuth reconnect serverUrl must match the existing MCP module");
      }
      const settings = await this.loadSpaceViewSettings(context);
      const linked = linkedModules(settings).some((entry) => {
        const pointer = object(object(entry).pointer);
        return asString(pointer.table) === "workflow_module"
          && asString(pointer.id) === existingModuleId
          && asString(pointer.spaceId, context.spaceId) === context.spaceId;
      });
      if (!linked) throw new Error(`MCP connection ${existingModuleId} is not linked to the current Personal Agent`);
      connectionName = suppliedName ?? asString(moduleData.name, asString(moduleData.officialName, existingModuleId));
      transport = resolved.transport === undefined
        ? normalizeTransport(asString(moduleData.preferredTransport, "streamableHttp"))
        : normalizeTransport(resolved.transport);
      runReadToolsAutomatically = resolved.runReadToolsAutomatically ?? moduleData.runReadToolsAutomatically !== false;
      runWriteToolsAutomatically = resolved.runWriteToolsAutomatically ?? moduleData.runWriteToolsAutomatically === true;
    }

    const integrationId = randomUUID();
    const approvalIntent = resolved.approvalIntent ?? "approve_on_connect";
    const response = await this.api.post("initiateMcpOAuth", {
      serverUrl: normalizedServerUrl,
      spaceId: context.spaceId,
      integrationId,
      ...(workflowId ? { workflowId } : {}),
      ...(selectedScopes ? { selectedScopes } : {}),
      initiationContext: existingModuleId ? "reconnect" : "connect",
      callbackType: "nativeredirect",
      callbackOrigin: ["https:", "", "app.notion.com"].join("/"),
      ...(clientId ? { userProvidedOAuthClientId: clientId } : {}),
      ...(rawClientSecret ? { userProvidedOAuthClientSecret: rawClientSecret } : {}),
      approvalIntent
    });
    const safe = safeOAuthResponse(response, integrationId, rawClientSecret);
    const authorizationUrl = asString(safe.authorizationUrl);
    const oauthFlowId = asString(safe.oauthFlowId);
    if (!authorizationUrl || !oauthFlowId || oauthFlowId.length > MAX_OAUTH_FLOW_ID_LENGTH) {
      throw new Error("Notion OAuth initiation did not return a valid authorizationUrl and oauthFlowId");
    }
    const browserAuthorizationUrl = nativeOAuthBrowserUrl(authorizationUrl);
    const expiresAt = Date.now() + OAUTH_FLOW_TTL_MS;
    this.prunePendingOAuthFlows();
    if (this.pendingOAuthFlows.has(oauthFlowId)) throw new Error("Notion returned a duplicate OAuth flow ID");
    while (this.pendingOAuthFlows.size >= MAX_PENDING_OAUTH_FLOWS) {
      const oldest = this.pendingOAuthFlows.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingOAuthFlows.delete(oldest);
    }
    this.pendingOAuthFlows.set(oauthFlowId, {
      oauthFlowId,
      integrationId,
      ...(asString(safe.completionFlowId) ? { completionFlowId: asString(safe.completionFlowId) } : {}),
      serverUrl: normalizedServerUrl,
      spaceId: context.spaceId,
      spaceViewId: context.spaceViewId,
      connectionName,
      transport,
      ...(enabledToolNames !== undefined ? { enabledToolNames } : {}),
      runReadToolsAutomatically,
      runWriteToolsAutomatically,
      approvalIntent,
      ...(existingModuleId ? { existingModuleId } : {}),
      ...(workflowId ? { workflowId } : {}),
      expiresAt
    });
    return { ...safe, browserAuthorizationUrl, expiresAt: new Date(expiresAt).toISOString() };
  }

  private async loadOAuthReconnectTarget(
    pending: PendingOAuthFlow,
    context: McpContext
  ): Promise<{ moduleRecord: JsonObject; currentData: JsonObject }> {
    const moduleId = pending.existingModuleId;
    if (!moduleId) throw new Error("OAuth reconnect target is missing");
    const moduleRecord = await this.loadSpaceRecord(context, "workflow_module", moduleId);
    const currentData = object(moduleRecord.data);
    let currentServerUrl = "";
    try { currentServerUrl = normalizeServerUrl(asString(currentData.serverUrl)); }
    catch { currentServerUrl = ""; }
    if (moduleRecord.alive !== true
      || asString(moduleRecord.module_type) !== "mcpServer"
      || asString(moduleRecord.space_id, context.spaceId) !== context.spaceId
      || currentServerUrl !== pending.serverUrl) {
      throw new Error(`${moduleId} is no longer a matching live MCP module in the active workspace`);
    }
    const settings = await this.loadSpaceViewSettings(context);
    const linked = linkedModules(settings).some((entry) => {
      const pointer = object(object(entry).pointer);
      return asString(pointer.table) === "workflow_module"
        && asString(pointer.id) === moduleId
        && asString(pointer.spaceId, context.spaceId) === context.spaceId;
    });
    if (!linked) throw new Error(`MCP connection ${moduleId} is no longer linked to the current Personal Agent`);
    return { moduleRecord, currentData };
  }

  private async persistCompletedOAuth(
    pending: PendingOAuthFlow,
    connectionId: string,
    context: McpContext,
    options: CompleteOAuthOptions
  ): Promise<JsonObject> {
    if (pending.workflowId) {
      throw new Error("CLI OAuth completion currently supports Personal Agent modules only; complete workflow-scoped OAuth in Notion");
    }
    const suppliedName = options.connectionName?.trim();
    if (options.connectionName !== undefined && !suppliedName) throw new Error("connectionName cannot be empty");
    if (suppliedName && suppliedName.length > 500) throw new Error("connectionName must not exceed 500 characters");
    const name = suppliedName ?? pending.connectionName;
    const transport = options.transport === undefined ? pending.transport : normalizeTransport(options.transport);
    const requestedTools = options.enabledToolNames !== undefined
      ? (options.enabledToolNames === null ? null : normalizePendingToolNames(options.enabledToolNames))
      : pending.enabledToolNames;
    const runReadToolsAutomatically = options.runReadToolsAutomatically ?? pending.runReadToolsAutomatically;
    const runWriteToolsAutomatically = options.runWriteToolsAutomatically ?? pending.runWriteToolsAutomatically;
    // Reconnect capabilities must not be validated for a target that is already stale.
    if (pending.existingModuleId) await this.loadOAuthReconnectTarget(pending, context);
    const validation = await this.validateInContext(
      context,
      pending.serverUrl,
      undefined,
      pending.approvalIntent,
      connectionId
    );
    const toolList = Array.isArray(validation.tools) ? validation.tools as unknown[] : [];
    const enabledToolNames = Array.isArray(requestedTools)
      ? normalizeEnabledToolNames(requestedTools, toolNamesFrom(toolList))
      : undefined;
    const authHeaders: McpHeader[] = [{ name: OAUTH_CONNECTION_HEADER, value: connectionId }];

    if (pending.existingModuleId) {
      const moduleId = pending.existingModuleId;
      // Validate again after the external capability probe to close the reconnect race before writes.
      const { moduleRecord, currentData } = await this.loadOAuthReconnectTarget(pending, context);
      const data: JsonObject = {
        ...currentData,
        id: moduleId,
        name,
        serverUrl: pending.serverUrl,
        preferredTransport: transport,
        ...(toolList.length > 0 ? { tools: toolList } : {}),
        ...(enabledToolNames !== undefined ? { enabledToolNames: persistedToolNames(enabledToolNames) } : {}),
        runReadToolsAutomatically,
        runWriteToolsAutomatically
      };
      if (requestedTools === null) delete data.enabledToolNames;
      await this.api.post("saveTransactionsFanout", this.moduleDataTransaction(moduleId, context.spaceId, data));
      try {
        await this.api.post("postWorkflowsMcpServerConnect", {
          integrationId: moduleId,
          spaceId: context.spaceId,
          authHeaders,
          initiationContext: "reconnect",
          approvalIntent: pending.approvalIntent
        });
      } catch (error) {
        await this.api.post("saveTransactionsFanout", this.moduleDataTransaction(moduleId, context.spaceId, currentData)).catch(() => undefined);
        throw error;
      }
      const existing = this.registry.get(moduleId);
      const recordTools = toolNamesFrom(data.tools);
      const storedEnabled = storedToolNames(data.enabledToolNames);
      const record: McpConnectionRecord = {
        id: moduleId,
        name,
        serverUrl: pending.serverUrl,
        spaceId: context.spaceId,
        spaceViewId: context.spaceViewId,
        authType: "oauth",
        transport,
        toolNames: recordTools.length > 0 ? recordTools : [...(existing?.toolNames ?? [])],
        ...(storedEnabled !== undefined ? { enabledToolNames: storedEnabled } : {}),
        runReadToolsAutomatically,
        runWriteToolsAutomatically,
        createdAt: existing?.createdAt ?? asIsoTimestamp(moduleRecord.created_time) ?? new Date().toISOString()
      };
      this.registry.upsert(record);
      return { status: "connected", reconnected: true, ...record };
    }

    // The current Notion client allocates the workflow_module only after OAuth succeeds.
    // The initiation integration ID belongs to the OAuth flow and is not reused as the module ID.
    const moduleId = randomUUID();
    const input: AddConnectionInput = {
      name,
      serverUrl: pending.serverUrl,
      auth: { type: "oauth" },
      transport,
      ...(enabledToolNames !== undefined ? { enabledToolNames } : {}),
      runReadToolsAutomatically,
      runWriteToolsAutomatically,
      approvalIntent: pending.approvalIntent
    };
    await this.api.post("saveTransactionsFanout", this.buildCreateTransaction(moduleId, context, input, toolList));
    try {
      await this.api.post("postWorkflowsMcpServerConnect", {
        integrationId: moduleId,
        spaceId: context.spaceId,
        authHeaders,
        initiationContext: "connect",
        approvalIntent: pending.approvalIntent
      });
      const settings = await this.loadSpaceViewSettings(context);
      await this.api.post("saveTransactionsFanout", this.settingsTransaction(context, settings, moduleId, true));
    } catch (error) {
      await this.deactivateAndUnlink(moduleId, context).catch(() => undefined);
      throw error;
    }
    const record: McpConnectionRecord = {
      id: moduleId,
      name,
      serverUrl: pending.serverUrl,
      spaceId: context.spaceId,
      spaceViewId: context.spaceViewId,
      authType: "oauth",
      transport,
      toolNames: toolNamesFrom(toolList),
      ...(enabledToolNames !== undefined ? { enabledToolNames: [...enabledToolNames] } : {}),
      runReadToolsAutomatically,
      runWriteToolsAutomatically,
      createdAt: new Date().toISOString()
    };
    try { this.registry.upsert(record); }
    catch (error) {
      await this.deactivateAndUnlink(moduleId, context).catch(() => undefined);
      throw error;
    }
    return { status: "connected", reconnected: false, ...record };
  }

  async completeOAuth(oauthFlowId: string, options: CompleteOAuthOptions = {}): Promise<JsonObject> {
    const flowId = oauthFlowId.trim();
    if (!flowId) throw new Error("oauthFlowId is required");
    const waitSeconds = options.waitSeconds ?? 0;
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) {
      throw new Error("waitSeconds must be an integer from 0 to 60");
    }
    this.prunePendingOAuthFlows();
    const pending = this.pendingOAuthFlows.get(flowId);
    if (!pending) throw new Error("OAuth flow is unknown or expired; restart OAuth in the same MCP server process");
    if (pending.workflowId) {
      throw new Error("CLI OAuth completion currently supports Personal Agent modules only; complete workflow-scoped OAuth in Notion");
    }
    if (this.completingOAuthFlows.has(flowId)) throw new Error("OAuth flow completion is already in progress");

    // Claim the flow before awaiting context so simultaneous callers cannot both pass the guard.
    this.completingOAuthFlows.add(flowId);
    try {
      const context = await this.context();
      if (context.spaceId !== pending.spaceId || context.spaceViewId !== pending.spaceViewId) {
        throw new Error("OAuth flow belongs to a different active workspace; switch back before completing it");
      }
      const deadline = Date.now() + waitSeconds * 1_000;
      while (true) {
        if (Date.now() >= pending.expiresAt) {
          this.pendingOAuthFlows.delete(flowId);
          throw new Error("OAuth flow expired; restart OAuth");
        }
        const response = await this.api.post("getMcpOAuthFlowResult", {
          flowId,
          spaceId: context.spaceId
        });
        const status = asString(response.status);
        if (status === "pending") {
          const now = Date.now();
          if (now >= pending.expiresAt) {
            this.pendingOAuthFlows.delete(flowId);
            throw new Error("OAuth flow expired; restart OAuth");
          }
          if (now >= deadline) {
            return {
              status: "pending",
              oauthFlowId: flowId,
              retryAfterSeconds: OAUTH_POLL_INTERVAL_MS / 1_000,
              expiresAt: new Date(pending.expiresAt).toISOString()
            };
          }
          await sleep(Math.min(
            OAUTH_POLL_INTERVAL_MS,
            Math.max(1, deadline - now),
            Math.max(1, pending.expiresAt - now)
          ));
          continue;
        }
        if (status === "failed") {
          this.pendingOAuthFlows.delete(flowId);
          throw new Error(`OAuth authorization failed: ${oauthFailureMessage(response.error)}`);
        }
        if (status !== "completed") {
          throw new Error(`Unexpected OAuth flow status: ${status || "missing"}`);
        }
        const connectionId = asString(response.connectionId).trim();
        if (!connectionId
          || connectionId.length > MAX_OAUTH_CONNECTION_ID_LENGTH
          || /[\u0000-\u001f\u007f]/u.test(connectionId)) {
          throw new Error("Completed OAuth flow did not return a valid connectionId");
        }
        const connected = await this.persistCompletedOAuth(pending, connectionId, context, options);
        this.pendingOAuthFlows.delete(flowId);
        return connected;
      }
    } finally {
      this.completingOAuthFlows.delete(flowId);
    }
  }

  private async loadPreconfiguredCatalog(): Promise<PreconfiguredMcpServer[]> {
    const { spaceId } = await this.context();
    const response = await this.api.post("getPreconfiguredMcpServers", { spaceId });
    return sanitizePreconfiguredCatalog(response);
  }

  async listPreconfigured(): Promise<JsonObject> {
    return { servers: await this.loadPreconfiguredCatalog() };
  }

  async connectPreconfigured(
    preconfiguredServerId: string,
    options: ConnectPreconfiguredOptions = {}
  ): Promise<JsonObject> {
    const requestedId = preconfiguredServerId.trim();
    if (!requestedId) throw new Error("preconfiguredServerId is required");
    const server = (await this.loadPreconfiguredCatalog()).find(({ id }) => id === requestedId);
    if (!server) throw new Error(`Preconfigured MCP server not found or hidden: ${requestedId}`);
    if (server.visibility !== "enabled") throw new Error(`${server.name} is disabled in the current workspace`);
    const serverUrl = resolvePreconfiguredServerUrl(server, options);
    const oauthSchemes = server.supportedAuthSchemes.filter((scheme) => scheme.startsWith("oauth_"));
    const wantsOAuth = options.auth?.type === "oauth" || (options.auth === undefined && oauthSchemes.length > 0);
    if (wantsOAuth) {
      if (oauthSchemes.length === 0) {
        throw new Error(`${server.name} does not advertise OAuth; supported methods: ${server.supportedAuthSchemes.join(", ") || "none"}`);
      }
      const selectedScopes = options.selectedScopes ?? (server.supportedOAuthScopes.length > 0 ? server.supportedOAuthScopes : undefined);
      const flow = await this.startOAuth(serverUrl, {
        connectionName: server.name,
        approvalIntent: server.mcpApprovalIntent ?? "approve_on_connect",
        ...(options.transport !== undefined ? { transport: options.transport } : {}),
        ...(options.enabledToolNames !== undefined ? { enabledToolNames: options.enabledToolNames } : {}),
        ...(options.runReadToolsAutomatically !== undefined ? { runReadToolsAutomatically: options.runReadToolsAutomatically } : {}),
        ...(options.runWriteToolsAutomatically !== undefined ? { runWriteToolsAutomatically: options.runWriteToolsAutomatically } : {}),
        ...(selectedScopes !== undefined ? { selectedScopes } : {}),
        ...(options.userProvidedOAuthClientId !== undefined ? { userProvidedOAuthClientId: options.userProvidedOAuthClientId } : {}),
        ...(options.userProvidedOAuthClientSecret !== undefined ? { userProvidedOAuthClientSecret: options.userProvidedOAuthClientSecret } : {})
      });
      return {
        status: "oauth_authorization_required",
        preconfiguredServer: { id: server.id, name: server.name, serverUrl, supportedAuthSchemes: server.supportedAuthSchemes },
        ...flow
      };
    }
    if (!options.auth) {
      throw new Error(`${server.name} requires an explicit auth choice; supported methods: ${server.supportedAuthSchemes.join(", ") || "none"}`);
    }
    const connected = await this.add({
      name: server.name,
      serverUrl,
      auth: options.auth,
      ...(options.transport !== undefined ? { transport: options.transport } : {}),
      ...(options.enabledToolNames !== undefined ? { enabledToolNames: options.enabledToolNames } : {}),
      ...(options.runReadToolsAutomatically !== undefined ? { runReadToolsAutomatically: options.runReadToolsAutomatically } : {}),
      ...(options.runWriteToolsAutomatically !== undefined ? { runWriteToolsAutomatically: options.runWriteToolsAutomatically } : {}),
      ...(server.mcpApprovalIntent ? { approvalIntent: server.mcpApprovalIntent } : {})
    });
    return { status: "connected", preconfiguredServerId: server.id, ...connected };
  }
}
