import { afterEach, expect, mock, test } from "bun:test"
import { AbstractChat, type ChatInit, type ChatState, type UIMessage } from "ai"

type SubscriptionHandlers = {
  onData: (chunk: any) => void
  onError: (error: Error) => void
  onComplete: () => void
}

let handlers: SubscriptionHandlers | null = null
const openCodeModelAtom = { key: "mock-open-code-model" }

const fakeTrpcClient = {
  opencode: {
    chat: {
      subscribe: (_input: any, nextHandlers: SubscriptionHandlers) => {
        handlers = nextHandlers
        return {
          unsubscribe: () => {
            handlers = null
          },
        }
      },
    },
    cancel: {
      mutate: async () => ({ cancelled: true }),
    },
    cleanup: {
      mutate: async () => ({ ok: true }),
    },
  },
}

mock.module("../src/renderer/lib/trpc", () => ({
  trpcClient: fakeTrpcClient,
}))

mock.module("../src/renderer/lib/jotai-store", () => ({
  appStore: {
    get: (atom: unknown) =>
      atom === openCodeModelAtom ? "lmstudio/gemma-4-26b-a4b-it" : undefined,
  },
}))

mock.module("../src/renderer/features/agents/atoms", () => ({
  subChatOpenCodeModelIdAtomFamily: () => openCodeModelAtom,
}))

mock.module("sonner", () => ({
  toast: {
    error: () => {},
  },
}))

afterEach(() => {
  handlers = null
})

class TestChatState<UI_MESSAGE extends UIMessage>
  implements ChatState<UI_MESSAGE>
{
  status: "ready" | "submitted" | "streaming" | "error" = "ready"
  messages: UI_MESSAGE[]
  error: Error | undefined = undefined

  constructor(initialMessages: UI_MESSAGE[] = []) {
    this.messages = initialMessages
  }

  pushMessage = (message: UI_MESSAGE) => {
    this.messages = this.messages.concat(message)
  }

  popMessage = () => {
    this.messages = this.messages.slice(0, -1)
  }

  replaceMessage = (index: number, message: UI_MESSAGE) => {
    this.messages = [
      ...this.messages.slice(0, index),
      message,
      ...this.messages.slice(index + 1),
    ]
  }

  snapshot = <T>(value: T): T => value
}

class TestChat extends AbstractChat<UIMessage> {
  constructor(init: ChatInit<UIMessage>) {
    super({
      ...init,
      state: new TestChatState(init.messages ?? []),
    })
  }
}

test("delivers opencode chunks to a waiting reader instead of dropping them", async () => {
  const { OpencodeChatTransport } = await import(
    "../src/renderer/features/agents/lib/opencode-chat-transport"
  )

  const transport = new OpencodeChatTransport({
    chatId: "chat_1",
    subChatId: "sub_1",
    cwd: "/tmp",
    mode: "agent",
    provider: "opencode",
  })

  const stream = await transport.sendMessages({
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "ping" }],
      } as any,
    ],
  })

  const reader = stream.getReader()
  const firstRead = reader.read()

  await Promise.resolve()

  handlers?.onData({ type: "text-delta", id: "part_1", delta: "hello" })
  handlers?.onData({ type: "finish" })

  const firstChunk = await firstRead
  expect(firstChunk.done).toBe(false)
  expect(firstChunk.value).toEqual({
    type: "text-delta",
    id: "part_1",
    delta: "hello",
  })

  const secondChunk = await reader.read()
  expect(secondChunk.done).toBe(false)
  expect(secondChunk.value).toEqual({ type: "finish" })

  const thirdChunk = await reader.read()
  expect(thirdChunk.done).toBe(true)
})

test("allows AI Chat to finish after opencode emits finish and completes", async () => {
  let finished = false

  const { OpencodeChatTransport } = await import(
    "../src/renderer/features/agents/lib/opencode-chat-transport"
  )

  const transport = new OpencodeChatTransport({
    chatId: "chat_2",
    subChatId: "sub_2",
    cwd: "/tmp",
    mode: "agent",
    provider: "opencode",
  })

  const chat = new TestChat({
    id: "sub_2",
    generateId: (() => {
      let id = 0
      return () => `id-${id++}`
    })(),
    transport,
    onFinish: () => {
      finished = true
    },
  })

  const sendPromise = chat.sendMessage({
    text: "hi",
  })

  await Promise.resolve()

  handlers?.onData({ type: "start", messageId: "assistant-1" })
  handlers?.onData({ type: "start-step" })
  handlers?.onData({ type: "text-start", id: "text-1" })
  handlers?.onData({ type: "text-delta", id: "text-1", delta: "Hello" })
  handlers?.onData({ type: "text-end", id: "text-1" })
  handlers?.onData({ type: "finish-step" })
  handlers?.onData({ type: "finish", finishReason: "stop" })
  handlers?.onComplete()

  await sendPromise

  expect(finished).toBe(true)
  expect(chat.status).toBe("ready")
  expect(chat.messages.at(-1)?.role).toBe("assistant")
})
