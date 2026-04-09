import { expect, test } from "bun:test"
import {
  buildOpenCodeCatalog,
  parseOpenCodeModelId,
  pickDefaultOpenCodeModel,
} from "../src/shared/opencode-catalog"

test("parses OpenCode model ids into provider and model parts", () => {
  expect(parseOpenCodeModelId("openai/gpt-5.4")).toEqual({
    providerID: "openai",
    modelID: "gpt-5.4",
  })
})

test("prefers the first connected provider model as the default", () => {
  const catalog = buildOpenCodeCatalog({
    all: [
      {
        id: "anthropic",
        name: "Anthropic",
        connected: false,
        models: [
          { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        ],
      },
      {
        id: "openai",
        name: "OpenAI",
        connected: true,
        models: [{ id: "openai/gpt-5.4", name: "GPT-5.4" }],
      },
    ],
    authMethods: {},
  })

  expect(pickDefaultOpenCodeModel(catalog)?.id).toBe("openai/gpt-5.4")
})
