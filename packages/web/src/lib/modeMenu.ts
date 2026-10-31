export interface ModeMenuEntry {
  id: string
  label: string
  /** Absent for the terminal table: it is the harness's own words. */
  canonical?: import('@agentistics/core').CanonicalMode
}

const MODES: Record<string, ModeMenuEntry[]> = {
  claude: [
    { id: 'manual', label: 'manual mode', canonical: 'default' },
    { id: 'accept-edits', label: 'accept edits', canonical: 'accept-edits' },
    { id: 'plan', label: 'plan mode', canonical: 'plan' },
    // MODE.NOQ — reachable because managed claude sessions start with `--allow-dangerously-skip-permissions`;
    // a session started before that is refused in words by the server (`cycleToMode`), never mis-cycled.
    { id: 'bypass', label: 'bypass permissions', canonical: 'no-questions' },
    // Claude's classifier-driven auto mode has no canonical twin; "Auto" reads the same in both languages.
    { id: 'auto', label: 'Auto' },
  ],
}

/** Modes the server has measured for a harness. Unknown harnesses intentionally have no menu. */
export function modeMenuFor(harness: string | undefined): readonly ModeMenuEntry[] {
  return harness ? (MODES[harness] ?? []) : []
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

/**
 * Whether the mode chip is drawn and pressable. A session with an approval card open cannot take a PROMPT, but a
 * STRUCTURED one (its protocol lists its modes: `direct`) can still be SWITCHED — and the engine answers the open
 * request by the new mode, so the card is a reason to switch, not a reason to lock the chip. A terminal row has
 * only a cycle key typed into the very dialog, so it stays locked while one is open.
 */
export function modeChipState(o: {
  hasMode: boolean
  loading: boolean
  live: boolean
  canPrompt: boolean
  blocked: boolean
  answering: boolean
  direct: boolean
}): { shown: boolean; enabled: boolean } {
  const shown = o.hasMode && (!o.answering || o.direct)
  const enabled = shown && !o.loading && o.live && (o.canPrompt || (o.blocked && o.direct))
  return { shown, enabled }
}
