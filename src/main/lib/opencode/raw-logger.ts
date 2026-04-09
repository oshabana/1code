import { app } from "electron"
import { join } from "path"
import { appendFile, mkdir, stat, readdir, unlink } from "fs/promises"

/**
 * Raw logger for opencode bus events. Same pattern as claude/raw-logger.ts
 * — toggled by the OPENCODE_RAW_LOG env var or by running in dev, and
 * writes JSONL files under {userData}/logs/opencode/.
 */

function isEnabled(): boolean {
  try {
    return process.env.OPENCODE_RAW_LOG === "1" || !app.isPackaged
  } catch {
    return process.env.OPENCODE_RAW_LOG === "1"
  }
}

const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB
const LOG_RETENTION_DAYS = 7

let logsDir: string | null = null
let currentLogFile: string | null = null
let currentSessionId: string | null = null

async function ensureLogsDir(): Promise<string> {
  if (!logsDir) {
    logsDir = join(app.getPath("userData"), "logs", "opencode")
    await mkdir(logsDir, { recursive: true })
  }
  return logsDir
}

async function shouldRotateLog(file: string): Promise<boolean> {
  try {
    const stats = await stat(file)
    return stats.size > MAX_LOG_SIZE
  } catch {
    return false
  }
}

export async function cleanupOldLogs(): Promise<void> {
  if (!isEnabled()) return
  try {
    const dir = await ensureLogsDir()
    const files = await readdir(dir)
    const now = Date.now()
    const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue
      const filePath = join(dir, file)
      try {
        const stats = await stat(filePath)
        if (now - stats.mtime.getTime() > maxAge) {
          await unlink(filePath)
        }
      } catch {
        // skip
      }
    }
  } catch (err) {
    console.error("[opencode raw-logger] cleanup failed:", err)
  }
}

export async function logRawOpencodeEvent(
  sessionId: string,
  event: unknown,
): Promise<void> {
  if (!isEnabled()) return
  try {
    const dir = await ensureLogsDir()
    const needsNewFile =
      sessionId !== currentSessionId ||
      (currentLogFile && (await shouldRotateLog(currentLogFile)))

    if (needsNewFile) {
      const wasNewSession = sessionId !== currentSessionId
      currentSessionId = sessionId
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      const suffix = currentLogFile ? `-${Date.now()}` : ""
      currentLogFile = join(dir, `${sessionId}_${timestamp}${suffix}.jsonl`)
      if (wasNewSession) {
        cleanupOldLogs().catch(() => {})
      }
    }

    await appendFile(
      currentLogFile!,
      JSON.stringify({ timestamp: new Date().toISOString(), data: event }) +
        "\n",
    )
  } catch (err) {
    console.error("[opencode raw-logger] log failed:", err)
  }
}

export function getLogsDirectory(): string {
  return join(app.getPath("userData"), "logs", "opencode")
}
