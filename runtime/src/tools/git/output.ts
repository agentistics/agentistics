/**
 * tools/git/output.ts — PURE. Bounding a git call's text output while STATING the original size
 * (spec §4's `ShellResult` carries the same shape: `outputTruncated` + `originalBytes`, and D-T6
 * asks for the same honesty on git output — "the model knows what it did not see").
 */

export interface BoundedText {
  text: string
  truncated: boolean
  /** The size of the UNTRUNCATED text, in bytes — reported even when nothing was cut. */
  originalBytes: number
}

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes. Slices the byte buffer (never the JS string
 * directly, whose `.length` counts UTF-16 code units) so the byte budget is exact; a multi-byte
 * character straddling the cut point may decode as a single U+FFFD replacement at the tail, which
 * is an acceptable cost for a BOUNDED PREVIEW that already tells the reader it was cut.
 */
export function boundText(text: string, maxBytes: number): BoundedText {
  const originalBytes = Buffer.byteLength(text, 'utf8')
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes }
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  return { text: cut, truncated: true, originalBytes }
}
