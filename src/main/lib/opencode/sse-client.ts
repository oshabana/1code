/**
 * Minimal SSE client for opencode's `GET /event` endpoint.
 *
 * We don't use a library (no EventSource in Node; the `eventsource`
 * package adds weight) — Node's built-in `fetch` + ReadableStream reader
 * is enough. opencode emits heartbeat every 10s so we don't need a
 * separate keepalive.
 *
 * Each SSE frame arrives as:
 *
 *     data: {"type":"...","properties":{...}}\n\n
 *
 * We accumulate chunks, split on \n\n, and parse the JSON payload.
 */

import type { OpencodeBusEvent } from "./types"

export type OpencodeSseSubscription = {
  /** Abort the SSE stream and release resources. */
  close: () => void
}

export type OpencodeSseHandlers = {
  onEvent: (event: OpencodeBusEvent) => void
  onError: (error: Error) => void
  onOpen?: () => void
}

/**
 * Opens an SSE stream against `${baseUrl}/event` and pumps events into
 * the provided handlers until close() is called or the stream ends.
 */
export function subscribeOpencodeEvents(
  baseUrl: string,
  handlers: OpencodeSseHandlers,
): OpencodeSseSubscription {
  const controller = new AbortController()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      controller.abort()
    } catch {
      // No-op — already aborted
    }
  }

  ;(async () => {
    try {
      const url = `${baseUrl.replace(/\/$/, "")}/event`
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      })

      if (!res.ok) {
        handlers.onError(
          new Error(
            `[opencode-sse] ${url} returned HTTP ${res.status} ${res.statusText}`,
          ),
        )
        return
      }

      if (!res.body) {
        handlers.onError(new Error("[opencode-sse] response has no body"))
        return
      }

      handlers.onOpen?.()

      const reader = res.body.getReader()
      const decoder = new TextDecoder("utf-8")
      let buffer = ""

      while (!closed) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Split on SSE frame boundaries. A frame ends on `\n\n`.
        let sep = buffer.indexOf("\n\n")
        while (sep !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          sep = buffer.indexOf("\n\n")

          if (!frame.trim()) continue

          // Each frame may have multiple lines. Only `data:` carries JSON.
          const dataLines: string[] = []
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart())
            }
          }
          if (dataLines.length === 0) continue

          const payload = dataLines.join("\n")
          try {
            const parsed = JSON.parse(payload) as OpencodeBusEvent
            handlers.onEvent(parsed)
          } catch (err) {
            console.warn(
              "[opencode-sse] failed to parse frame:",
              payload.slice(0, 200),
              err,
            )
          }
        }
      }
    } catch (err) {
      if (closed) return // abort during normal teardown
      const error = err instanceof Error ? err : new Error(String(err))
      if (error.name === "AbortError") return
      handlers.onError(error)
    }
  })()

  return { close }
}
