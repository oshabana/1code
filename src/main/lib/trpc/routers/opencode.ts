/**
 * tRPC router for opencode integration.
 *
 * Mirrors claude.ts / codex.ts subscription shape so the renderer can
 * treat opencode as a drop-in third provider. See
 * src/main/lib/opencode/transform.ts for the event-normalization heart
 * of this integration.
 *
 * Current scope:
 *   - One shared opencode server per app (not per sub-chat)
 *   - One SSE subscription per chat turn (not a multiplexed global one)
 *   - No MCP plumbing, no permission approval wiring
 *   - No image attachments
 *   - No session resume across turns (creates a fresh opencode session
 *     per turn when no sessionId is provided)
 *
 * The router also exposes provider/catalog discovery so the renderer can
 * present OpenCode as a first-class provider instead of a placeholder.
 */

import { observable } from "@trpc/server/observable"
import { z } from "zod"
import { publicProcedure, router } from "../index"
import {
  createTransformer,
  ensureOpencodeServer,
  logRawOpencodeEvent,
  replayAssistantSnapshot,
  shutdownOpencodeServer,
  subscribeOpencodeEvents,
  type OpencodeSseSubscription,
} from "../../opencode"
import {
  buildOpenCodeCatalog,
  flattenOpenCodeCatalog,
  pickDefaultOpenCodeModel,
  type OpenCodeProviderCatalog,
} from "../../../../shared/opencode-catalog"
import type { UIMessageChunk } from "../../claude"

type ActiveOpencodeStream = {
  runId: string
  controller: AbortController
  sseSub: OpencodeSseSubscription | null
  cancelRequested: boolean
}

const activeStreams = new Map<string, ActiveOpencodeStream>()

/** Check if there are any active opencode streaming sessions. */
export function hasActiveOpencodeStreams(): boolean {
  return activeStreams.size > 0
}

/** Abort all active opencode streams (used by reload / quit handlers). */
export function abortAllOpencodeStreams(): void {
  for (const [subChatId, stream] of activeStreams) {
    console.log(`[opencode] Aborting stream ${subChatId} before reload`)
    stream.controller.abort()
    stream.sseSub?.close()
  }
  activeStreams.clear()
}

/** Called on app shutdown to stop the shared opencode server process. */
export function shutdownOpencodeIntegration(): void {
  abortAllOpencodeStreams()
  shutdownOpencodeServer()
}

async function readOpenCodeCatalog() {
  const server = await ensureOpencodeServer()
  return readOpenCodeCatalogFromServer(server)
}

async function readOpenCodeCatalogFromServer(
  server: Awaited<ReturnType<typeof ensureOpencodeServer>>,
) {
  const [providersResult, authResult] = await Promise.all([
    server.client.provider.list({ throwOnError: true }),
    server.client.provider.auth({ throwOnError: true }),
  ])

  const rawProviders = providersResult.data?.all ?? []
  const connectedProviders = new Set(providersResult.data?.connected ?? [])
  const authMethods = authResult.data ?? {}
  const catalog = buildOpenCodeCatalog({
    all: rawProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      connected: connectedProviders.has(provider.id),
      models: Object.values(provider.models ?? {}).map((model) => ({
        id: model.id,
        name: model.name,
        status: model.status,
        experimental: model.experimental,
      })),
    })),
    authMethods,
  })
  const connectedCatalog = catalog.filter((provider) => provider.connected)

  console.log(
    `[opencode] catalog providers=${connectedCatalog.length}/${catalog.length} models=${connectedCatalog.reduce((sum, provider) => sum + provider.models.length, 0)}/${catalog.reduce((sum, provider) => sum + provider.models.length, 0)} url=${server.handle.url}`,
  )

  return {
    state: "connected" as const,
    url: server.handle.url,
    providers: connectedCatalog,
    models: flattenOpenCodeCatalog(connectedCatalog),
    defaultModelId: pickDefaultOpenCodeModel(connectedCatalog)?.id ?? null,
  }
}

export const opencodeRouter = router({
  /**
   * Stream a chat turn against opencode.
   *
   * Flow:
   *   1. Ensure a shared opencode server is running (spawns `opencode serve`
   *      on 127.0.0.1 if one isn't running yet).
   *   2. Open an SSE subscription to `/event` and start a transformer.
   *   3. Create or reuse an opencode session (scoped to input.cwd).
   *   4. POST the prompt to `session.prompt`.
   *   5. The SSE subscription drives the observable via the transformer.
   *   6. `session.prompt` resolving (or the transformer emitting `finish`)
   *      completes the observable.
   */
  chat: publicProcedure
    .input(
      z.object({
        subChatId: z.string(),
        chatId: z.string(),
        runId: z.string(),
        prompt: z.string(),
        cwd: z.string(),
        model: z
          .object({
            providerID: z.string(),
            modelID: z.string(),
          })
          .optional(),
        sessionId: z.string().optional(),
        mode: z.enum(["plan", "agent"]).default("agent"),
      }),
    )
    .subscription(({ input }) => {
      return observable<UIMessageChunk>((emit) => {
        // If an older stream for this sub-chat is still running, abort it
        // before starting the new one so events don't interleave.
        const existing = activeStreams.get(input.subChatId)
        if (existing) {
          existing.controller.abort()
          existing.sseSub?.close()
        }

        const controller = new AbortController()
        const active: ActiveOpencodeStream = {
          runId: input.runId,
          controller,
          sseSub: null,
          cancelRequested: false,
        }
        activeStreams.set(input.subChatId, active)

        let isObservableActive = true
        let finished = false
        let emittedChunkCount = 0

        const safeEmit = (chunk: UIMessageChunk) => {
          if (!isObservableActive) return
          try {
            emittedChunkCount += 1
            emit.next(chunk)
          } catch {
            isObservableActive = false
          }
        }

        const safeComplete = () => {
          if (finished) return
          finished = true
          try {
            emit.complete()
          } catch {
            // Already closed.
          }
          if (activeStreams.get(input.subChatId) === active) {
            activeStreams.delete(input.subChatId)
          }
          active.sseSub?.close()
        }

        const emitError = (context: string, error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error)
          console.error(`[opencode] ${context}:`, message)
          safeEmit({
            type: "error",
            errorText: `${context}: ${message}`,
          })
        }

        ;(async () => {
          try {
            // 1. Start / reuse the shared opencode server.
            const server = await ensureOpencodeServer()

            // 2. Create or resume an opencode session. Each session is
            //    scoped to a directory (the worktree cwd), which gives
            //    us the same isolation claude/codex get.
            let sessionId = input.sessionId ?? null
            if (!sessionId) {
              const result = await server.client.session.create(
                { directory: input.cwd },
                { throwOnError: true },
              )
              const created = result.data
              if (!created?.id) {
                throw new Error(
                  "opencode session.create returned no session id",
                )
              }
              sessionId = created.id
            }

            // 3. Start the transformer locked onto this session.
            const transform = createTransformer({
              subChatId: input.subChatId,
              sessionId,
            })

            // 4. Open SSE BEFORE firing the prompt so we don't miss the
            //    leading message.updated event.
            active.sseSub = subscribeOpencodeEvents(server.handle.url, {
              onOpen: () => {
                console.log(
                  `[opencode] SSE open for sub=${input.subChatId.slice(-8)} session=${sessionId}`,
                )
              },
              onEvent: (event: any) => {
                void logRawOpencodeEvent(sessionId!, event)
                try {
                  for (const chunk of transform(event)) {
                    safeEmit(chunk)
                    if (chunk.type === "finish") {
                      // Turn complete — close the observable.
                      safeComplete()
                      return
                    }
                  }
                } catch (err) {
                  emitError("transform error", err)
                }
              },
              onError: (error: unknown) => {
                if (controller.signal.aborted) return
                emitError("SSE error", error)
                safeComplete()
              },
            })
            await active.sseSub.ready

            // 5. Fire the prompt. opencode will then emit message.updated
            //    and part updates on the SSE stream we now know is live.
            console.log(
              "[opencode] prompt",
              JSON.stringify({
                subChatId: input.subChatId.slice(-8),
                sessionId,
                mode: input.mode,
                model: input.model ?? null,
                promptPreview: input.prompt.slice(0, 120),
              }),
            )
            await server.client.session.prompt(
              {
                path: { id: sessionId },
                query: { directory: input.cwd },
                body: {
                  ...(input.model ? { model: input.model } : {}),
                  parts: [{ type: "text", text: input.prompt }],
                },
              },
              { throwOnError: true },
            )

            // session.prompt resolves before the model's SSE stream is
            // necessarily done, especially for local providers. We leave
            // completion entirely to the SSE `finish` event so slower
            // models aren't cut off prematurely. If the SSE stream never
            // produces any usable chunks, fall back to replaying the
            // stored assistant message snapshot from the session.
            setTimeout(async () => {
              if (finished || emittedChunkCount > 0 || !isObservableActive) return

              try {
                const messagesResult = await server.client.session.messages(
                  {
                    path: { id: sessionId! },
                    query: { directory: input.cwd },
                  },
                  { throwOnError: true },
                )
                const messages = (messagesResult.data ?? []) as Array<{
                  info?: { role?: string; id?: string }
                  parts?: any[]
                }>
                const assistantMessage = [...messages]
                  .reverse()
                  .find((message) => message.info?.role === "assistant")

                if (!assistantMessage?.info || !assistantMessage.parts) return

                console.warn(
                  `[opencode] replaying stored assistant snapshot for sub=${input.subChatId.slice(-8)} session=${sessionId}`,
                )
                for (const chunk of replayAssistantSnapshot({
                  sessionId,
                  info: assistantMessage.info as any,
                  parts: assistantMessage.parts as any,
                })) {
                  safeEmit(chunk)
                }
                safeComplete()
              } catch (error) {
                emitError("snapshot replay failed", error)
                safeComplete()
              }
            }, 750)
          } catch (error) {
            if (controller.signal.aborted || active.cancelRequested) {
              safeComplete()
              return
            }
            emitError("chat failed", error)
            safeComplete()
          }
        })()

        // tRPC teardown hook (fires when the client unsubscribes).
        return () => {
          isObservableActive = false
          active.sseSub?.close()
          controller.abort()
          if (activeStreams.get(input.subChatId) === active) {
            activeStreams.delete(input.subChatId)
          }
        }
      })
    }),

  /**
   * Cancel an in-flight chat turn. The renderer calls this when the user
   * hits Stop. We abort the HTTP calls, close the SSE subscription, and
   * ask opencode to abort its own session if possible.
   */
  cancel: publicProcedure
    .input(z.object({ subChatId: z.string(), runId: z.string() }))
    .mutation(async ({ input }) => {
      const active = activeStreams.get(input.subChatId)
      if (!active || active.runId !== input.runId) {
        return { cancelled: false }
      }
      active.cancelRequested = true
      active.controller.abort()
      active.sseSub?.close()

      // Best-effort: tell opencode to abort its own session too so it
      // stops spending tokens. We don't fail the mutation if this fails.
      try {
        // We don't know the opencode sessionId here without reaching
        // into the active stream's closure, so just no-op for now.
        // Follow-up: plumb sessionId through ActiveOpencodeStream.
      } catch {
        // ignore
      }

      return { cancelled: true }
    }),

  /**
   * Clean up any opencode state associated with a sub-chat. Called by
   * the renderer when a chat is deleted or when auth errors require a
   * fresh session.
   */
  cleanup: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .mutation(async ({ input }) => {
      const active = activeStreams.get(input.subChatId)
      if (active) {
        active.controller.abort()
        active.sseSub?.close()
        activeStreams.delete(input.subChatId)
      }
      return { ok: true }
    }),

  /**
   * Lightweight health/status check the renderer can call before
   * showing the opencode provider as available.
   */
  getIntegration: publicProcedure.query(async () => {
    try {
      const server = await ensureOpencodeServer()
      return {
        state: "connected" as const,
        url: server.handle.url,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        state: "not_installed" as const,
        error: message,
      }
    }
  }),

  getCatalog: publicProcedure.query(async () => {
    try {
      return await readOpenCodeCatalog()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        state: "not_installed" as const,
        error: message,
        providers: [] as OpenCodeProviderCatalog[],
        models: [],
        defaultModelId: null,
      }
    }
  }),

  /** True if there are any active opencode streams (used by reload gate). */
  hasActive: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .query(({ input }) => activeStreams.has(input.subChatId)),
})
