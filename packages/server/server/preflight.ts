/**
 * preflight.ts — the go-live checklist, as a pure function.
 *
 * `agentop doctor --exposed` prints these and exits non-zero on any failure. Every check maps
 * to a finding in docs/exposure.md, so a red line tells the operator exactly what to fix before
 * opening a tunnel — the whole point being that none of the controls in this branch help if a
 * single env var is wrong on the day it goes public.
 *
 * fail = do not expose. warn = a deliberate trade-off the operator should have made on purpose.
 */
import type { Capabilities, ExposureProfile } from './exposure'
import { isLoopbackAddress, type NativeBindResult, type NativeListener } from './native-bind'

export interface Check {
  id: string
  label: string
  status: 'pass' | 'fail' | 'warn'
  detail: string
}

export interface PreflightInput {
  profile: ExposureProfile
  caps: Capabilities
  tls: boolean
  trustProxy: boolean
  allowedOrigins: string[]
  /**
   * What the NATIVE `agentop server` process is actually listening on, for `ports` (config.ts's
   * PORT and WEB_PORT) — read from the OS, since `index.ts` hardcodes
   * `hostname: '0.0.0.0'` today regardless of the exposure profile (security finding S-1; see
   * `native-bind.ts`'s header). Optional so existing callers and tests keep compiling unchanged:
   * an ABSENT field means "not asked", so the check below is SKIPPED entirely rather than
   * rendered as a pass
   */
  nativeBind?: { ports: number[]; result: NativeBindResult }
}

export function runPreflight(input: PreflightInput): Check[] {
  // Only a public profile is held to the full bar; `local` and `lan` are allowed to keep the
  // conveniences that would be fatal on the internet.
  const strict = input.profile === 'public'
  const checks: Check[] = []

  const anyLocalPower =
    input.caps.localShell || input.caps.localChat || input.caps.localTranscripts || input.caps.mcpAdmin
  checks.push({
    id: 'local-shell',
    label: 'Local shell / chat / transcript / MCP routes are disabled',
    status: !strict || !anyLocalPower ? 'pass' : 'fail',
    detail: anyLocalPower
      ? 'POST /api/exec, /api/chat-tty, the transcript readers or /api/mcp-action are reachable. Set AGENTISTICS_EXPOSURE=public and unset AGENTISTICS_ALLOW_LOCAL_SHELL.'
      : 'All host-power routes answer 403.',
  })

  checks.push({
    id: 'tls',
    label: 'TLS is terminated in front of the app',
    status: !strict || input.tls ? 'pass' : 'fail',
    detail: input.tls
      ? 'AGENTISTICS_TLS=1 — cookies are Secure + __Host- prefixed and HSTS is sent.'
      : 'Set AGENTISTICS_TLS=1 once the tunnel terminates HTTPS.',
  })

  if (input.nativeBind) {
    const { ports, result } = input.nativeBind
    const label = "The native server's actual listening addresses (read from the OS)"
    const fmt = (rows: NativeListener[]) => rows.map(l => `${l.address}:${l.port}`).join(', ')
    if (result.kind === 'unreadable') {
      checks.push({
        id: 'native-bind',
        label,
        status: 'fail',
        detail: `Could not read the native server's real listening addresses (${result.reason}). A check that cannot verify the bind reports fail, never a reassuring pass.`,
      })
    } else if (result.listeners.length === 0) {
      checks.push({
        id: 'native-bind',
        label,
        status: 'warn',
        detail: `No native agentistics server is listening on port(s) ${ports.join(', ')}, so the native bind was not checked. This is a readable fact, not a verified guarantee — it proves nothing while the server is not running.`,
      })
    } else {
      const wide = result.listeners.filter(l => !isLoopbackAddress(l.address))
      if (wide.length === 0) {
        checks.push({
          id: 'native-bind',
          label,
          status: 'pass',
          detail: `Listening on loopback only: ${fmt(result.listeners)}.`,
        })
      } else if (strict) {
        checks.push({
          id: 'native-bind',
          label,
          status: 'fail',
          detail: `Listening on ${fmt(wide)} — not loopback-only. Behind a tunnel this must be 127.0.0.1/::1: binding wider only adds a way in that bypasses it.`,
        })
      } else if (input.profile === 'lan') {
        checks.push({
          id: 'native-bind',
          label,
          status: 'pass',
          detail: `Listening on ${fmt(wide)} — a wide bind is what the \`lan\` profile intends.`,
        })
      } else {
        checks.push({
          id: 'native-bind',
          label,
          status: 'warn',
          detail: `The native server listens on ${fmt(wide)} — every interface, LAN and tailnet included — on the \`local\` profile, which is described as 127.0.0.1. Host-header checking stops DNS rebinding, but any peer that can reach the port still gets the host-power routes without authentication (security finding S-1). Whether such a peer must authenticate, or whether \`local\` binds 127.0.0.1, is decision (b), pending with the owner.`,
        })
      }
    }
  }

  checks.push({
    id: 'trust-proxy',
    label: 'Forwarded-IP trust matches the deployment',
    status: !strict || input.trustProxy ? 'pass' : 'warn',
    detail: input.trustProxy
      ? 'AGENTISTICS_TRUST_PROXY=1 — rate limiting and the audit log see the real client IP.'
      : 'Without it every request looks like it came from the tunnel, so per-IP limits apply to all users at once.',
  })

  const badOrigin = input.allowedOrigins.find(o => !o.startsWith('https://'))
  checks.push({
    id: 'cors',
    label: 'CORS is same-origin or an explicit https allowlist',
    status: badOrigin ? 'fail' : 'pass',
    detail: badOrigin
      ? `Plaintext origin in AGENTISTICS_ALLOWED_ORIGINS: ${badOrigin}`
      : input.allowedOrigins.length
        ? `Allowed: ${input.allowedOrigins.join(', ')}`
        : 'Same-origin only.',
  })

  return checks
}

export function allPassed(checks: Check[]): boolean {
  return checks.every(c => c.status !== 'fail')
}
