import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A row in the sessions aside must never opt out of native touch panning.
 *
 * `touch-action: none` on a row wrapper makes a swipe that STARTS on that row a no-op: the browser
 * is told this element handles its own gestures, so the aside's scroller never receives the pan.
 * Measured with real touch input at 390px (CDP `Input.dispatchTouchEvent`): rows carrying it
 * scrolled the list 0 px, the folder header and plain headings scrolled ~156 px. Native HTML5
 * drag on touch starts from a long press and does not need `touch-action: none`, so the only
 * element that may carry it is the dedicated drag GRIP.
 */
const SRC = readFileSync(join(import.meta.dir, 'SessionsAside.tsx'), 'utf8')

describe('SessionsAside touch scrolling', () => {
  test('touch-action: none appears only on the folder drag grip', () => {
    const hits = [...SRC.matchAll(/touchAction:\s*'none'/g)]
    expect(hits.length).toBe(1)
    const at = hits[0]!.index!
    // The surviving one sits inside the grip span (the only element with the "Drag to reorder" title).
    const grip = SRC.indexOf("'Drag to reorder'")
    expect(grip).toBeGreaterThan(-1)
    expect(at - grip).toBeLessThan(600)
    expect(at).toBeGreaterThan(grip)
  })
})
