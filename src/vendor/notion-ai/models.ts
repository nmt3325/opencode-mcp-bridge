// Model catalog extracted from the Notion web bundle model registry.
// Regenerate with scripts/extract-models.md when Notion ships new models.

export interface ModelInfo {
  modelId: string;
  displayName: string;
  displayNameWithProvider: string;
  family: string;
  group: string;
  pickable: boolean;
}

export const MODEL_CATALOG: ModelInfo[] = [
  { modelId: "openai-gpt-4o", displayName: "GPT-4o", displayNameWithProvider: "OpenAI GPT-4o", family: "openai", group: "fast", pickable: false },
  { modelId: "openai-gpt-4o-mini", displayName: "GPT-4o mini", displayNameWithProvider: "OpenAI GPT-4o mini", family: "openai", group: "fast", pickable: false },
  { modelId: "openai-turbo", displayName: "GPT-5", displayNameWithProvider: "OpenAI GPT-5", family: "openai", group: "fast", pickable: false },
  { modelId: "openai-gpt-4.1", displayName: "GPT-4.1", displayNameWithProvider: "OpenAI GPT-4.1", family: "openai", group: "fast", pickable: false },
  { modelId: "openai-gpt-4.1-mini", displayName: "GPT-4.1 Mini", displayNameWithProvider: "OpenAI GPT-4.1 Mini", family: "openai", group: "fast", pickable: false },
  { modelId: "openai-gpt-5-mini", displayName: "GPT-5 Mini", displayNameWithProvider: "OpenAI GPT-5 Mini", family: "openai", group: "fast", pickable: false },
  { modelId: "openai-gpt-5-nano", displayName: "GPT-5 Nano", displayNameWithProvider: "OpenAI GPT-5 Nano", family: "openai", group: "fast", pickable: false },
  { modelId: "openai-turbo-thinking", displayName: "GPT-5 with thinking", displayNameWithProvider: "OpenAI GPT-5 with thinking", family: "openai", group: "intelligent", pickable: false },
  { modelId: "openai-turbo-minimal-thinking", displayName: "GPT-5 + minimal CoT", displayNameWithProvider: "OpenAI GPT-5 + minimal CoT", family: "openai", group: "fast", pickable: false },
  { modelId: "openai-turbo-10", displayName: "GPT-5 + juice@10", displayNameWithProvider: "OpenAI GPT-5 + juice@10", family: "openai", group: "fast", pickable: false },
  { modelId: "openai-turbo-8", displayName: "GPT-5 + juice@8", displayNameWithProvider: "OpenAI GPT-5 + juice@8", family: "openai", group: "fast", pickable: false },
  { modelId: "orange-tart", displayName: "GPT-5.1", displayNameWithProvider: "OpenAI GPT-5.1", family: "openai", group: "fast", pickable: false },
  { modelId: "opal-quince", displayName: "GPT-5.5", displayNameWithProvider: "OpenAI GPT-5.5", family: "openai", group: "intelligent", pickable: true },
  { modelId: "opal-quince-medium", displayName: "GPT-5.5", displayNameWithProvider: "OpenAI GPT-5.5", family: "openai", group: "intelligent", pickable: true },
  { modelId: "opal-quince-high", displayName: "GPT-5.5 High", displayNameWithProvider: "OpenAI GPT-5.5 High", family: "openai", group: "intelligent", pickable: true },
  { modelId: "oatmeal-cookie", displayName: "GPT 5.2", displayNameWithProvider: "GPT 5.2", family: "openai", group: "fast", pickable: true },
  { modelId: "oatmeal-cookie-medium-thinking", displayName: "GPT-5.2 Medium", displayNameWithProvider: "OpenAI GPT-5.2 Medium", family: "openai", group: "fast", pickable: true },
  { modelId: "oatmeal-cookie-high-thinking", displayName: "GPT-5.2 High", displayNameWithProvider: "OpenAI GPT-5.2 High", family: "openai", group: "fast", pickable: true },
  { modelId: "oval-kumquat", displayName: "GPT-5.4", displayNameWithProvider: "OpenAI GPT-5.4", family: "openai", group: "fast", pickable: true },
  { modelId: "oval-kumquat-medium", displayName: "GPT-5.4", displayNameWithProvider: "OpenAI GPT-5.4", family: "openai", group: "fast", pickable: true },
  { modelId: "oval-kumquat-high", displayName: "GPT-5.4 High", displayNameWithProvider: "OpenAI GPT-5.4 High", family: "openai", group: "fast", pickable: true },
  { modelId: "oregon-grape-low", displayName: "GPT-5.4 Mini Low", displayNameWithProvider: "OpenAI GPT-5.4 Mini Low", family: "openai", group: "fast", pickable: true },
  { modelId: "oregon-grape-medium", displayName: "GPT-5.4 Mini", displayNameWithProvider: "OpenAI GPT-5.4 Mini", family: "openai", group: "fast", pickable: true },
  { modelId: "oregon-grape-high", displayName: "GPT-5.4 Mini High", displayNameWithProvider: "OpenAI GPT-5.4 Mini High", family: "openai", group: "fast", pickable: true },
  { modelId: "otaheite-apple-low", displayName: "GPT-5.4 Nano Low", displayNameWithProvider: "OpenAI GPT-5.4 Nano Low", family: "openai", group: "fast", pickable: true },
  { modelId: "otaheite-apple-medium", displayName: "GPT-5.4 Nano", displayNameWithProvider: "OpenAI GPT-5.4 Nano", family: "openai", group: "fast", pickable: true },
  { modelId: "otaheite-apple-high", displayName: "GPT-5.4 Nano High", displayNameWithProvider: "OpenAI GPT-5.4 Nano High", family: "openai", group: "fast", pickable: true },
  { modelId: "orange-mousse", displayName: "GPT-5.6 Sol", displayNameWithProvider: "OpenAI GPT-5.6 Sol", family: "openai", group: "intelligent", pickable: true },
  { modelId: "orchid-muffin", displayName: "GPT-5.6 Terra", displayNameWithProvider: "OpenAI GPT-5.6 Terra", family: "openai", group: "intelligent", pickable: true },
  { modelId: "olive-jellyroll", displayName: "GPT-5.6 Luna", displayNameWithProvider: "OpenAI GPT-5.6 Luna", family: "openai", group: "fast", pickable: true },
  { modelId: "anthropic-sonnet-4", displayName: "Claude 4 Sonnet", displayNameWithProvider: "Anthropic Claude 4 Sonnet", family: "anthropic", group: "fast", pickable: false },
  { modelId: "anthropic-sonnet-3.7", displayName: "Claude 3.7 Sonnet", displayNameWithProvider: "Anthropic Claude 3.7 Sonnet", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "anthropic-sonnet-3.7-thinking", displayName: "Claude 3.7 Sonnet with thinking", displayNameWithProvider: "Anthropic Claude 3.7 Sonnet with thinking", family: "anthropic", group: "intelligent", pickable: false },
  { modelId: "anthropic-opus", displayName: "Claude Opus 3", displayNameWithProvider: "Anthropic Claude Opus 3", family: "anthropic", group: "intelligent", pickable: false },
  { modelId: "anthropic-sonnet-4-thinking", displayName: "Claude 4 Sonnet with thinking", displayNameWithProvider: "Anthropic Claude 4 Sonnet with thinking", family: "anthropic", group: "intelligent", pickable: false },
  { modelId: "anthropic-opus-4", displayName: "Claude 4 Opus", displayNameWithProvider: "Anthropic Claude 4 Opus", family: "anthropic", group: "fast", pickable: false },
  { modelId: "anthropic-opus-4-thinking", displayName: "Claude 4 Opus with thinking", displayNameWithProvider: "Anthropic Claude 4 Opus with thinking", family: "anthropic", group: "intelligent", pickable: false },
  { modelId: "anthropic-opus-4.1", displayName: "Claude 4.1 Opus", displayNameWithProvider: "Anthropic Claude 4.1 Opus", family: "anthropic", group: "fast", pickable: false },
  { modelId: "anthropic-opus-4.1-thinking", displayName: "Claude 4.1 Opus with thinking", displayNameWithProvider: "Anthropic Claude 4.1 Opus with thinking", family: "anthropic", group: "intelligent", pickable: false },
  { modelId: "anthropic-sonnet-alt", displayName: "Claude Sonnet (dev only)", displayNameWithProvider: "Anthropic Claude Sonnet (dev only)", family: "anthropic", group: "fast", pickable: false },
  { modelId: "anthropic-sonnet-alt-no-thinking", displayName: "Claude Sonnet 4.5 no thinking", displayNameWithProvider: "Anthropic Claude Sonnet 4.5 no thinking", family: "anthropic", group: "fast", pickable: false },
  { modelId: "anthropic-sonnet-alt-thinking", displayName: "Claude Sonnet (dev only) with thinking", displayNameWithProvider: "Anthropic Claude Sonnet (dev only) with thinking", family: "anthropic", group: "intelligent", pickable: false },
  { modelId: "anthropic-haiku-4.5", displayName: "Claude Haiku 4.5", displayNameWithProvider: "Anthropic Claude Haiku 4.5", family: "anthropic", group: "fast", pickable: false },
  { modelId: "anthropic-haiku-4.5-thinking", displayName: "Claude Haiku 4.5 with thinking", displayNameWithProvider: "Anthropic Claude Haiku 4.5 with thinking", family: "anthropic", group: "intelligent", pickable: false },
  { modelId: "almond-croissant-high", displayName: "Sonnet 4.6 (High)", displayNameWithProvider: "Sonnet 4.6 (High)", family: "anthropic", group: "intelligent", pickable: false },
  { modelId: "almond-croissant-low", displayName: "Sonnet 4.6 (Low)", displayNameWithProvider: "Sonnet 4.6 (Low)", family: "anthropic", group: "fast", pickable: true },
  { modelId: "apple-danish", displayName: "Claude Opus 4.5", displayNameWithProvider: "Anthropic Claude Opus 4.5", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "ambrosia-tart-high", displayName: "Opus 4.8 (High)", displayNameWithProvider: "Anthropic Claude Opus 4.8 (High)", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "apricot-sorbet-x-high", displayName: "Opus 4.7 (X-High)", displayNameWithProvider: "Anthropic Claude Opus 4.7 (X-High)", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "apricot-sorbet-max", displayName: "Opus 4.7 (Max)", displayNameWithProvider: "Anthropic Claude Opus 4.7 (Max)", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "apricot-sorbet-high", displayName: "Opus 4.7 (High)", displayNameWithProvider: "Anthropic Claude Opus 4.7 (High)", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "apricot-sorbet-medium", displayName: "Opus 4.7 (Medium)", displayNameWithProvider: "Anthropic Claude Opus 4.7 (Medium)", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "apricot-sorbet-low", displayName: "Opus 4.7 (Low)", displayNameWithProvider: "Anthropic Claude Opus 4.7 (Low)", family: "anthropic", group: "fast", pickable: true },
  { modelId: "acai-budino-high", displayName: "Fable 5", displayNameWithProvider: "Anthropic Claude Fable 5", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "agave-flan", displayName: "Opus 5", displayNameWithProvider: "Anthropic Claude Opus 5", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "avocado-froyo-medium", displayName: "Opus 4.6 (Medium)", displayNameWithProvider: "Opus 4.6 (Medium)", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "angel-cake-high", displayName: "Sonnet 5", displayNameWithProvider: "Anthropic Claude Sonnet 5", family: "anthropic", group: "intelligent", pickable: true },
  { modelId: "angel-cake-medium", displayName: "Sonnet 5", displayNameWithProvider: "Anthropic Claude Sonnet 5", family: "anthropic", group: "intelligent", pickable: false },
  { modelId: "angel-cake-low", displayName: "Sonnet 5 (Low)", displayNameWithProvider: "Anthropic Claude Sonnet 5 (Low)", family: "anthropic", group: "intelligent", pickable: false },
  { modelId: "angel-cake-none", displayName: "Sonnet 5 (No Thinking)", displayNameWithProvider: "Anthropic Claude Sonnet 5 (No Thinking)", family: "anthropic", group: "fast", pickable: false },
  { modelId: "gemini-pro", displayName: "Gemini 2.5 Pro", displayNameWithProvider: "Google Gemini 2.5 Pro", family: "gemini", group: "intelligent", pickable: false },
  { modelId: "gemini-flash", displayName: "Gemini 2.5 Flash", displayNameWithProvider: "Google Gemini 2.5 Flash", family: "gemini", group: "fast", pickable: false },
  { modelId: "gingerbread", displayName: "Gemini 3 Flash", displayNameWithProvider: "Google Gemini 3 Flash", family: "gemini", group: "fast", pickable: false },
  { modelId: "vertex-gemini-3.5-flash", displayName: "Gemini 3.5 Flash", displayNameWithProvider: "Google Gemini 3.5 Flash", family: "gemini", group: "fast", pickable: true },
  { modelId: "galette-medium-thinking", displayName: "Gemini 3.1 Pro", displayNameWithProvider: "Google Gemini 3.1 Pro", family: "gemini", group: "intelligent", pickable: true },
  { modelId: "fireworks-kimi-k2.6", displayName: "Kimi K2.6", displayNameWithProvider: "Fireworks Kimi K2.6", family: "kimi", group: "intelligent", pickable: true },
  { modelId: "fireworks-kimi-k2.7", displayName: "Kimi K2.7 Code", displayNameWithProvider: "Fireworks Kimi K2.7 Code", family: "kimi", group: "intelligent", pickable: true },
  { modelId: "fireworks-kimi-k3", displayName: "Kimi K3", displayNameWithProvider: "Fireworks Kimi K3", family: "kimi", group: "intelligent", pickable: true },
  { modelId: "cinder-kite", displayName: "Engram 1", displayNameWithProvider: "Engram 1", family: "engram", group: "fast", pickable: false },
  { modelId: "xigua-mochi-medium", displayName: "Grok 4.3", displayNameWithProvider: "SpaceXAI Grok 4.3", family: "xai", group: "intelligent", pickable: true },
  { modelId: "xinomavro-cake", displayName: "Grok Build 0.1", displayNameWithProvider: "SpaceXAI Grok Build 0.1", family: "xai", group: "intelligent", pickable: true },
  { modelId: "strawberry-whoopiepie", displayName: "Grok 4.5", displayNameWithProvider: "SpaceXAI Grok 4.5", family: "xai", group: "intelligent", pickable: true },
  { modelId: "baseten-deepseek-v4-pro", displayName: "DeepSeek V4 Pro", displayNameWithProvider: "DeepSeek V4 Pro", family: "deepseek", group: "intelligent", pickable: true },
  { modelId: "baseten-glm-5.2", displayName: "GLM 5.2", displayNameWithProvider: "Baseten GLM 5.2", family: "glm", group: "intelligent", pickable: true }
];

export const KNOWN_MODEL_IDS: string[] = MODEL_CATALOG.map((entry) => entry.modelId);

/** Stable, human friendly tiers that stay valid even when Notion renames a model. */
export const BUILTIN_ALIASES: Record<string, string> = {
  fast: "almond-croissant-low",
  default: "almond-croissant-low",
  "notion-fast": "almond-croissant-low",
  standard: "almond-croissant-high",
  balanced: "almond-croissant-high",
  "notion-standard": "almond-croissant-high",
  thinking: "oatmeal-cookie",
  reasoning: "oatmeal-cookie",
  deep: "oatmeal-cookie",
  "notion-thinking": "oatmeal-cookie",
  "opus-4.6": "avocado-froyo-medium",
  "claude-opus-4.6": "avocado-froyo-medium",
  "sonnet-4.6": "almond-croissant-low",
  "claude-sonnet-4.6": "almond-croissant-low",
  "gpt-5.2": "oatmeal-cookie",
  "gpt-5.4": "oval-kumquat-medium",
  "gemini-2.5-flash": "vertex-gemini-2.5-flash",
  "gemini-3-flash": "gingerbread"
};

export function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}

function addAlias(target: Record<string, string>, alias: string, modelId: string): void {
  const key = normalizeKey(alias);
  if (!key || key in target) return;
  target[key] = modelId;
}

/** Vendor names taken straight from the Notion model registry, e.g. "gpt-5.2" or "sonnet-4.6-low". */
export function catalogAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const entry of MODEL_CATALOG) {
    addAlias(aliases, entry.modelId, entry.modelId);
    addAlias(aliases, entry.displayName, entry.modelId);
    addAlias(aliases, entry.displayNameWithProvider, entry.modelId);
    addAlias(aliases, entry.displayName.replace(/[()]/g, ""), entry.modelId);
    addAlias(aliases, entry.displayNameWithProvider.replace(/^(OpenAI|Anthropic|Google|Notion)\s+/i, "").replace(/[()]/g, ""), entry.modelId);
  }
  return aliases;
}

export function envAliases(): Record<string, string> {
  const raw = process.env.NOTION_MODEL_ALIASES;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const aliases: Record<string, string> = {};
    for (const [alias, modelId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof modelId === "string" && modelId.trim()) aliases[normalizeKey(alias)] = modelId.trim();
    }
    return aliases;
  } catch {
    return {};
  }
}

export function modelAliases(): Record<string, string> {
  return { ...catalogAliases(), ...BUILTIN_ALIASES, ...envAliases() };
}

/** Accepts an internal ID, a vendor name, or a tier alias; unknown values pass through untouched. */
export function normalizeModelName(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return fallback.trim() ? normalizeModelName(fallback, "almond-croissant-low") : "almond-croissant-low";
  const aliases = modelAliases();
  return aliases[normalizeKey(raw)] ?? raw;
}

export function listModels(): Array<{ modelId: string; displayName: string; family: string; group: string; pickable: boolean; aliases: string[] }> {
  const aliases = modelAliases();
  const byModel = new Map<string, string[]>();
  for (const [alias, modelId] of Object.entries(aliases)) {
    if (alias === modelId) continue;
    byModel.set(modelId, [...(byModel.get(modelId) ?? []), alias]);
  }
  const known = MODEL_CATALOG.map((entry) => ({ ...entry, aliases: (byModel.get(entry.modelId) ?? []).sort() }));
  const extra = [...byModel.keys()].filter((modelId) => !KNOWN_MODEL_IDS.includes(modelId));
  return [
    ...known,
    ...extra.map((modelId) => ({ modelId, displayName: modelId, displayNameWithProvider: modelId, family: "unknown", group: "unknown", pickable: false, aliases: (byModel.get(modelId) ?? []).sort() }))
  ];
}

/** Effort tiers accepted by the current Notion thread config (`reasoningEffort`). */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelReasoningEfforts {
  supported: ReasoningEffort[];
  default: ReasoningEffort;
}

const MEDIUM_HIGH: ReasoningEffort[] = ["medium", "high"];
const LOW_TO_MAX: ReasoningEffort[] = ["low", "medium", "high", "max"];
const LOW_TO_HIGH: ReasoningEffort[] = ["low", "medium", "high"];
const NONE_TO_MAX: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

/**
 * `modelConfiguration.supportedReasoningEfforts` / `defaultReasoningEffort` taken from the Notion
 * web bundle model registry. Models missing here render no effort picker in the Notion UI.
 */
export const MODEL_REASONING_EFFORTS: Record<string, ModelReasoningEfforts> = {
  "opal-quince": { supported: MEDIUM_HIGH, default: "medium" },
  "opal-quince-medium": { supported: MEDIUM_HIGH, default: "medium" },
  "opal-quince-high": { supported: MEDIUM_HIGH, default: "high" },
  "oatmeal-cookie": { supported: MEDIUM_HIGH, default: "medium" },
  "oatmeal-cookie-medium-thinking": { supported: MEDIUM_HIGH, default: "medium" },
  "oatmeal-cookie-high-thinking": { supported: MEDIUM_HIGH, default: "high" },
  "oval-kumquat": { supported: MEDIUM_HIGH, default: "medium" },
  "oval-kumquat-medium": { supported: MEDIUM_HIGH, default: "medium" },
  "oval-kumquat-high": { supported: MEDIUM_HIGH, default: "high" },
  "orange-mousse": { supported: NONE_TO_MAX, default: "medium" },
  "orchid-muffin": { supported: NONE_TO_MAX, default: "medium" },
  "olive-jellyroll": { supported: NONE_TO_MAX, default: "medium" },
  "almond-croissant-max": { supported: LOW_TO_MAX, default: "max" },
  "almond-croissant-high": { supported: LOW_TO_MAX, default: "high" },
  "almond-croissant-medium": { supported: LOW_TO_MAX, default: "medium" },
  "almond-croissant-low": { supported: LOW_TO_MAX, default: "low" },
  "ambrosia-tart-max": { supported: LOW_TO_MAX, default: "max" },
  "ambrosia-tart-high": { supported: LOW_TO_MAX, default: "high" },
  "ambrosia-tart-medium": { supported: LOW_TO_MAX, default: "medium" },
  "ambrosia-tart-low": { supported: LOW_TO_MAX, default: "low" },
  "acai-budino-high": { supported: LOW_TO_MAX, default: "high" },
  "agave-flan": { supported: LOW_TO_MAX, default: "medium" },
  "vertex-gemini-3.5-flash": { supported: LOW_TO_HIGH, default: "low" },
  "grapefruit-zeppole": { supported: LOW_TO_HIGH, default: "medium" }
};

const EFFORT_ALIASES: Record<string, ReasoningEffort> = {
  none: "none",
  off: "none",
  disabled: "none",
  "no-thinking": "none",
  minimal: "minimal",
  min: "minimal",
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  "extra-high": "xhigh",
  "very-high": "xhigh",
  max: "max",
  maximum: "max"
};

/** Registry effort configuration for one internal model ID, when Notion exposes an effort picker. */
export function modelReasoningEfforts(modelId: string): ModelReasoningEfforts | undefined {
  return MODEL_REASONING_EFFORTS[modelId];
}

/**
 * Resolves a requested effort against the model registry. Returns undefined when no effort was
 * requested so the transcript config stays byte-identical to the current Notion web client.
 */
export function normalizeReasoningEffort(modelId: string, value: string | undefined): ReasoningEffort | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  const effort = EFFORT_ALIASES[normalizeKey(raw)];
  if (!effort) throw new Error(`Unknown reasoningEffort "${raw}". Supported values: ${REASONING_EFFORTS.join(", ")}`);
  const config = MODEL_REASONING_EFFORTS[modelId];
  if (!config) {
    if (KNOWN_MODEL_IDS.includes(modelId)) {
      throw new Error(`Model ${modelId} has no reasoningEffort picker in the Notion model registry; omit reasoningEffort or pick a model that has one, such as oatmeal-cookie, oval-kumquat-medium, or almond-croissant-low`);
    }
    return effort;
  }
  if (!config.supported.includes(effort)) {
    throw new Error(`Model ${modelId} does not support reasoningEffort "${effort}". Supported: ${config.supported.join(", ")} (default ${config.default})`);
  }
  return effort;
}
