/**
 * Manages opencode server lifecycle for the main process.
 *
 * Strategy (walking skeleton):
 *   - Spawn ONE opencode server per app session (not per sub-chat) using
 *     @opencode-ai/sdk's `createOpencodeServer`, which fires
 *     `opencode serve --hostname=127.0.0.1 --port=<auto>` as a child
 *     process and returns the URL once it prints its listening banner.
 *   - Each sub-chat creates its own opencode session via
 *     `OpencodeClient.session.create({ directory: worktreeCwd })`, so
 *     worktree isolation still holds.
 *   - The server is cached on a module-level singleton and torn down when
 *     the app exits (shutdown() is called from the main process wire-up).
 *
 * The SDK is dynamically imported so electron-vite can bundle the main
 * process without a hard top-level dependency, mirroring the lazy-import
 * pattern used for `@anthropic-ai/claude-agent-sdk` in claude.ts.
 */

import { buildOpencodeEnv } from "./env"

// Minimal structural types for what we use from the SDK. The full SDK
// ships its own types, but typing them structurally here keeps the main
// process independent of the SDK's exact type surface across versions and
// avoids importing the SDK synchronously.
type OpencodeServerHandle = {
  url: string
  close: () => void
}

type OpencodeSessionInfo = {
  id: string
  [key: string]: unknown
}

type OpencodeClientLike = {
  session: {
    create: (
      body: { directory?: string } | Record<string, unknown>,
      options?: { throwOnError?: boolean },
    ) => Promise<{ data: OpencodeSessionInfo | undefined }>
    get: (
      body: { sessionID: string; directory?: string },
      options?: { throwOnError?: boolean },
    ) => Promise<{ data: OpencodeSessionInfo | undefined }>
    prompt: (
      body: {
        sessionID: string
        directory?: string
        parts: Array<{ type: "text"; text: string }>
        model?: { providerID: string; modelID: string }
      },
      options?: { throwOnError?: boolean },
    ) => Promise<{ data: unknown }>
    abort: (
      body: { sessionID: string; directory?: string },
      options?: { throwOnError?: boolean },
    ) => Promise<{ data: unknown }>
  }
}

type CachedServer = {
  handle: OpencodeServerHandle
  client: OpencodeClientLike
  startedAt: number
}

let cachedServer: CachedServer | null = null
let startingServerPromise: Promise<CachedServer> | null = null

/**
 * Lazy-load the opencode SDK's server + client factories. Returns the
 * functions as `any` — the real types are too fluid to pin here and
 * runtime behavior is stable across v1.x.
 */
async function loadSdk(): Promise<{
  createOpencodeServer: (opts?: {
    hostname?: string
    port?: number
    timeout?: number
  }) => Promise<OpencodeServerHandle>
  createOpencodeClient: (cfg: {
    baseUrl: string
    directory?: string
  }) => OpencodeClientLike
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import("@opencode-ai/sdk")
  return {
    createOpencodeServer: mod.createOpencodeServer,
    createOpencodeClient: mod.createOpencodeClient,
  }
}

/**
 * Ensure there's a running opencode server and return a client pointed at
 * it. Concurrent callers during a cold start share the same in-flight
 * promise to avoid spawning multiple server processes.
 */
export async function ensureOpencodeServer(): Promise<CachedServer> {
  if (cachedServer) return cachedServer
  if (startingServerPromise) return startingServerPromise

  startingServerPromise = (async () => {
    const { createOpencodeServer, createOpencodeClient } = await loadSdk()

    // Surface a cleaner error than the SDK's "Timeout waiting for server"
    // when the user hasn't installed opencode on PATH.
    try {
      // Let opencode pick an ephemeral port to avoid clashing with a user's
      // own `opencode serve` instance. We inject the shell-derived env
      // so opencode is discoverable on PATH even in packaged Electron.
      const originalPath = process.env.PATH
      const shellEnv = buildOpencodeEnv()
      process.env.PATH = shellEnv.PATH || process.env.PATH

      let handle: OpencodeServerHandle
      try {
        handle = await createOpencodeServer({
          hostname: "127.0.0.1",
          // port: 0 would be ideal but the SDK doesn't forward it as an
          // ephemeral request — it just defaults to 4096. Accept the default
          // for the walking skeleton; a follow-up can do port discovery.
          timeout: 10_000,
        })
      } finally {
        process.env.PATH = originalPath
      }

      const client = createOpencodeClient({ baseUrl: handle.url })
      const entry: CachedServer = {
        handle,
        client,
        startedAt: Date.now(),
      }
      cachedServer = entry
      console.log(
        `[opencode] server ready at ${handle.url} (startup took ${
          Date.now() - entry.startedAt
        }ms)`,
      )
      return entry
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `[opencode] Failed to start opencode server. Is \`opencode\` installed on PATH? Install via \`npm i -g opencode-ai\`, \`brew install opencode\`, or \`curl -fsSL https://opencode.ai/install | bash\`. Underlying error: ${message}`,
      )
    } finally {
      startingServerPromise = null
    }
  })()

  return startingServerPromise
}

/** Get the base URL of the running server, if any. */
export function getOpencodeServerUrl(): string | null {
  return cachedServer?.handle.url ?? null
}

/** Tear the server down. Safe to call multiple times. */
export function shutdownOpencodeServer(): void {
  if (!cachedServer) return
  try {
    cachedServer.handle.close()
  } catch (error) {
    console.error("[opencode] failed to close server:", error)
  }
  cachedServer = null
}
