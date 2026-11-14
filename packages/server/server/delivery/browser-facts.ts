/**
 * delivery/browser-facts.ts — what the HTTP adapter can honestly say about "is this the owner's own browser"
 * (ENTREGA.GARANTIDA §2.3 step 3): an `Origin` that is THIS server's own origin (the request's own Host) or an
 * allowed one (`AGENTISTICS_ALLOWED_ORIGINS`, the dev origin), plus `Sec-Fetch-Site: same-origin`. That is what a
 * browser sends from this machine AND from another machine over the tailnet — the owner's usual way in — so the
 * legacy shape does NOT require loopback (v2.210.1 accepted any request that passed the host/auth gates).
 * A same-uid `curl` can forge both headers: that is why this shape is ONLY `legacy` mode's, is recorded as
 * `legacy-browser`, and is WARN-flagged (`delivery-owner-unproven`).
 *
 * Loopback matters for ONE thing: the `delivery` grant (`loopbackPeer`), because a fresh vault proof is raised on
 * this computer (Hello/Touch ID dialog) and never on an empty desk.
 */
import { loopbackRequest } from '../vault/http'
import { originAllowed } from '../cors'
import type { BrowserFacts } from './web'

/** PURE. Is `origin` this request's own origin (`http(s)://<host>`) or an allowed one? An absent Origin is not own. */
export function originIsOwn(origin: string | null, host: string, allowlist: readonly string[], dev: boolean): boolean {
  if (!origin || !host) return false
  if (origin === `http://${host}` || origin === `https://${host}`) return true
  return originAllowed(origin, [...allowlist], dev)
}

export function browserFactsOf(
  req: { headers: Headers; method: string }, peer: string | null,
  o: { host: string; allowlist: readonly string[]; dev: boolean },
): BrowserFacts {
  const grant = req.headers.get('x-agentop-owner-grant')
  return {
    loopbackPeer: loopbackRequest(req, peer, { requireOrigin: true }),
    originOwn: originIsOwn(req.headers.get('origin'), o.host, o.allowlist, o.dev),
    sameOriginFetch: req.headers.get('sec-fetch-site') === 'same-origin',
    ...(grant ? { grantHeader: grant } : {}),
  }
}
