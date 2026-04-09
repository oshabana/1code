/**
 * Environment + process resolution for opencode.
 *
 * Unlike Claude Code and Codex, opencode is not bundled with this app —
 * users install it via npm/brew/curl and it lives on PATH. We just need
 * to pass an environment that lets `createOpencodeServer` (from
 * @opencode-ai/sdk) find the `opencode` binary.
 *
 * If the user has a shell-derived PATH (e.g. managed by asdf / nvm / mise)
 * that differs from Electron's default process env, we reuse the
 * getClaudeShellEnvironment helper so opencode sees the same PATH the
 * user would see in their interactive shell.
 */

import { getClaudeShellEnvironment } from "../claude/env"

export function buildOpencodeEnv(): Record<string, string> {
  // Reuse claude's shell-env helper — it already caches a login-shell
  // environment and merges it with process.env. opencode doesn't need any
  // extra env of its own for the walking skeleton; provider API keys are
  // resolved by opencode itself via ~/.opencode or its own auth flow.
  return getClaudeShellEnvironment()
}
