/**
 * cloud/url.ts — PURE: which Agentistics Cloud this machine talks to. `AGENTISTICS_CLOUD_URL`, else
 * `preferences.cloud.url`. There is NO default: the service is not deployed yet.
 */

export const NO_CLOUD_URL = 'No Agentistics Cloud URL is set (there is no default): set AGENTISTICS_CLOUD_URL, or `"cloud": { "url": … }` in preferences.json of your agentistics data folder.'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The base URL as it is used and stored, or null: https (http only for this computer), no
 * credentials, query or fragment, no trailing slash.
 */
export function normalizeCloudUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return null
  if (u.username || u.password || u.search || u.hash) return null
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '')
}

export type CloudUrlResult = { ok: true; url: string } | { ok: false; sentence: string }

export function resolveCloudUrl(env: Record<string, string | undefined>, prefs: { cloud?: { url?: string } }): CloudUrlResult {
  const raw = env.AGENTISTICS_CLOUD_URL?.trim() || prefs.cloud?.url?.trim()
  if (!raw) return { ok: false, sentence: NO_CLOUD_URL }
  const url = normalizeCloudUrl(raw)
  return url ? { ok: true, url } : { ok: false, sentence: 'The Cloud URL is not usable: it must be an https:// address (http:// only for this computer), without a password, query or fragment.' }
}
