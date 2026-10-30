/**
 * sessionChatAlignment.lint.test.ts — the message bubbles and the composer share the same
 * left/right edges.
 *
 * Owner: "simplesmente nao ta alinhado os cards de mensagens como deveriam estar." Root cause: the
 * message scroller (`overflowY: 'auto'`) and the composer's `.ag-composer-ground` (which never
 * scrolls) each centre their OWN `maxWidth: 820` column independently. In this sandbox's headless
 * Chromium both measure identically (overlay scrollbars, 0px reserved) — but on a platform that
 * reserves scrollbar space (classic/legacy scrollbars, some Linux/Windows configurations), the
 * scroller's content box narrows by the scrollbar's width while the composer's does not, so the
 * two centred columns land at different left/right edges by exactly that width. `scrollbarGutter:
 * 'stable'` makes the scroller reserve that space UNCONDITIONALLY (even before anything actually
 * overflows), and the composer is widened to match by `chatGutterPx` — measured once via
 * `offsetWidth - clientWidth` on the scroller itself, so it is always the TRUE reserved width for
 * this viewer's browser, never a guessed constant.
 *
 * There is no arithmetic to unit-test here beyond what the browser's own box model already
 * guarantees (a `scrollbarGutter: 'stable'` scroller minus `chatGutterPx` of padding on the
 * composer are the same width by construction) — so per the "say so plainly instead of writing a
 * test that only restates the stylesheet" instruction, this file does NOT re-derive that
 * arithmetic. It asserts the two things the fix actually depends on staying wired together: the
 * scroller opts into a stable gutter, and the composer's padding is not a bare constant but carries
 * the measured gutter forward. Both were confirmed live (Playwright, 1440x900 and 390x844): the
 * message column and the composer column measured pixel-identical in both viewports.
 *
 * Not reachable by rendering — `packages/web` has no jsdom. The two facts are asserted over
 * comment-free source, with each planted back to its pre-fix shape to prove the scan still catches
 * it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../lib/stripComments'

const RAW = readFileSync(join(import.meta.dir, 'SessionChat.tsx'), 'utf-8')
const SRC = stripComments(RAW)

describe('the message list and the composer resolve to the same column width', () => {
  test('the scroller reserves a stable scrollbar gutter', () => {
    expect(SRC).toContain("scrollbarGutter: 'stable',")
  })

  test('the gutter width is measured off the scroller itself, not assumed', () => {
    expect(SRC).toContain('setChatGutterPx(el.offsetWidth - el.clientWidth)')
  })

  test("the composer's own padding carries the measured gutter forward", () => {
    expect(SRC).toContain('paddingRight: 20 + chatGutterPx,')
  })

  test('the scan still sees the pre-fix bare-constant padding reintroduced', () => {
    const planted = SRC.replace(
      'paddingTop: 10, paddingRight: 20 + chatGutterPx, paddingBottom: 0, paddingLeft: 20,',
      "padding: '10px 20px 16px',",
    )
    expect(planted).not.toContain('paddingRight: 20 + chatGutterPx,')
  })

  test('the scan still sees the scroller reverted to a plain `overflowY: auto`', () => {
    const planted = SRC.replace("scrollbarGutter: 'stable',\n", '')
    expect(planted).not.toContain("scrollbarGutter: 'stable',")
  })
})
