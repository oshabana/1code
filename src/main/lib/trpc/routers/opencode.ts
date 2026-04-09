/**
 * tRPC router for opencode integration.
 *
 * Mirrors claude.ts / codex.ts subscription shape so the renderer can
 * treat opencode as a drop-in third provider. See
 * src/main/lib/opencode/transform.ts for the event-normalization heart
 * of this integration.
 *
 * Walking-skeleton scope (intentional cut lines):
 *   - One shared opencode server per app (not per sub-chat)
 *   - One SSE subscription per chat turn (not a multiplexed global one)
 *   - No MCP plumbing, no permission approval wiring
 *   - No model/provider selection — uses whatever opencode's default is
 *   - No image attachments
 *   - No session resume across turns (creates a fresh opencode session
 *     per turn when no sessionId is provided)
 *
 * These are all cleanly extendable once the basic end-to-end pipeline
 * is verified working.
 */

import { observable } from "@trpc/server/observable"
import { z } from "zod"
import { publicProcedure, router } from "../index"
import {
  createTransformer,
  ensureOpencodeServer,
  logRawOpencodeEvent,
  subscribeOpencodeEvents,
  shutdownOpencodeServer,
  type OpencodeSseSubscription,
} from "../../opencode"
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

        const safeEmit = (chunk: UIMessageChunk) => {
          if (!isObservableActive) return
          try {
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
              onEvent: (event) => {
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
              onError: (error) => {
                if (controller.signal.aborted) return
                emitError("SSE error", error)
                safeComplete()
              },
            })

            // 5. Fire the prompt. opencode will then emit message.updated
            //    and part updates on the SSE stream we just opened.
            await server.client.session.prompt(
              {
                sessionID: sessionId,
                directory: input.cwd,
                parts: [{ type: "text", text: input.prompt }],
              },
              { throwOnError: true },
            )

            // After session.prompt resolves the turn has technically
            // finished on the server, but the SSE stream may still be
            // flushing the last part.updated / message.updated. The
            // transform's `finish` chunk (emitted when message.updated
            // carries `time.completed`) is the authoritative stop signal
            // and triggers safeComplete() via onEvent above.
            //
            // As a safety net, if the SSE stream never emits finish within
            // a reasonable grace period after prompt resolved, force-close.
            setTimeout(() => {
              if (!finished) {
                console.warn(
                  `[opencode] forcing completion after prompt resolved without finish event (sub=${input.subChatId.slice(-8)})`,
                )
                safeComplete()
              }
            }, 5_000)
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

  /** True if there are any active opencode streams (used by reload gate). */
  hasActive: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .query(({ input }) => activeStreams.has(input.subChatId)),
})
