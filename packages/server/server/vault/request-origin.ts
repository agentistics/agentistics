import { originMatchesRp } from '@agentistics/vault'

function first(value: string | null): string | null {
  const v = value?.split(',')[0]?.trim()
  return v || null
}

/**
 * The browser omits Origin on same-origin GETs. Behind a TLS-terminating proxy, the URL handed to
 * the vault handler is the proxy's HTTP hop, so use the proxy's public scheme/host for the GET-only
 * `secure` hint. A real Origin always wins and is never replaced by forwarded headers.
 */
export function informationalOrigin(req: Request, url: URL): string {
  const origin = req.headers.get('origin')
  if (origin !== null) return origin
  const proto = first(req.headers.get('x-forwarded-proto')) ?? url.protocol.slice(0, -1)
  const host = first(req.headers.get('x-forwarded-host')) ?? req.headers.get('host') ?? url.host
  return `${proto}://${host}`
}

/** Informational only: mutation/WebAuthn paths must continue using the actual Origin header. */
export function informationalSecure(req: Request, url: URL): boolean {
  return originMatchesRp(informationalOrigin(req, url), url.hostname)
}

/** The actual browser-origin check; no Origin means it is not a valid WebAuthn origin. */
export function actualOriginSecure(req: Request, url: URL): boolean {
  const origin = req.headers.get('origin')
  return origin !== null && originMatchesRp(origin, url.hostname)
}
