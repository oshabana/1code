/**
 * Transforms opencode Bus events into Vercel AI SDK UIMessageChunks
 * (the same type the claude and codex routers emit). This is the
 * load-bearing translation layer — if this is wrong, the UI shows
 * nothing, and if it's right, the existing chat renderer works with
 * opencode unchanged.
 *
 * Event flow (as of @opencode-ai/sdk 1.4.0 / opencode message-v2):
 *
 *   session.prompt (HTTP) kicks off a turn, then the server emits:
 *
 *     message.updated   { info: AssistantMessage }           ← turn starts
 *     message.part.updated { part: StepStartPart }
 *     message.part.updated { part: TextPart(empty) }         ← text slot opens
 *     message.part.delta   { partID, field:"text", delta }   ← streaming chars
 *     message.part.delta   { ... }
 *     message.part.updated { part: ToolPart(state:pending) } ← tool called
 *     message.part.updated { part: ToolPart(state:running) }
 *     message.part.updated { part: ToolPart(state:completed/error) }
 *     message.part.delta   { partID, field:"reasoning", delta } (for thinking)
 *     message.part.updated { part: StepFinishPart }
 *     message.updated   { info.time.completed = N }          ← turn done
 *
 * We map:
 *   text   part delta       → text-delta
 *   text   part open/close  → text-start / text-end
 *   reasoning part delta    → reasoning-delta
 *   tool   part state:pending/running  → tool-input-available
 *   tool   part state:completed         → tool-output-available
 *   tool   part state:error             → tool-output-error
 *   message.updated with finish/time.completed → finish (with usage metadata)
 */

import type {
  OpencodeBusEvent,
  OpencodeAssistantMessageInfo,
  OpencodePart,
  OpencodeTextPart,
  OpencodeToolPart,
} from "./types"
import type { UIMessageChunk, MessageMetadata } from "../claude/types"

type TransformState = {
  /** subChatId we're transforming for (for logging only) */
  subChatId: string
  /** opencode session we scoped this stream to */
  sessionId: string
  /** the opencode messageID we've locked onto (we ignore unrelated turns) */
  targetMessageId: string | null

  started: boolean
  stepStarted: boolean

  /** set of text partIDs we've already opened a text-start for */
  openTextParts: Set<string>
  /** set of reasoning partIDs we've opened */
  openReasoningParts: Set<string>
  /** the active text partID in the current "paragraph" (last one we saw) */
  lastTextPartId: string | null
  /** whatever text we've buffered per part when a delta arrives for a part
   *  we haven't yet opened via part.updated. Lets us emit text-start +
   *  text-delta in the right order even if events arrive out of sequence. */
  pendingTextByPart: Map<string, string>

  /** tool calls we've already surfaced tool-input-available for */
  emittedToolInputs: Set<string>
  /** tool calls we've already surfaced terminal output for */
  emittedToolOutputs: Set<string>
  /** stop processing once the turn has ended or failed */
  ended: boolean
}

export function createTransformer(options: {
  subChatId: string
  sessionId: string
  /** messageID to lock onto. If null, the first assistant message we see wins. */
  lockToMessageId?: string | null
}) {
  const state: TransformState = {
    subChatId: options.subChatId,
    sessionId: options.sessionId,
    targetMessageId: options.lockToMessageId ?? null,
    started: false,
    stepStarted: false,
    openTextParts: new Set(),
    openReasoningParts: new Set(),
    lastTextPartId: null,
    pendingTextByPart: new Map(),
    emittedToolInputs: new Set(),
    emittedToolOutputs: new Set(),
    ended: false,
  }

  /**
   * Process one OpencodeBusEvent and yield zero or more UIMessageChunks.
   * Caller is expected to iterate the generator and emit each chunk.
   */
  return function* transform(
    event: OpencodeBusEvent,
  ): Generator<UIMessageChunk> {
    if (state.ended) {
      return
    }

    // Filter: ignore events from other sessions entirely.
    const propSessionId = (event.properties as { sessionID?: string })
      ?.sessionID
    if (propSessionId && propSessionId !== state.sessionId) {
      return
    }

    switch (event.type) {
      case "server.connected":
      case "server.heartbeat":
      case "global.disposed":
      case "message.removed":
      case "message.part.removed":
        return

      case "session.error": {
        const error = (event.properties as {
          error?: { name: string; data?: Record<string, unknown> }
        }).error
        const data = (error?.data || {}) as Record<string, unknown>
        const message =
          typeof data.message === "string" ? data.message : error?.name ?? "OpenCode error"

        if (state.openTextParts.size > 0) {
          for (const textId of state.openTextParts) {
            yield { type: "text-end", id: textId }
          }
          state.openTextParts.clear()
        }
        if (state.stepStarted) {
          yield { type: "finish-step" }
          state.stepStarted = false
        }

        yield { type: "error", errorText: message }
        yield { type: "finish" }
        state.ended = true
        return
      }

      case "message.updated": {
        const info = (
          event.properties as { info?: OpencodeAssistantMessageInfo }
        ).info
        if (!info || info.role !== "assistant") return

        // Lock onto the first assistant message we see if we don't have
        // an explicit target.
        if (!state.targetMessageId) {
          state.targetMessageId = info.id
        }

        // Ignore unrelated assistant messages (e.g. from another turn).
        if (info.id !== state.targetMessageId) return

        // Emit lifecycle `start` + `start-step` on first observation.
        if (!state.started) {
          state.started = true
          yield { type: "start", messageId: info.id }
          yield { type: "start-step" }
          state.stepStarted = true
        }

        // Some providers emit a terminal assistant update with `finish`
        // before they backfill `time.completed`. Treat either signal as
        // end-of-turn so the UI does not spin forever waiting for the
        // later timestamp update.
        if (info.time.completed !== undefined || info.finish !== undefined) {
          // Close any open text blocks before emitting finish.
          for (const textId of state.openTextParts) {
            yield { type: "text-end", id: textId }
          }
          state.openTextParts.clear()

          if (state.stepStarted) {
            yield { type: "finish-step" }
            state.stepStarted = false
          }

          yield {
            type: "finish",
            messageMetadata: buildMessageMetadata({
              sessionId: state.sessionId,
              info,
              finalTextId: state.lastTextPartId ?? undefined,
            }),
          }
          state.ended = true

          // If opencode reported an error on the assistant message, also
          // surface it as an explicit `error` chunk so the UI can toast.
          if (info.error) {
            const data = (info.error.data || {}) as Record<string, unknown>
            const message =
              typeof data.message === "string"
                ? data.message
                : info.error.name
            yield { type: "error", errorText: message }
          }
        }
        return
      }

      case "message.part.updated": {
        const part = (event.properties as { part?: OpencodePart }).part
        if (!part) return

        // Only forward parts belonging to the assistant message we're tracking.
        if (!state.targetMessageId || part.messageID !== state.targetMessageId) {
          return
        }

        if (part.type === "text") {
          yield* handleTextPart(state, part as OpencodeTextPart)
          return
        }

        if (part.type === "reasoning") {
          // Reasoning parts usually arrive as deltas; the full-part
          // update mostly signals open/close. We only emit when the part
          // hasn't been opened yet and has text (non-streaming fallback).
          const reasoning = part as OpencodePart & {
            text?: string
            id: string
          }
          if (
            !state.openReasoningParts.has(reasoning.id) &&
            typeof reasoning.text === "string" &&
            reasoning.text.length > 0
          ) {
            state.openReasoningParts.add(reasoning.id)
            yield {
              type: "reasoning",
              id: reasoning.id,
              text: reasoning.text,
            }
          }
          return
        }

        if (part.type === "tool") {
          yield* handleToolPart(state, part as OpencodeToolPart)
          return
        }

        // step-start / step-finish / snapshot / patch / etc. — ignore for
        // the walking skeleton. They're non-essential for basic chat.
        return
      }

      case "message.part.delta": {
        const props = event.properties as {
          messageID?: string
          partID?: string
          field?: string
          delta?: string
        }
        if (!props.partID || !props.delta) return

        // Ignore deltas for other messages.
        if (
          !state.targetMessageId ||
          props.messageID === undefined ||
          props.messageID !== state.targetMessageId
        ) {
          return
        }

        if (props.field === "text") {
          // If we haven't yet opened a text-start for this partID (because
          // the part.updated event hasn't arrived or arrived without text),
          // open it now.
          if (!state.openTextParts.has(props.partID)) {
            state.openTextParts.add(props.partID)
            state.lastTextPartId = props.partID
            yield { type: "text-start", id: props.partID }
          }
          yield {
            type: "text-delta",
            id: props.partID,
            delta: props.delta,
          }
          return
        }

        if (props.field === "reasoning" || props.field === "thinking") {
          if (!state.openReasoningParts.has(props.partID)) {
            state.openReasoningParts.add(props.partID)
          }
          yield {
            type: "reasoning-delta",
            id: props.partID,
            delta: props.delta,
          }
          return
        }

        // Unknown field — ignore silently in the skeleton.
        return
      }

      default:
        // Forward-compat: unknown event types are ignored. raw-logger
        // captures them for debugging if OPENCODE_RAW_LOG=1.
        return
    }
  }
}

export function replayAssistantSnapshot(options: {
  sessionId: string
  info: OpencodeAssistantMessageInfo
  parts: OpencodePart[]
}): UIMessageChunk[] {
  const { sessionId, info, parts } = options
  const chunks: UIMessageChunk[] = [
    { type: "start", messageId: info.id },
    { type: "start-step" },
  ]

  let finalTextId: string | undefined

  for (const part of parts) {
    if (part.type === "text") {
      const textPart = part as OpencodeTextPart
      if (textPart.synthetic || textPart.ignored) continue
      finalTextId = textPart.id
      chunks.push({ type: "text-start", id: textPart.id })
      if (textPart.text) {
        chunks.push({
          type: "text-delta",
          id: textPart.id,
          delta: textPart.text,
        })
      }
      chunks.push({ type: "text-end", id: textPart.id })
      continue
    }

    if (part.type === "tool") {
      const toolPart = part as OpencodeToolPart
      const status = toolPart.state.status
      chunks.push({
        type: "tool-input-available",
        toolCallId: toolPart.callID,
        toolName: toolPart.tool,
        input: toolPart.state.input,
      })
      if (status === "completed") {
        chunks.push({
          type: "tool-output-available",
          toolCallId: toolPart.callID,
          output: toolPart.state.output,
        })
      } else if (status === "error") {
        chunks.push({
          type: "tool-output-error",
          toolCallId: toolPart.callID,
          errorText: toolPart.state.error,
        })
      }
    }
  }

  chunks.push({ type: "finish-step" })
  chunks.push({
    type: "finish",
    messageMetadata: buildMessageMetadata({
      sessionId,
      info,
      finalTextId,
    }),
  })

  if (info.error) {
    const data = (info.error.data || {}) as Record<string, unknown>
    const message =
      typeof data.message === "string" ? data.message : info.error.name
    chunks.push({ type: "error", errorText: message })
  }

  return chunks
}

function buildMessageMetadata(options: {
  sessionId: string
  info: OpencodeAssistantMessageInfo
  finalTextId?: string
}): MessageMetadata {
  const { sessionId, info, finalTextId } = options
  return {
    sessionId,
    inputTokens: info.tokens.input,
    outputTokens: info.tokens.output,
    cacheReadInputTokens: info.tokens.cache.read,
    cacheCreationInputTokens: info.tokens.cache.write,
    totalTokens:
      info.tokens.total ?? info.tokens.input + info.tokens.output,
    totalCostUsd: info.cost,
    durationMs:
      info.time.completed !== undefined
        ? Math.max(0, info.time.completed - info.time.created)
        : 0,
    resultSubtype: info.error
      ? `error:${info.error.name}`
      : info.finish ?? "success",
    finalTextId,
  }
}

function* handleTextPart(
  state: TransformState,
  part: OpencodeTextPart,
): Generator<UIMessageChunk> {
  if (part.synthetic || part.ignored) return

  const partId = part.id

  // If we've never opened this text block, open it now.
  if (!state.openTextParts.has(partId)) {
    state.openTextParts.add(partId)
    state.lastTextPartId = partId
    yield { type: "text-start", id: partId }

    // If the part already carries text at the time of creation (some
    // non-streaming providers emit full text in one go), flush it as a
    // single delta. Otherwise deltas will arrive via message.part.delta.
    if (part.text && part.text.length > 0) {
      yield { type: "text-delta", id: partId, delta: part.text }
    }
  }

  // If the part has `time.end`, it's finalized — close the block.
  if (part.time?.end !== undefined && state.openTextParts.has(partId)) {
    state.openTextParts.delete(partId)
    yield { type: "text-end", id: partId }
  }
}

function* handleToolPart(
  state: TransformState,
  part: OpencodeToolPart,
): Generator<UIMessageChunk> {
  const toolCallId = part.callID
  const toolName = part.tool

  // Before a tool call starts rendering, close any open text block so
  // the UI draws the tool card *after* the preceding text — same
  // ordering convention claude's transform uses.
  if (state.openTextParts.size > 0) {
    for (const textId of state.openTextParts) {
      yield { type: "text-end", id: textId }
    }
    state.openTextParts.clear()
  }

  const status = part.state.status

  if (
    (status === "pending" || status === "running") &&
    !state.emittedToolInputs.has(toolCallId)
  ) {
    state.emittedToolInputs.add(toolCallId)
    yield {
      type: "tool-input-available",
      toolCallId,
      toolName,
      input: part.state.input,
    }
    return
  }

  if (status === "completed" && !state.emittedToolOutputs.has(toolCallId)) {
    // If we never saw a pending/running phase for this tool (some
    // providers skip straight to completed), still emit the input first.
    if (!state.emittedToolInputs.has(toolCallId)) {
      state.emittedToolInputs.add(toolCallId)
      yield {
        type: "tool-input-available",
        toolCallId,
        toolName,
        input: part.state.input,
      }
    }
    state.emittedToolOutputs.add(toolCallId)
    yield {
      type: "tool-output-available",
      toolCallId,
      output: part.state.output,
    }
    return
  }

  if (status === "error" && !state.emittedToolOutputs.has(toolCallId)) {
    if (!state.emittedToolInputs.has(toolCallId)) {
      state.emittedToolInputs.add(toolCallId)
      yield {
        type: "tool-input-available",
        toolCallId,
        toolName,
        input: part.state.input,
      }
    }
    state.emittedToolOutputs.add(toolCallId)
    yield {
      type: "tool-output-error",
      toolCallId,
      errorText: part.state.error,
    }
    return
  }
}
