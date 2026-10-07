export interface ModeMenuEntry {
  id: string
  label: string
}

const MODES: Record<string, ModeMenuEntry[]> = {
  claude: [
    { id: 'manual', label: 'manual mode' },
    { id: 'accept-edits', label: 'accept edits' },
    { id: 'plan', label: 'plan mode' },
    { id: 'auto', label: 'auto mode' },
  ],
}

/** Modes the server has measured for a harness. Unknown harnesses intentionally have no menu. */
export function modeMenuFor(harness: string | undefined): readonly ModeMenuEntry[] {
  return harness ? (MODES[harness] ?? []) : []
}

/** Number of next-mode actions needed to reach a target in the cyclic mode order. */
export function modeCycles(current: string, target: string, modes: readonly ModeMenuEntry[]): number {
  const from = modes.findIndex(mode => mode.id === current)
  const to = modes.findIndex(mode => mode.id === target)
  if (from < 0 || to < 0 || modes.length === 0) return 0
  return (to - from + modes.length) % modes.length
}

export interface MenuPlacement {
  left: number
  top: number
  width: number
}

/** Places a small fixed mode menu without letting it cross the viewport margins. */
export function modeMenuPlacement(
  rect: Pick<DOMRect, 'left' | 'bottom'>,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 190,
  menuHeight = 220,
  margin = 8,
): MenuPlacement {
  const width = Math.min(menuWidth, Math.max(0, viewportWidth - margin * 2))
  const left = Math.max(margin, Math.min(rect.left, viewportWidth - margin - width))
  const down = rect.bottom + 4
  const top = down + menuHeight <= viewportHeight - margin
    ? down
    : Math.max(margin, viewportHeight - margin - menuHeight)
  return { left, top, width }
}
