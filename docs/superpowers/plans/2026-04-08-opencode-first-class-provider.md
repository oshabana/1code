# OpenCode First-Class Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCode behave like a first-class agent provider in the picker, settings, and chat transport.

**Architecture:** Add a small pure helper layer in the main process to normalize OpenCode provider/model metadata from the SDK. Expose that catalog through tRPC so the renderer can render real OpenCode model rows, persist per-chat selections, and pass the chosen `providerID/modelID` into `session.prompt`.

**Tech Stack:** TypeScript, Bun test, Electron main process, tRPC, Jotai, @opencode-ai/sdk.

---

### Task 1: Add OpenCode catalog helpers and tests

**Files:**
- Create: `src/main/lib/opencode/catalog.ts`
- Create: `test/opencode-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import { buildOpenCodeCatalog, parseOpenCodeModelId, pickDefaultOpenCodeModel } from "../src/main/lib/opencode/catalog"

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
        models: [{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/opencode-catalog.test.ts -t "OpenCode"`
Expected: FAIL because `catalog.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export function parseOpenCodeModelId(id: string) {
  const slash = id.indexOf("/")
  if (slash === -1) return null
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/opencode-catalog.test.ts`
Expected: PASS

### Task 2: Expose OpenCode catalog through tRPC

**Files:**
- Modify: `src/main/lib/opencode/server-manager.ts`
- Modify: `src/main/lib/trpc/routers/opencode.ts`

- [ ] **Step 1: Write the failing test**

```ts
// Add a router/unit test that stubs the OpenCode client and verifies
// getCatalog returns flattened provider/model metadata.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/opencode-catalog.test.ts`
Expected: PASS for helper tests, router test missing/failing.

- [ ] **Step 3: Write minimal implementation**

```ts
// Add a getCatalog query that returns provider summaries, connected status,
// auth methods, and flattened models.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test`
Expected: PASS

### Task 3: Wire OpenCode into the agent picker and settings

**Files:**
- Modify: `src/renderer/features/agents/lib/models.ts`
- Modify: `src/renderer/features/agents/components/agent-model-selector.tsx`
- Modify: `src/renderer/components/dialogs/settings-tabs/agents-models-tab.tsx`
- Modify: `src/renderer/features/agents/main/new-chat-form.tsx`
- Modify: `src/renderer/features/agents/main/chat-input-area.tsx`
- Modify: `src/renderer/features/agents/atoms/index.ts`
- Modify: `src/renderer/features/agents/lib/opencode-chat-transport.ts`

- [ ] **Step 1: Write the failing test**

```ts
// Add a renderer-side helper test that ensures OpenCode models are flattened
// into selectable picker rows and that a stored id survives selection parsing.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test`
Expected: Fails until OpenCode props/state are wired through.

- [ ] **Step 3: Write minimal implementation**

```ts
// Replace the single placeholder OpenCode entry with real model rows, add
// per-chat OpenCode model storage, and pass the selected provider/model into
// the OpenCode transport prompt call.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test && bun run ts:check`
Expected: PASS

### Task 4: Verify end-to-end in dev mode

**Files:**
- None

- [ ] **Step 1: Run the app**

Run: `bun run dev`
Expected: Electron starts and the OpenCode provider/model UI is visible.

- [ ] **Step 2: Smoke test OpenCode selection**

Expected: Picking an OpenCode model in the chat picker sets the provider and model consistently, and prompts use the selected OpenCode model.

