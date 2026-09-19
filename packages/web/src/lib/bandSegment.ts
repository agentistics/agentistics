/**
 * bandSegment.ts — which entries the bottom band's own `Claude Code | Shell | Studio` segment
 * offers, and which one is lit (design item 2, screenshot 2 — "when I open the Studio it disappears
 * from the tab menu").
 *
 * THE BUG THIS FIXES. The docked band's segment (`ShellBand.tsx`'s `dockedTargetSwitch`) already drew
 * all three whenever the band showed `cli`/`shell`, Studio included as the unlit third option. But
 * the MOMENT Studio became the band's own occupant, a SEPARATE small bar (`SessionPanel.tsx`'s
 * `StudioBand`) took over and drew its OWN two-item tablist — Claude Code and Shell only, because
 * "which other target can I switch to" was answered by hand a second time and Studio was never asked
 * about itself. Two implementations of one segment is how one of them quietly stopped listing all
 * three.
 *
 * ONE PURE FUNCTION, called from both bars, is what makes that impossible to repeat: whichever bar is
 * currently drawing the segment hands in its own occupant and gates, and gets back the same three
 * (fewer if a gate is actually closed) with the occupant marked `on` — never fewer because of WHICH
 * bar happened to be asking.
 */

export type BandTarget = 'cli' | 'shell' | 'studio'

export interface BandSegmentEntry {
  id: BandTarget
  on: boolean
}

/** Which of the three the segment may ever offer right now. `cli` absent means the session is
 *  relayed (no stream of its own); `shell` absent means the shell is off or relayed; `studio` absent
 *  means the editor gate is closed. A bar that cannot show a target at all does not mount this
 *  segment in the first place — this only decides what to list once it does. */
export interface BandSegmentOffered {
  cli: boolean
  shell: boolean
  studio: boolean
}

/**
 * The segment's entries, in the fixed `cli, shell, studio` order, whichever of `occupant`'s siblings
 * are actually offered. The occupant itself is always `on` — a bar can only ever be asked to draw
 * the segment for what it is CURRENTLY showing.
 */
export function bandSegmentEntries(
  occupant: BandTarget, offered: BandSegmentOffered,
): BandSegmentEntry[] {
  const order: BandTarget[] = ['cli', 'shell', 'studio']
  return order.filter(id => offered[id]).map(id => ({ id, on: id === occupant }))
}
