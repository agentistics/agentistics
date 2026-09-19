import { expect, test } from 'bun:test'
import { applyBaselineHeaders, keepsOwnCsp, OPAQUE_MEDIA_CSP, opaqueMediaCsp } from './response-policy'
import { securityHeaders } from './security-headers'

/**
 * Every test below calls `applyBaselineHeaders` — the REAL function `handleRequest` calls in
 * `index.ts` — never a re-typed copy of its loop. A copy proved only that the copy behaves: a
 * planted regression in the real `index.ts` loop (`if (k === 'X-Frame-Options') continue`,
 * unconditional, dropping XFO from every response in the product) passed the full suite while
 * these tests exercised a hand-written stand-in. Calling the real function is what lets that plant
 * fail here now.
 */
function stamp(res: Response, embed = true, isApi = true): Response {
  return applyBaselineHeaders(res, { tls: false, dev: false, isApi, embed })
}

/** A response carrying the media routes' allowlisted sentinel, as `readTreeMedia`'s route writes it. */
function opaqueMediaResponse(): Response {
  return new Response('x', { headers: { 'Content-Security-Policy': OPAQUE_MEDIA_CSP } })
}

test('a response with no policy of its own gets the baseline', () => {
  const res = stamp(new Response('x'))
  expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
})

test('the ONE allowlisted sentinel is recognized and REPLACED with the ancestor-aware policy', () => {
  // Not `.toBe(OPAQUE_MEDIA_CSP)` — the sentinel a route writes is never the value that reaches
  // the browser; `applyBaselineHeaders` computes the real one from `embed`. See `opaqueMediaCsp`.
  const res = stamp(opaqueMediaResponse(), /* embed */ false)
  expect(res.headers.get('Content-Security-Policy')).toBe(opaqueMediaCsp(false))
  expect(res.headers.get('Content-Security-Policy')).toContain(OPAQUE_MEDIA_CSP)
})

test('ANY other policy a route writes is replaced with the plain baseline, however close to the sentinel', () => {
  // This is the property the allowlist exists for: "keep whatever the route set" would make the
  // baseline opt-out, and the next route to write something looser would get it.
  for (const attempt of [
    "default-src 'none'",
    "default-src *; sandbox",
    "default-src 'none'; sandbox allow-scripts",
    "default-src 'none';sandbox",
    "DEFAULT-SRC 'none'; sandbox",
    "default-src 'none'; sandbox; frame-ancestors *",
    '',
  ]) {
    const res = stamp(new Response('x', { headers: { 'Content-Security-Policy': attempt } }))
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
  }
})

test('keepsOwnCsp matches the sentinel by value only, before it is ever replaced', () => {
  expect(keepsOwnCsp(opaqueMediaResponse())).toBe(true)
  expect(keepsOwnCsp(new Response('x'))).toBe(false)
  expect(keepsOwnCsp(new Response('x', { headers: { 'Content-Security-Policy': opaqueMediaCsp(false) } })))
    .toBe(false) // the ALREADY-COMPUTED value is not the sentinel — it must never re-match
})

test('nosniff is never given up — it is what makes the closed content table mean anything', () => {
  const res = stamp(opaqueMediaResponse())
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
})

// ---------------------------------------------------------------------------------------------
// frame-ancestors: the media routes' PDF must be framable from THIS ORIGIN, and from NOWHERE ELSE.
// An earlier version of this fix dropped `frame-ancestors` (and `X-Frame-Options`) entirely on the
// theory that a sandboxed response "has nothing to clickjack" — true of the framed document's own
// controls, irrelevant to who may embed it. Measured in real Chromium with a probe server:
//
//   | headers on the PDF                  | same-origin frame | FOREIGN-origin frame |
//   |--------------------------------------|--------------------|------------------------|
//   | OPAQUE + XFO: DENY (the original bug) | refused            | refused                |
//   | OPAQUE, no XFO (the dropped-too-far fix) | renders          | RENDERS (the hole)     |
//   | OPAQUE + frame-ancestors 'self'       | renders            | refused (CSP)          |
//   | OPAQUE + XFO: SAMEORIGIN              | renders            | refused (XFO)          |
// ---------------------------------------------------------------------------------------------

test('opaqueMediaCsp admits only this origin when no editor is embedding', () => {
  const csp = opaqueMediaCsp(false)
  expect(csp).toContain(OPAQUE_MEDIA_CSP)
  expect(csp).toContain("frame-ancestors 'self'")
  expect(csp).not.toContain('vscode-webview:')
  expect(csp).not.toContain('*')
})

test('opaqueMediaCsp ALSO admits the VS Code webview scheme when embed is true', () => {
  // frame-ancestors checks EVERY ancestor in the chain: a PDF inside the Studio inside a VS Code
  // webview tab has two ancestors — this origin, and vscode-webview: — and both must be admitted.
  const csp = opaqueMediaCsp(true)
  expect(csp).toContain("frame-ancestors 'self' vscode-webview:")
})

test('a media response on lan-with-shell (embed false): CSP self-only, XFO SAMEORIGIN, exactly as measured', () => {
  const res = stamp(opaqueMediaResponse(), /* embed */ false)
  expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox; frame-ancestors 'self'")
  expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
})

test('a media response on local (embed true): CSP admits the webview too, and XFO is left OFF', () => {
  const res = stamp(opaqueMediaResponse(), /* embed */ true)
  expect(res.headers.get('Content-Security-Policy'))
    .toBe("default-src 'none'; sandbox; frame-ancestors 'self' vscode-webview:")
  // NOT SAMEORIGIN: it checks every ancestor exactly like frame-ancestors does, and would refuse
  // the nested webview case the CSP right above was just widened to allow.
  expect(res.headers.get('X-Frame-Options')).toBeNull()
})

// ---------------------------------------------------------------------------------------------
// Per-profile pin for an ORDINARY route — never widened by the media exemption.
// ---------------------------------------------------------------------------------------------

test('an ordinary response keeps X-Frame-Options: DENY on lan-with-shell (embed false)', () => {
  const res = stamp(new Response('x'), /* embed */ false)
  expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
})

test('an ordinary response has no X-Frame-Options on local (embed true) — the dashboard\'s own case', () => {
  const res = stamp(new Response('x'), /* embed */ true)
  expect(res.headers.get('X-Frame-Options')).toBeNull()
  expect(res.headers.get('Content-Security-Policy')).toContain('frame-ancestors vscode-webview:')
  expect(res.headers.get('Content-Security-Policy')).not.toContain("frame-ancestors 'self'")
})

// The same pin, shaped like the two concrete routes named in the review: an API response
// (`/api/data`) and the HTML shell (isApi false, which only changes Cache-Control).
test('an API response (e.g. /api/data) sends the same framing headers on both profiles as any ordinary route', () => {
  const lan = stamp(new Response('x'), false, true)
  const local = stamp(new Response('x'), true, true)
  expect(lan.headers.get('X-Frame-Options')).toBe('DENY')
  expect(local.headers.get('X-Frame-Options')).toBeNull()
  expect(lan.headers.get('Cache-Control')).toBe('no-store')
})

test('the HTML shell (isApi false) sends the same framing headers as any ordinary route', () => {
  const lan = stamp(new Response('x'), false, false)
  const local = stamp(new Response('x'), true, false)
  expect(lan.headers.get('X-Frame-Options')).toBe('DENY')
  expect(local.headers.get('X-Frame-Options')).toBeNull()
  expect(lan.headers.get('Cache-Control')).toBeNull()
})

test('the allowlisted policy is strictly STRICTER than the baseline where it matters', () => {
  const baseline = securityHeaders({ tls: false, dev: false, isApi: true, embed: false })['Content-Security-Policy']!
  const media = opaqueMediaCsp(false)
  expect(media).toContain("default-src 'none'")
  expect(media).toContain('sandbox')
  expect(baseline).toContain("default-src 'self'")
  // Both now carry `frame-ancestors`, but the media policy admits only THIS origin, the narrowest
  // non-empty grant, where the baseline (no embed) admits none at all — still stricter than a page
  // that would otherwise default to `default-src 'self'` governing everything it does not name.
  expect(media).toContain("frame-ancestors 'self'")
  expect(baseline).toContain("frame-ancestors 'none'")
})
