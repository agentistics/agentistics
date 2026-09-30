/**
 * exposure.ts — the single source of truth for "how reachable is this instance?".
 *
 * Every dangerous capability (local shell, local chat, host transcript reads, MCP admin) asks
 * this module instead of re-deriving the answer from env vars at the call site. The decision
 * functions are pure and unit-tested; the runtime singletons at the bottom are the only IO.
 *
 * Profiles:
 *   local  — solo machine on 127.0.0.1. Full local power, no auth (today's behaviour).
 *   lan    — a central reachable from a trusted network (LAN/Tailscale). Auth on, local power
 *            off unless explicitly opted in.
 *   public — a central published on the internet. Local power is unavailable, period: there is
 *            no opt-in for arbitrary shell on an instance strangers can reach.
 *
 * Fail-closed: an unrecognised AGENTISTICS_EXPOSURE value resolves to `public`.
 */

export type ExposureProfile = 'local' | 'lan' | 'public'

export interface ExposureEnv {
  central: boolean
  exposure: string | undefined
  allowLocalShell: boolean
  tls: boolean
}

export interface Capabilities {
  /** POST /api/exec — arbitrary shell on the host. */
  localShell: boolean
  /** POST /api/chat-tty — spawns a coding-assistant CLI on the host. */
  localChat: boolean
  /** GET /api/{claude,codex,gemini,copilot,nay}-sessions — reads host transcripts. */
  localTranscripts: boolean
  /** GET /api/live-sessions' LOCAL half — reads /proc: which assistants run on the host and in
   *  which directories. A cwd is usually a repository name, so this is host state even though it
   *  is not a transcript. The route is NOT registered in capability-guard, because on a central it
   *  also serves members' self-reported snapshots, which stay available when this is off. */
  localProcesses: boolean
  /** `/api/mcp` and everything under it — reads this machine's MCP server configuration and, via
   *  `/api/mcp/install` and `/api/mcp/remove`, runs `claude mcp` to change it (~/.claude.json).
   *  RUNNING a configured server (`/api/mcp/check`, `/api/mcp/tools`) is `localShell`, not this. */
  mcpAdmin: boolean
  /** Owner accounts must have TOTP enrolled before they can use the instance. */
  requireMfaForOwner: boolean
  /** Session cookies must carry Secure + the __Host- prefix. */
  requireSecureCookies: boolean
}

export function resolveProfile(env: ExposureEnv): ExposureProfile {
  if (env.exposure === undefined || env.exposure === '') return env.central ? 'lan' : 'local'
  if (env.exposure === 'local' || env.exposure === 'lan' || env.exposure === 'public') return env.exposure
  return 'public' // unknown value → most restrictive
}

export function capabilitiesFor(profile: ExposureProfile, env: ExposureEnv): Capabilities {
  if (profile === 'local') {
    return {
      localShell: true,
      localChat: true,
      localTranscripts: true,
      localProcesses: true,
      mcpAdmin: true,
      // Required on EVERY profile, not only `public`. Two reasons, and neither is about the
      // network: an owner account can reach every team's data and every admin route, and — since
      // account recovery is now self-service through the second factor — an owner with no second
      // factor has no way back in except the host. "Local" describes where the port is bound,
      // not how much the account is worth.
      requireMfaForOwner: true,
      requireSecureCookies: false,
    }
  }
  if (profile === 'lan') {
    return {
      localShell: env.allowLocalShell,
      localChat: env.allowLocalShell,
      localTranscripts: env.allowLocalShell,
      // A LAN central is normally the aggregator, not a workstation; its own /proc says nothing
      // useful and its members report their own. Follows the same opt-in as the other host powers.
      localProcesses: env.allowLocalShell,
      mcpAdmin: env.allowLocalShell,
      requireMfaForOwner: true,
      requireSecureCookies: env.tls,
    }
  }
  return {
    localShell: false,
    localChat: false,
    localTranscripts: false,
    localProcesses: false,
    mcpAdmin: false,
    requireMfaForOwner: true,
    requireSecureCookies: true,
  }
}

// ---------------------------------------------------------------------------
// Runtime singletons. Read straight from process.env (not config.ts) so this module
// stays importable from anywhere without pulling in the filesystem-touching config chain.
// ---------------------------------------------------------------------------

export const EXPOSURE_ENV: ExposureEnv = {
  central: process.env.AGENTISTICS_TEAM_CENTRAL === '1',
  exposure: process.env.AGENTISTICS_EXPOSURE,
  allowLocalShell: process.env.AGENTISTICS_ALLOW_LOCAL_SHELL === '1',
  tls: process.env.AGENTISTICS_TEAM_TLS === '1',
}

export const PROFILE: ExposureProfile = resolveProfile(EXPOSURE_ENV)
export const CAPS: Capabilities = capabilitiesFor(PROFILE, EXPOSURE_ENV)
