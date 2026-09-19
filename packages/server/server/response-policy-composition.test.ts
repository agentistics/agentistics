/**
 * response-policy-composition.test.ts — pins that `handleRequest` in `index.ts` actually calls
 * `applyBaselineHeaders`, and that nothing AFTER that call undoes the framing headers it just set.
 *
 * `response-policy.test.ts` (if present) exercises `applyBaselineHeaders` itself — the function is
 * correct in isolation. Nothing pinned the WIRING: `index.ts` is ~4000 lines with a real `Bun.serve`
 * call at module top level (importing it directly would try to bind the product's own ports, which
 * this shared machine's real servers already hold — see `sdd/scratch/sessions/00-shared-rules.md`),
 * so a real request through the handler is not a safe or practical test here. A regression this
 * module's own header records as having shipped once — `if (k === 'X-Frame-Options') continue,
 * unconditional` inside a COPY of the header loop — passed the entire suite because every test
 * exercised the copy, not the real one; a `res.headers.delete('X-Frame-Options')` planted right
 * after the real call would pass just as silently were nothing reading the real source. This is a
 * stripped-source scan of `handleRequest`'s own body instead: comments are removed first
 * (`strip-comments.ts`), so a scan cannot pass on the prose above the function describing the very
 * call it is checking for.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from './strip-comments'

const INDEX_PATH = join(import.meta.dir, 'index.ts')

/**
 * The exact body of one top-level `async function <name>(...) { ... }` in `index.ts` — every such
 * function in this file closes at column 0, which is what lets a plain `indexOf('\n}')` find the
 * matching brace without a real parser. Throws (failing the test loudly) if either boundary is
 * missing, so a rename of `handleRequest` fails here instead of leaving the assertions below
 * vacuously true against an empty slice.
 */
function extractTopLevelFunction(src: string, name: string): string {
  const signature = `function ${name}(`
  const start = src.indexOf(signature)
  if (start === -1) throw new Error(`no top-level function named "${name}" found`)
  const bodyOpen = src.indexOf('{', start)
  if (bodyOpen === -1) throw new Error(`no opening brace found for "${name}"`)
  const bodyClose = src.indexOf('\n}', bodyOpen)
  if (bodyClose === -1) throw new Error(`no top-level closing brace found for "${name}"`)
  return src.slice(start, bodyClose)
}

describe('handleRequest composes the OWASP baseline correctly', () => {
  const stripped = stripComments(readFileSync(INDEX_PATH, 'utf8'))
  const body = extractTopLevelFunction(stripped, 'handleRequest')

  it('the scan is looking at the real function, so the assertions below are not vacuous', () => {
    // `handleRequestInner` is the router `handleRequest` delegates to — its presence proves this is
    // the outer wrapper and not some other, unrelated function that happens to share a name.
    expect(body).toContain('handleRequestInner')
  })

  it('calls applyBaselineHeaders on the response it is about to return', () => {
    expect(body).toContain('applyBaselineHeaders(res')
  })

  it('nothing AFTER that call strips or overwrites the framing headers it just computed', () => {
    const callIndex = body.indexOf('applyBaselineHeaders(res')
    const after = body.slice(callIndex + 'applyBaselineHeaders(res'.length)
    // The exact plant this test exists for: a delete of any header at all, once the baseline has
    // been stamped, is never legitimate in this function.
    expect(after).not.toMatch(/\.headers\.delete\(/)
    // A `.set`/`.append` on anything other than the sliding-session cookie would silently re-open
    // (or narrow) the framing guarantee `applyBaselineHeaders` just decided.
    const touchedHeaders = [...after.matchAll(/\.headers\.(?:set|append)\(\s*'([^']+)'/g)].map(m => m[1])
    expect(touchedHeaders).toEqual(['Set-Cookie'])
  })
})
