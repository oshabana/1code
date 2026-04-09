/**
 * Types for the opencode integration.
 *
 * These mirror the shapes opencode emits on its Bus / SSE event stream
 * (see packages/opencode/src/session/message-v2.ts and server/routes/event.ts
 * in sst/opencode). We re-declare them locally so the main process does not
 * depend on the full @opencode-ai/sdk type surface at compile time — the SDK
 * is lazy-imported at runtime, and the router deals with the events we
 * actually care about.
 */

export type OpencodePartBase = {
  id: string
  sessionID: string
  messageID: string
}

export type OpencodeTextPart = OpencodePartBase & {
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: Record<string, unknown>
}

export type OpencodeReasoningPart = OpencodePartBase & {
  type: "reasoning"
  text: string
  metadata?: Record<string, unknown>
  time: { start: number; end?: number }
}

export type OpencodeToolStatePending = {
  status: "pending"
  input: Record<string, unknown>
  raw: string
}

export type OpencodeToolStateRunning = {
  status: "running"
  input: Record<string, unknown>
  title?: string
  metadata?: Record<string, unknown>
  time: { start: number }
}

export type OpencodeToolStateCompleted = {
  status: "completed"
  input: Record<string, unknown>
  output: string
  title: string
  metadata: Record<string, unknown>
  time: { start: number; end: number; compacted?: number }
}

export type OpencodeToolStateError = {
  status: "error"
  input: Record<string, unknown>
  error: string
  metadata?: Record<string, unknown>
  time: { start: number; end: number }
}

export type OpencodeToolState =
  | OpencodeToolStatePending
  | OpencodeToolStateRunning
  | OpencodeToolStateCompleted
  | OpencodeToolStateError

export type OpencodeToolPart = OpencodePartBase & {
  type: "tool"
  callID: string
  tool: string
  state: OpencodeToolState
  metadata?: Record<string, unknown>
}

export type OpencodeStepStartPart = OpencodePartBase & { type: "step-start" }
export type OpencodeStepFinishPart = OpencodePartBase & {
  type: "step-finish"
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
    total?: number
  }
}

export type OpencodePart =
  | OpencodeTextPart
  | OpencodeReasoningPart
  | OpencodeToolPart
  | OpencodeStepStartPart
  | OpencodeStepFinishPart
  // Other part kinds we don't specially handle yet; the transform treats
  // them as opaque and either ignores or forwards them.
  | (OpencodePartBase & { type: string; [key: string]: unknown })

export type OpencodeAssistantMessageInfo = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  parentID: string
  modelID: string
  providerID: string
  agent: string
  path: { cwd: string; root: string }
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  error?: { name: string; data?: Record<string, unknown> }
  finish?: string
}

export type OpencodeUserMessageInfo = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
}

export type OpencodeMessageInfo =
  | OpencodeAssistantMessageInfo
  | OpencodeUserMessageInfo

/**
 * SSE events opencode emits on GET /event.
 * Each SSE `data:` line is JSON of `{ type, properties }`.
 */
export type OpencodeBusEvent =
  | {
      type: "server.connected" | "server.heartbeat" | "global.disposed"
      properties: Record<string, unknown>
    }
  | {
      type: "message.updated"
      properties: { sessionID: string; info: OpencodeMessageInfo }
    }
  | {
      type: "message.removed"
      properties: { sessionID: string; messageID: string }
    }
  | {
      type: "message.part.updated"
      properties: { sessionID: string; part: OpencodePart; time: number }
    }
  | {
      type: "message.part.delta"
      properties: {
        sessionID: string
        messageID: string
        partID: string
        field: string
        delta: string
      }
    }
  | {
      type: "message.part.removed"
      properties: { sessionID: string; messageID: string; partID: string }
    }
  // Forward-compat catch-all for event types we don't model yet.
  | {
      type: string
      properties: Record<string, unknown>
    }
