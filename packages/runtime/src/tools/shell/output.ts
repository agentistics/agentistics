/**
 * tools/shell/output.ts — PURE: how much of a command's output the model gets back, and what it is
 * told about the rest (spec §2 D-T2: "output is tiered and truncated with the original size
 * reported, so the model knows what it did not see").
 *
 * ## Why head AND tail, and why bounded while it is being collected
 *
 * The first lines of a build say what it was doing and the last lines say how it ended; the middle
 * is where a 40 MB log lives. So a window keeps a HEAD and a TAIL of at most half the budget each and
 * drops the middle, saying in bytes how much it cut. It is bounded AS IT COLLECTS, not when it is
 * read: a yielded `npm test --watch` can run for hours between two `shell.read`s, and holding every
 * byte of that in memory to throw most of it away later is the leak this shape exists to avoid.
 *
 * Bytes, not characters, because `originalBytes` is what the spec reports. A cut can fall inside a
 * multi-byte character; the decoder then shows U+FFFD at the seam, which is honest about the cut.
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 30_000
/** The ceiling a caller may ask for; a larger request is clamped to it. */
export const MAX_OUTPUT_BYTES_CEILING = 1_000_000

export interface TakenOutput {
  output: string
  outputTruncated: boolean
  /** Every byte the process produced in this window, including the ones cut. */
  originalBytes: number
}

export function cutNote(cut: number, total: number): string {
  return `\n… [${cut} bytes cut from the middle — ${total} bytes in all] …\n`
}

/** One window of output: everything produced since the last `take`. */
export class OutputWindow {
  private head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  private total = 0
  private readonly headCap: number
  private readonly tailCap: number

  constructor(readonly capacity: number = DEFAULT_MAX_OUTPUT_BYTES) {
    this.headCap = Math.floor(capacity / 2)
    this.tailCap = capacity - this.headCap
  }

  get bytes(): number {
    return this.total
  }

  push(text: string): void {
    if (text.length === 0) return
    let b = Buffer.from(text, 'utf8')
    this.total += b.length
    const room = this.headCap - this.headBytes
    if (room > 0) {
      const part = b.subarray(0, room)
      this.head.push(part)
      this.headBytes += part.length
      b = b.subarray(part.length)
    }
    if (b.length === 0) return
    this.tail.push(b)
    this.tailBytes += b.length
    while (this.tailBytes > this.tailCap) {
      const first = this.tail[0]!
      const excess = this.tailBytes - this.tailCap
      if (first.length <= excess) {
        this.tail.shift()
        this.tailBytes -= first.length
      } else {
        this.tail[0] = first.subarray(excess)
        this.tailBytes -= excess
      }
    }
  }

  /**
   * The window as the model reads it, cut to `max` bytes (never more than the window kept). Does not
   * reset — see `drain`.
   */
  peek(max: number = this.capacity): TakenOutput {
    const head = Buffer.concat(this.head)
    const tail = Buffer.concat(this.tail)
    const limit = Math.max(0, Math.min(max, this.capacity))
    if (this.total <= limit) {
      return { output: decode(Buffer.concat([head, tail])), outputTruncated: false, originalBytes: this.total }
    }
    const hb = Math.floor(limit / 2)
    const tb = limit - hb
    const h = head.subarray(0, Math.min(hb, head.length))
    const t = tail.subarray(Math.max(0, tail.length - tb))
    const cut = this.total - h.length - t.length
    return {
      output: decode(h) + cutNote(cut, this.total) + decode(t),
      outputTruncated: true,
      originalBytes: this.total,
    }
  }

  /** `peek`, then start a fresh window: the next read sees only what arrives after this one. */
  drain(max?: number): TakenOutput {
    const taken = this.peek(max)
    this.head = []
    this.headBytes = 0
    this.tail = []
    this.tailBytes = 0
    this.total = 0
    return taken
  }
}

function decode(b: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(b)
}
