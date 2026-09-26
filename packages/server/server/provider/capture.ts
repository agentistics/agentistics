/**
 * capture.ts — IO. Wraps `fetch` so every HTTP exchange a provider client makes is observed and
 * written to durable, content-addressed storage (spec §4.1 condition 1, §6.3.3, §7). This module
 * is a NON-holder of the provider key (`provider-secrets.lint.test.ts`, Guard 1): the capturing
 * fetch forwards a caller's request UNTOUCHED and never reads `init.headers` or the request body,
 * so the key travelling on the request never reaches a variable here.
 *
 * `CONTENT_DIR` writes into exactly the layout the context manager's content store (spec §8.1,
 * `~/.agentistics/content/<sha[0:2]>/<sha256>`) will later own outright — one layout, never two —
 * and is excluded from backup by default (`backup-plan.ts`, spec §7).
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config.ts'
import { allowlistHeaders } from './anthropic/raw.ts'
import type { CaptureRef, RawExchange } from './client.ts'

/** `~/.agentistics/content` (or `AGENTISTICS_DIR`-relative) — CM §8.1's content-addressed layout. */
export const CONTENT_DIR = join(AGENTISTICS_DATA_DIR, 'content')

/**
 * Counters this module increments on a swallowed failure — `writeCapture` never throws, so a
 * caller (the retry loop, a test) reads these instead of a rejected promise. `resetCaptureCounters`
 * exists for tests only; nothing in the running server ever needs to zero them.
 */
export const captureCounters = { capture_failed: 0 }

export function resetCaptureCounters(): void {
  captureCounters.capture_failed = 0
}

export interface CapturingFetch {
  fetch: typeof fetch
  /** every exchange observed so far, in call order; a fresh array each call, never the live one */
  exchanges(): RawExchange[]
  /** true once ANY call has been handed to `inner` — never cleared once set */
  requestSent(): boolean
  requestCount(): number
}

/**
 * Wraps `inner` (real `fetch` by default) so the AI SDK's own request/response pair is observed at
 * the transport, before any SDK parsing can drop a field — the raw capture condition of spec
 * §4.1's comparison table. `input`/`init` are forwarded to `inner` exactly as given: this wrapper
 * never inspects, copies or logs `init.headers` or a request body, so it cannot leak what it never
 * held (the key travels only on the request side, and Guard 1 forbids this module from even naming
 * the header it would ride on).
 *
 * `requestSent()` flips to `true` the instant `inner` is CALLED — before any response, rejection or
 * timeout is known. That is the nuance worth stating: a `fetch`-shaped interface gives no way to
 * observe whether bytes actually left this machine's network stack, only that our wrapper handed
 * the request onward. That is exactly what `ClassifierInput.requestSent` means everywhere it is
 * read (`@agentistics/core`'s `classifyProviderError`): "did the capturing fetch observe the
 * request leave", not "did a byte cross a wire" — a distinction JavaScript's `fetch` cannot draw
 * for us, so the classifier's own doc reads an `undefined` value as "it may have" rather than
 * assuming either answer.
 *
 * The response body is read once, through `clone()`, so the response `inner` returns is untouched
 * and still readable by the real caller (the AI SDK) — this wrapper observes, it never substitutes
 * or consumes what it is handed back.
 *
 * If `inner` rejects (a network failure, an abort), the rejection propagates unchanged: this
 * function does not catch it, because classifying a failure is the caller's job (spec §4.3), not
 * this wrapper's.
 */
export function createCapturingFetch(inner: typeof fetch = fetch): CapturingFetch {
  const exchanges: RawExchange[] = []
  let sent = false
  let count = 0

  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    sent = true
    count += 1
    const response = await inner(input, init)
    const body = await response.clone().text()
    exchanges.push({
      status: response.status,
      headers: allowlistHeaders(response.headers),
      body,
    })
    return response
  }) as typeof fetch

  return {
    fetch: wrapped,
    exchanges: () => [...exchanges],
    requestSent: () => sent,
    requestCount: () => count,
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Writes one attempt's raw exchange as a single JSON document — `{status, headers, body}`, the
 * body stored whole as a string — at the content-addressed path `<dir>/<sha[0:2]>/<sha256>`, sha256
 * of the exact bytes written. The write is ATOMIC (a uniquely-named temp file, then `rename` into
 * place) and IDEMPOTENT: identical content hashes to the same path, so a second write of the same
 * exchange reuses the existing file instead of writing it twice.
 *
 * Directory mode `0700`, file mode `0600` — the same discipline `envelope-keys.ts` and
 * `credentials.ts` hold their own secrets to, applied here because a raw capture is native content
 * that must stay off a central and off anyone else's disk (D5).
 *
 * NEVER throws. Any failure — an unwritable directory, a `rename` across devices, anything else —
 * increments `captureCounters.capture_failed` and resolves to `undefined`; the caller still writes
 * its journal event, just without a `captureRef` (spec §7).
 */
export async function writeCapture(
  ex: RawExchange,
  opts?: { dir?: string },
): Promise<CaptureRef | undefined> {
  const dir = opts?.dir ?? CONTENT_DIR
  let tmpPath: string | undefined

  try {
    const document = JSON.stringify({ status: ex.status, headers: ex.headers, body: ex.body })
    const bytes = Buffer.byteLength(document, 'utf8')
    const sha256 = createHash('sha256').update(document, 'utf8').digest('hex')
    const shardDir = join(dir, sha256.slice(0, 2))
    const finalPath = join(shardDir, sha256)

    if (await fileExists(finalPath)) {
      return { sha256, bytes }
    }

    await mkdir(shardDir, { recursive: true, mode: 0o700 })
    await chmod(shardDir, 0o700)

    tmpPath = join(shardDir, `.tmp-${sha256}-${randomBytes(6).toString('hex')}`)
    await writeFile(tmpPath, document, { mode: 0o600 })
    await chmod(tmpPath, 0o600)
    await rename(tmpPath, finalPath)
    tmpPath = undefined

    return { sha256, bytes }
  } catch {
    captureCounters.capture_failed += 1
    return undefined
  } finally {
    if (tmpPath !== undefined) {
      try {
        await unlink(tmpPath)
      } catch {
        // best effort only — the failure above is already counted
      }
    }
  }
}
