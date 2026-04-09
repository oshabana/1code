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
import { trpcClient } from "../../../lib/trpc"
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

    return new ReadableStream({
      start: (controller) => {
        const runId = crypto.randomUUID()
        let sub: { unsubscribe: () => void } | null = null
        let didUnsubscribe = false
        let forcedUnsubscribeTimer: ReturnType<typeof setTimeout> | null = null

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

        sub = trpcClient.opencode.chat.subscribe(
          {
            subChatId: this.config.subChatId,
            chatId: this.config.chatId,
            runId,
            prompt,
            cwd: this.config.cwd,
            mode: this.config.mode,
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

              try {
                controller.enqueue(chunk)
              } catch {
                // Stream already closed.
              }

              if (chunk.type === "finish") {
                try {
                  controller.close()
                } catch {
                  // Already closed.
                }
              }
            },
            onError: (error: Error) => {
              toast.error("opencode request failed", {
                description: error.message,
              })
              try {
                controller.error(error)
              } catch {
                // Already closed.
              }
              safeUnsubscribe()
            },
            onComplete: () => {
              try {
                controller.close()
              } catch {
                // Already closed.
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

          try {
            controller.close()
          } catch {
            // Already closed.
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
