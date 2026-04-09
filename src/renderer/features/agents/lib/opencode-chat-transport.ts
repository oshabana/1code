/**
 * Renderer-side chat transport for opencode.
 *
 * Mirrors ACPChatTransport (for codex) but talks to trpcClient.opencode.
 * Produces a ReadableStream of UIMessageChunks that Vercel AI SDK's Chat
 * consumes directly — no changes needed in the UI/components layer as
 * long as the main process emits the same chunk shape.
 *
 * Walking-skeleton scope:
 *   - Text prompts only (no images / file attachments / resume support)
 *   - Surfaces errors as toasts, doesn't drive an auth modal
 *   - Cancel fires both a trpc cancel() mutate and a local controller.close()
 */

import type { ChatTransport, UIMessage } from "ai"
import { toast } from "sonner"
import { parseOpenCodeModelId } from "../../../../shared/opencode-catalog"
import { appStore } from "../../../lib/jotai-store"
import { trpcClient } from "../../../lib/trpc"
import { subChatOpenCodeModelIdAtomFamily } from "../atoms"
import type { AgentMessageMetadata } from "../ui/agent-message-usage"

type UIMessageChunk = any

type OpencodeChatTransportConfig = {
  chatId: string
  subChatId: string
  cwd: string
  projectPath?: string
  mode: "plan" | "agent"
  provider: "opencode"
}

export class OpencodeChatTransport implements ChatTransport<UIMessage> {
  constructor(private config: OpencodeChatTransportConfig) {}

  async sendMessages(options: {
    messages: UIMessage[]
    abortSignal?: AbortSignal
  }): Promise<ReadableStream<UIMessageChunk>> {
    const lastUser = [...options.messages]
      .reverse()
      .find((message) => message.role === "user")
    const prompt = this.extractText(lastUser)

    const lastAssistant = [...options.messages]
      .reverse()
      .find((message) => message.role === "assistant")
    const metadata = lastAssistant?.metadata as AgentMessageMetadata | undefined
    const sessionId = metadata?.sessionId
    const selectedModelId = appStore.get(
      subChatOpenCodeModelIdAtomFamily(this.config.subChatId),
    )
    const selectedModel = parseOpenCodeModelId(selectedModelId)

    let sub: { unsubscribe: () => void } | null = null
    let didUnsubscribe = false
    let forcedUnsubscribeTimer: ReturnType<typeof setTimeout> | null = null
    let resolveNext: ((result: { done: boolean; chunk?: UIMessageChunk }) => void) | null = null
    let rejectNext: ((error: Error) => void) | null = null
    let pendingChunks: UIMessageChunk[] = []
    let streamDone = false
    let streamError: Error | null = null

    const clearForcedUnsubscribeTimer = () => {
      if (!forcedUnsubscribeTimer) return
      clearTimeout(forcedUnsubscribeTimer)
      forcedUnsubscribeTimer = null
    }

    const safeUnsubscribe = () => {
      if (didUnsubscribe) return
      didUnsubscribe = true
      clearForcedUnsubscribeTimer()
      sub?.unsubscribe()
    }

    return new ReadableStream({
      start: (controller) => {
        const runId = crypto.randomUUID()

        const deliverNext = () => {
          if (resolveNext == null) return
          if (pendingChunks.length > 0) {
            const chunk = pendingChunks.shift()!
            const isFinish = chunk.type === "finish"
            resolveNext({ done: false, chunk })
            resolveNext = null
            if (isFinish) {
              streamDone = true
            }
            return
          }
          if (streamError) {
            rejectNext?.(streamError)
            rejectNext = null
            return
          }
          if (streamDone) {
            resolveNext({ done: true })
            resolveNext = null
          }
        }

        sub = trpcClient.opencode.chat.subscribe(
          {
            subChatId: this.config.subChatId,
            chatId: this.config.chatId,
            runId,
            prompt,
            cwd: this.config.cwd,
            mode: this.config.mode,
            ...(selectedModel
              ? {
                  model: {
                    providerID: selectedModel.providerID,
                    modelID: selectedModel.modelID,
                  },
                }
              : {}),
            ...(sessionId ? { sessionId } : {}),
          },
          {
            onData: (chunk: UIMessageChunk) => {
              if (chunk.type === "error") {
                toast.error("opencode error", {
                  description:
                    chunk.errorText || "An unexpected opencode error occurred.",
                })
              }

              if (chunk.type === "finish") {
                streamDone = true
              }

              if (resolveNext) {
                const resolve = resolveNext
                resolveNext = null
                resolve({ done: false, chunk })
              } else {
                pendingChunks.push(chunk)
              }
            },
            onError: (error: Error) => {
              toast.error("opencode request failed", {
                description: error.message,
              })
              streamError = error
              if (rejectNext) {
                rejectNext(error)
                rejectNext = null
              }
              safeUnsubscribe()
            },
            onComplete: () => {
              streamDone = true
              if (resolveNext) {
                deliverNext()
              }
              safeUnsubscribe()
            },
          },
        )

        options.abortSignal?.addEventListener("abort", () => {
          const cancelPromise = trpcClient.opencode.cancel
            .mutate({ subChatId: this.config.subChatId, runId })
            .catch(() => {
              // No-op — server may have already cleaned up.
            })

          streamDone = true
          if (resolveNext) {
            resolveNext({ done: true })
            resolveNext = null
          }

          void (async () => {
            try {
              await cancelPromise
            } finally {
              clearForcedUnsubscribeTimer()
              forcedUnsubscribeTimer = setTimeout(() => {
                safeUnsubscribe()
              }, 10_000)
            }
          })()
        })
      },
      pull: async (controller) => {
        // Deliver any queued chunks first.
        if (pendingChunks.length > 0) {
          const chunk = pendingChunks.shift()!
          controller.enqueue(chunk)
          if (chunk.type === "finish") {
            // Wait for the consumer to process the finish chunk, then
            // close on the next pull when the queue is drained.
            streamDone = true
          }
          return
        }

        if (streamError) {
          controller.error(streamError)
          return
        }

        if (streamDone) {
          controller.close()
          return
        }

        const result = await new Promise<{ done: boolean; chunk?: UIMessageChunk }>((resolve, reject) => {
          resolveNext = resolve
          rejectNext = reject
        })

        if (result.done) {
          controller.close()
          return
        }

        if (result.chunk) {
          controller.enqueue(result.chunk)
          if (result.chunk.type === "finish") {
            streamDone = true
          }
        }
      },
      cancel: () => {
        streamDone = true
        safeUnsubscribe()
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }

  cleanup(): void {
    void trpcClient.opencode.cleanup
      .mutate({ subChatId: this.config.subChatId })
      .catch(() => {
        // No-op.
      })
  }

  private extractText(message: UIMessage | undefined): string {
    if (!message?.parts) return ""
    const textParts: string[] = []
    const fileContents: string[] = []
    for (const part of message.parts) {
      if (part.type === "text" && (part as any).text) {
        textParts.push((part as any).text)
      } else if ((part as any).type === "file-content") {
        const filePart = part as any
        const fileName =
          filePart.filePath?.split("/").pop() || filePart.filePath || "file"
        fileContents.push(`\n--- ${fileName} ---\n${filePart.content}`)
      }
    }
    return textParts.join("\n") + fileContents.join("")
  }
}
