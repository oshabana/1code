import { expect, test } from "bun:test"
import {
  createTransformer,
  replayAssistantSnapshot,
} from "../src/main/lib/opencode/transform"

function collect(transform: ReturnType<typeof createTransformer>, event: any) {
  return Array.from(transform(event))
}

test("ignores user message events before the assistant turn starts", () => {
  const transform = createTransformer({
    subChatId: "sub_1",
    sessionId: "ses_1",
  })

  expect(
    collect(transform, {
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: {
          id: "msg_user",
          sessionID: "ses_1",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "lmstudio", modelID: "gemma-4-26b-a4b-it" },
        },
      },
    }),
  ).toEqual([])

  expect(
    collect(transform, {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_user",
        partID: "prt_user",
        field: "text",
        delta: "hello",
      },
    }),
  ).toEqual([])
})

test("emits assistant text chunks and finishes on session error", () => {
  const transform = createTransformer({
    subChatId: "sub_2",
    sessionId: "ses_2",
  })

  expect(
    collect(transform, {
      type: "message.updated",
      properties: {
        sessionID: "ses_2",
        info: {
          id: "msg_assistant",
          sessionID: "ses_2",
          role: "assistant",
          time: { created: 1 },
          parentID: "msg_user",
          modelID: "gemma-4-26b-a4b-it",
          providerID: "lmstudio",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    }),
  ).toEqual([
    { type: "start", messageId: "msg_assistant" },
    { type: "start-step" },
  ])

  expect(
    collect(transform, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_2",
        part: {
          id: "prt_assistant",
          sessionID: "ses_2",
          messageID: "msg_assistant",
          type: "text",
          text: "Hello!",
        },
        time: 2,
      },
    }),
  ).toEqual([
    { type: "text-start", id: "prt_assistant" },
    { type: "text-delta", id: "prt_assistant", delta: "Hello!" },
  ])

  const errorTransform = createTransformer({
    subChatId: "sub_3",
    sessionId: "ses_3",
  })

  expect(
    collect(errorTransform, {
      type: "message.updated",
      properties: {
        sessionID: "ses_3",
        info: {
          id: "msg_error_2",
          sessionID: "ses_3",
          role: "assistant",
          time: { created: 1 },
          parentID: "msg_user",
          modelID: "gemma-4-26b-a4b-it",
          providerID: "lmstudio",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    }),
  )

  expect(
    collect(errorTransform, {
      type: "session.error",
      properties: {
        sessionID: "ses_3",
        error: {
          name: "UnknownError",
          data: { message: "Model not found" },
        },
      },
    }),
  ).toEqual([
    { type: "finish-step" },
    { type: "error", errorText: "Model not found" },
    { type: "finish" },
  ])
})

test("finishes when opencode reports finish before time.completed", () => {
  const transform = createTransformer({
    subChatId: "sub_4",
    sessionId: "ses_4",
  })

  expect(
    collect(transform, {
      type: "message.updated",
      properties: {
        sessionID: "ses_4",
        info: {
          id: "msg_assistant",
          sessionID: "ses_4",
          role: "assistant",
          time: { created: 10 },
          parentID: "msg_user",
          modelID: "gemma-4-26b-a4b-it",
          providerID: "lmstudio",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: {
            input: 12,
            output: 5,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    }),
  ).toEqual([
    { type: "start", messageId: "msg_assistant" },
    { type: "start-step" },
  ])

  expect(
    collect(transform, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_4",
        part: {
          id: "prt_assistant",
          sessionID: "ses_4",
          messageID: "msg_assistant",
          type: "text",
          text: "Hello!",
          time: { start: 11, end: 11 },
        },
        time: 11,
      },
    }),
  ).toEqual([
    { type: "text-start", id: "prt_assistant" },
    { type: "text-delta", id: "prt_assistant", delta: "Hello!" },
    { type: "text-end", id: "prt_assistant" },
  ])

  expect(
    collect(transform, {
      type: "message.updated",
      properties: {
        sessionID: "ses_4",
        info: {
          id: "msg_assistant",
          sessionID: "ses_4",
          role: "assistant",
          time: { created: 10 },
          parentID: "msg_user",
          modelID: "gemma-4-26b-a4b-it",
          providerID: "lmstudio",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: {
            input: 12,
            output: 5,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: "stop",
        },
      },
    }),
  ).toEqual([
    { type: "finish-step" },
    {
      type: "finish",
      messageMetadata: {
        sessionId: "ses_4",
        inputTokens: 12,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 17,
        totalCostUsd: 0,
        durationMs: 0,
        resultSubtype: "stop",
        finalTextId: "prt_assistant",
      },
    },
  ])
})

test("replays a stored assistant snapshot into UI chunks", () => {
  expect(
    replayAssistantSnapshot({
      sessionId: "ses_5",
      info: {
        id: "msg_assistant",
        sessionID: "ses_5",
        role: "assistant",
        time: { created: 100, completed: 150 },
        parentID: "msg_user",
        modelID: "gemma-4-26b-a4b-it",
        providerID: "lmstudio",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        finish: "stop",
        tokens: {
          total: 17,
          input: 12,
          output: 5,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [
        {
          id: "prt_step",
          sessionID: "ses_5",
          messageID: "msg_assistant",
          type: "step-start",
        },
        {
          id: "prt_text",
          sessionID: "ses_5",
          messageID: "msg_assistant",
          type: "text",
          text: "Hello from snapshot",
          time: { start: 120, end: 120 },
        },
        {
          id: "prt_finish",
          sessionID: "ses_5",
          messageID: "msg_assistant",
          type: "step-finish",
          reason: "stop",
        },
      ] as any,
    }),
  ).toEqual([
    { type: "start", messageId: "msg_assistant" },
    { type: "start-step" },
    { type: "text-start", id: "prt_text" },
    { type: "text-delta", id: "prt_text", delta: "Hello from snapshot" },
    { type: "text-end", id: "prt_text" },
    { type: "finish-step" },
    {
      type: "finish",
      messageMetadata: {
        sessionId: "ses_5",
        inputTokens: 12,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 17,
        totalCostUsd: 0,
        durationMs: 50,
        resultSubtype: "stop",
        finalTextId: "prt_text",
      },
    },
  ])
})
