export const CLAUDE_MODELS = [
  { id: "opus", name: "Opus", version: "4.6" },
  { id: "sonnet", name: "Sonnet", version: "4.6" },
  { id: "haiku", name: "Haiku", version: "4.5" },
]

export type CodexThinkingLevel = "low" | "medium" | "high" | "xhigh"

export const CODEX_MODELS = [
  {
    id: "gpt-5.3-codex",
    name: "Codex 5.3",
    thinkings: ["low", "medium", "high", "xhigh"] as CodexThinkingLevel[],
  },
  {
    id: "gpt-5.2-codex",
    name: "Codex 5.2",
    thinkings: ["low", "medium", "high", "xhigh"] as CodexThinkingLevel[],
  },
  {
    id: "gpt-5.1-codex-max",
    name: "Codex 5.1 Max",
    thinkings: ["low", "medium", "high", "xhigh"] as CodexThinkingLevel[],
  },
  {
    id: "gpt-5.1-codex-mini",
    name: "Codex 5.1 Mini",
    thinkings: ["medium", "high"] as CodexThinkingLevel[],
  },
]

export function formatCodexThinkingLabel(thinking: CodexThinkingLevel): string {
  if (thinking === "xhigh") return "Extra High"
  return thinking.charAt(0).toUpperCase() + thinking.slice(1)
}

/**
 * opencode is a provider-agnostic agent — it routes to whatever model the
 * user has configured via `opencode auth` / `~/.opencode`. From 1code's
 * perspective it's a single "provider" with one placeholder model entry,
 * since model selection happens inside opencode itself.
 *
 * Walking-skeleton note: if/when 1code adds a real opencode model picker,
 * this can become a proper list populated from opencode's `/provider`
 * HTTP endpoint.
 */
export const OPENCODE_MODELS = [
  { id: "opencode", name: "opencode", version: "default" },
] as const
