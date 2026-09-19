/**
 * response-policy.ts — the ONE policy a route may keep when `handleRequest` stamps the baseline,
 * and the ONE function (`applyBaselineHeaders`) that does the stamping.
 *
 * `handleRequest` sets the OWASP headers on every response, and it SETS rather than appends, on
 * purpose: a newly added route cannot forget them. The cost is that a header a route writes for
 * itself is silently replaced, and two routes had been writing one for years —
 * `/api/fleet/media` and `/api/fleet/tree/media` both declared `default-src 'none'; sandbox` in
 * their own source, with comments explaining why it mattered, and neither one ever shipped. A
 * guarantee that reads true in the source and is absent on the wire is worse than none.
 *
 * IT WAS NOT COSMETIC. The baseline carries `frame-ancestors vscode-webview:` on a `local`
 * profile — the dashboard's own clickjacking rule, deliberately narrow and deliberately NOT
 * `'self'` (see `security-headers.ts`, which says so and has a test pinning it). Applied to a PDF's
 * bytes it forbids the dashboard from framing its own document, so the Studio's and the gallery's
 * PDF panes rendered the browser's "cannot display" glyph. Measured in Chromium: `Framing
 * 'http://127.0.0.1:47692/' violates the following Content Security Policy directive:
 * "frame-ancestors vscode-webview:"`. With the policy below the same frame renders both pages.
 *
 * THE ESCAPE IS AN ALLOWLIST OF ONE VALUE, NOT "THE ROUTE WINS". "Keep whatever a route set" would
 * make the baseline opt-out, and the next route to write a looser policy would get it. So the
 * wrapper recognizes a route's `Content-Security-Policy` only when it is EXACTLY this constant —
 * which is strictly stricter than the baseline in every direction that matters (`default-src
 * 'none'` against `'self'`, plus a `sandbox` that gives the response an opaque origin and no
 * scripting). Any other value a route writes is still replaced, so the property is closed by
 * construction rather than by anybody remembering a rule.
 *
 * WHAT IT IS FOR: an OPAQUE BYTE RESPONSE — an image, a video, a PDF — served from the closed
 * content table in `artifact-media.ts`, where the browser is additionally forbidden by `nosniff`
 * (still stamped by the baseline) from deciding a type the extension did not.
 *
 * `frame-ancestors` IS NOT ABSENT ON THE WIRE — IT IS COMPUTED, NOT WRITTEN BY THE ROUTE. A route
 * writes the bare sentinel `OPAQUE_MEDIA_CSP` (below); `applyBaselineHeaders` recognizes it via
 * `keepsOwnCsp` and REPLACES it with `opaqueMediaCsp(embed)`, which adds `frame-ancestors 'self'`
 * — the Studio and the gallery only ever need to frame a response from THEIR OWN origin, so that
 * is the entire grant. An earlier version of this fix left `frame-ancestors` off the wire
 * entirely on the theory that a sandboxed response "has nothing to clickjack" — true of the framed
 * document's OWN controls, but irrelevant to the question `frame-ancestors` answers, which is who
 * may embed it at all. Measured: with no `frame-ancestors` and no `X-Frame-Options`, a probe page
 * on a FOREIGN origin framed the PDF response with nothing stopping it. `'self'` closes that
 * while leaving the same-origin case — the only one either surface uses — rendering exactly as
 * before.
 *
 * `embed` (may an EDITOR frame the DASHBOARD — true only on `local`) still has to reach this
 * policy, and for a reason specific to CSP: `frame-ancestors` checks EVERY ancestor in the framing
 * chain, not just the immediate parent. On `local`, a PDF opened inside the Studio which is itself
 * opened inside a VS Code webview has TWO ancestors — this origin, and `vscode-webview:` — so the
 * policy must admit both or the nested case goes back to the "cannot display" glyph. `embed` also
 * decides `X-Frame-Options`: `SAMEORIGIN` is added ONLY when `embed` is false, because — like
 * `frame-ancestors` — it checks every ancestor too, and would refuse the very webview case the CSP
 * was just widened to allow.
 */

import { EDITOR_FRAME_SOURCE, securityHeaders } from './security-headers'

/**
 * The exact `Content-Security-Policy` a route writes to mark an opaque-byte media response. It is
 * a SENTINEL, not the value that reaches the browser: routes never see `embed`, so they cannot
 * compute the final, ancestor-aware policy themselves. `applyBaselineHeaders` recognizes this
 * exact string via `keepsOwnCsp` and swaps in `opaqueMediaCsp(embed)` before the response leaves.
 */
export const OPAQUE_MEDIA_CSP = "default-src 'none'; sandbox"

/**
 * The policy actually sent on the wire for an opaque-media response — see the module doc for why
 * `frame-ancestors 'self'` is there and why `embed` widens it to admit `vscode-webview:` too.
 * `sandbox` is untouched: the framed document still gets no scripting, no forms, no popups,
 * regardless of who is allowed to embed it.
 */
export function opaqueMediaCsp(embed: boolean): string {
  return `${OPAQUE_MEDIA_CSP}; frame-ancestors 'self'${embed ? ` ${EDITOR_FRAME_SOURCE}` : ''}`
}

/**
 * May this response keep the `Content-Security-Policy` it already carries — i.e., is it one of
 * the media routes' opaque-byte responses?
 *
 * Compared by VALUE against the single allowlisted sentinel, so a route cannot widen the policy by
 * writing a different one — it would simply be overwritten with the baseline, which is the safe
 * direction and the behaviour every other route already has.
 */
export function keepsOwnCsp(res: Response): boolean {
  return res.headers.get('Content-Security-Policy') === OPAQUE_MEDIA_CSP
}

/**
 * The ONE place that composes the OWASP baseline onto a response. `handleRequest` calls this and
 * nothing else — it used to inline the loop below directly, which meant a test wanting to prove a
 * header survives or is stripped had to COPY the loop rather than call it, and a copy is a second
 * implementation that can silently drift from the real one. It did: a planted regression in the
 * real `index.ts` loop (`if (k === 'X-Frame-Options') continue`, unconditional — dropping XFO from
 * EVERY response in the product) passed the entire suite, because every test exercised the copy.
 *
 * Mutates and returns `res`, matching how `handleRequest` uses it (SSE responses set their headers
 * before the first flush, so mutating afterwards is still safe there too).
 */
export function applyBaselineHeaders(
  res: Response,
  opts: { tls: boolean; dev: boolean; isApi: boolean; embed?: boolean },
): Response {
  const keepCsp = keepsOwnCsp(res)
  for (const [k, v] of Object.entries(securityHeaders(opts))) {
    // Both headers ride the SAME check: `OPAQUE_MEDIA_CSP` is the one policy the baseline may not
    // simply overwrite, and `X-Frame-Options: DENY` would otherwise silently re-block the exact
    // response the CSP was just let through — the legacy header wins wherever a browser honours
    // it, whatever the CSP says.
    if (keepCsp && (k === 'Content-Security-Policy' || k === 'X-Frame-Options')) continue
    res.headers.set(k, v)
  }
  if (keepCsp) {
    res.headers.set('Content-Security-Policy', opaqueMediaCsp(!!opts.embed))
    // `X-Frame-Options` is the legacy control for browsers that ignore `frame-ancestors`, and
    // `SAMEORIGIN` is its closest match to `'self'` above. NOT on `embed`: `SAMEORIGIN` checks
    // every ancestor exactly like `frame-ancestors` does, and the nested VS Code webview case
    // would fail it even though the CSP right above it was just widened to allow it.
    if (!opts.embed) res.headers.set('X-Frame-Options', 'SAMEORIGIN')
  }
  return res
}
