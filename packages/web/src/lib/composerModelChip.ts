/**
 * THE MODEL, VISIBLE IN THE PHONE'S COMPOSER — when it fits.
 *
 * Measured on a 390px screen: margins, border and padding leave 364px for the composer's control
 * row; six 44px controls, a 76px chip and six 3px gaps take 358px. Below 360px of viewport the chip
 * no longer fits beside the rest, and it goes back to where it always was — the model list inside
 * "More", which never stopped carrying it. So this decides only whether the SHORTCUT is drawn; the
 * list itself is never moved.
 *
 * Desktop never draws it: there the model lives in "More" exactly as before (one pixel of change on
 * the desktop composer is out of scope for this piece).
 */

export const MODEL_CHIP_MIN_VIEWPORT = 360

export function modelChipShown(
  { isMobile, viewportWidth, answeringNow, canSwitch }: {
    isMobile: boolean; viewportWidth: number; answeringNow: boolean
    /** A model list (or a typed id) is on offer for this harness — the menu would show one. */
    canSwitch: boolean
  },
): boolean {
  return isMobile && viewportWidth >= MODEL_CHIP_MIN_VIEWPORT && !answeringNow && canSwitch
}

/** The chip's face: the model's short name, or the word when nothing has named one yet. */
export function modelChipLabel(display: string | undefined, pt: boolean): string {
  const name = display?.trim()
  if (!name) return pt ? 'Modelo' : 'Model'
  // "Opus 5.5" reads as "Opus" at a glance; the full name is in the menu one tap away.
  const first = name.split(/\s+/)[0]!
  return first
}
