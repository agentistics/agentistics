/**
 * browser-frame-check.ts — is a screencast frame the SIZE the page is at now? (NAVEGADOR S5c r4)
 *
 * PURE. Chromium, right after `Emulation.setDeviceMetricsOverride` + `Page.startScreencast`, sometimes emits a
 * FIRST frame whose JPEG was rendered at the previous backing size while its metadata already states the new
 * viewport (measured 2026-11-16: `meta=1596x400 jpeg=718x400`, `meta=1314x400 jpeg=718x400`). A still page then
 * sends nothing after it, so the card kept a picture of the wrong size for good — black bars. The only honest
 * judge is the pixels themselves, so the SOF header of the JPEG is read and compared with what the page
 * reports and with what the viewer was given.
 */

export interface Dims { w: number; h: number }

/** Width and height from the first SOF marker of a base64 JPEG, or `null` when it cannot be read. */
export function jpegDims(b64: string): Dims | null {
  if (typeof b64 !== 'string' || b64.length < 24) return null
  // the SOF sits in the first few KB (after APPn/DQT/DHT); 12k base64 chars = 9k bytes is ample
  const b = Buffer.from(b64.slice(0, 12_000), 'base64')
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue }
    const m = b[i + 1]!
    if (m === 0xff) { i++; continue }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = b.readUInt16BE(i + 5), w = b.readUInt16BE(i + 7)
      return w > 0 && h > 0 ? { w, h } : null
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue }
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

/** Aspect tolerance: rounding to whole pixels, and the screencast scaling to maxWidth/maxHeight. */
export const ASPECT_TOLERANCE = 0.02
/** Whole CSS pixels of slack between the page's own report and the size the viewer asked for. */
export const SIZE_SLACK_PX = 2

/**
 * `true` when the frame is NOT the picture of the page as it is now:
 *  - its pixels do not have the aspect of the viewport the metadata states (rendered at an older size), or
 *  - the metadata itself differs from the viewport the cast applied (`expected`) — a frame of the previous size
 *    that was already in flight when the viewport changed.
 * What cannot be told (unreadable JPEG, no metadata) is NOT stale: a check that cannot answer must not drop frames.
 */
export function isStaleFrame(f: { jpeg: Dims | null; meta: Dims; expected?: Dims | null }): boolean {
  const { jpeg, meta, expected } = f
  if (expected && meta.w > 0 && meta.h > 0 && (Math.abs(meta.w - expected.w) > SIZE_SLACK_PX || Math.abs(meta.h - expected.h) > SIZE_SLACK_PX)) return true
  if (jpeg && meta.w > 0 && meta.h > 0) {
    const a = jpeg.w / jpeg.h, b = meta.w / meta.h
    if (Math.abs(a - b) / b > ASPECT_TOLERANCE) return true
  }
  return false
}
