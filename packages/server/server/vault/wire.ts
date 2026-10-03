/**
 * vault/wire.ts — the framing `vault.sock` speaks. PURE.
 *
 * A message is ONE JSON line (the header), optionally followed by exactly `bodyBytes` raw bytes. A
 * request is one message. A reply is any number of STREAM lines (`{"s":"out"|"err","d":"…"}` — the
 * output of a command the service runs on the caller's behalf), then one FINAL message
 * (`{"final":true, …}`), optionally followed by its body.
 *
 * Bodies are raw bytes, never base64 inside the JSON: a backup archive the service uploads for a CLI
 * can be large, and a body is also the only place a caller's plaintext travels TO the service (a
 * value to seal). Nothing a reply carries is a human-scope plaintext — that is the rule of the ops
 * built on this (socket.ts), asserted by its tests; the framing itself only bounds sizes.
 */

export const MAX_HEADER = 64 * 1024
/** A GitHub release asset is at most 2 GiB; a body this large is refused with a sentence instead. */
export const MAX_BODY = 256 * 1024 * 1024

export interface Frame {
  header: Record<string, unknown>
  body: Uint8Array | null
}

export type FeedResult = { kind: 'need-more' } | { kind: 'frame'; frame: Frame; rest: Uint8Array } | { kind: 'error'; reason: 'header-too-large' | 'body-too-large' | 'bad-header' }

/** PURE. Encode a message. */
export function encodeFrame(header: Record<string, unknown>, body?: Uint8Array | null): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(body ? { ...header, bodyBytes: body.length } : header) + '\n')
  if (!body) return h
  const out = new Uint8Array(h.length + body.length)
  out.set(h, 0); out.set(body, h.length)
  return out
}

/**
 * Incremental decoder. `feed` appends bytes and returns the first complete frame (and what is left
 * after it), or `need-more`. Owned buffers throughout; `wipe()` zeroes what it still holds, so a
 * plaintext body that arrived on a connection that then failed does not linger.
 */
export class FrameReader {
  private buf = new Uint8Array(0)

  feed(chunk: Uint8Array): FeedResult {
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf, 0); next.set(chunk, this.buf.length)
    this.buf.fill(0)
    this.buf = next
    return this.take()
  }

  /** Try to take one frame out of what is buffered. */
  take(): FeedResult {
    const nl = this.buf.indexOf(10)
    if (nl === -1) return this.buf.length > MAX_HEADER ? { kind: 'error', reason: 'header-too-large' } : { kind: 'need-more' }
    if (nl > MAX_HEADER) return { kind: 'error', reason: 'header-too-large' }
    let header: unknown
    try { header = JSON.parse(new TextDecoder().decode(this.buf.subarray(0, nl))) } catch { return { kind: 'error', reason: 'bad-header' } }
    if (!header || typeof header !== 'object' || Array.isArray(header)) return { kind: 'error', reason: 'bad-header' }
    const h = header as Record<string, unknown>
    const n = h.bodyBytes
    if (n !== undefined && (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) return { kind: 'error', reason: 'bad-header' }
    if (typeof n === 'number' && n > MAX_BODY) return { kind: 'error', reason: 'body-too-large' }
    const need = nl + 1 + (typeof n === 'number' ? n : 0)
    if (this.buf.length < need) return { kind: 'need-more' }
    const body = typeof n === 'number' ? new Uint8Array(this.buf.subarray(nl + 1, need)) : null
    const rest = new Uint8Array(this.buf.subarray(need))
    this.buf.fill(0)
    this.buf = new Uint8Array(0)
    return { kind: 'frame', frame: { header: h, body }, rest }
  }

  wipe(): void {
    this.buf.fill(0)
    this.buf = new Uint8Array(0)
  }
}
