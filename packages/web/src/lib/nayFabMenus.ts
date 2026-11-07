/**
 * nayFabMenus.ts — the two things that rise from the Nay button never stand open together.
 *
 * The hover "Minimizadas" list (`MinimizedMenu`) and the right-click pop (`VaultFabPop`: call Nay + vault) sit
 * above the same button, ~10px apart, so both open covered the list's rows with the pop (re-QA N2). The LAST one
 * opened wins: opening the list sinks the pop, and summoning the pop closes the list. Each side reports when it
 * opens and is told to yield while the other is open, so neither knows how the other works.
 */
import { useState } from 'react'

export interface FabMenusExclusion {
  /** Pass to `MinimizedMenu`. */
  menu: { onOpenChange: (open: boolean) => void; closeWhen: boolean }
  /** Pass to `VaultFabPop`. */
  pop: { onShownChange: (shown: boolean) => void; dismissWhen: boolean }
}

export function useFabMenusExclusion(): FabMenusExclusion {
  const [menuOpen, setMenuOpen] = useState(false)
  const [popShown, setPopShown] = useState(false)
  return {
    menu: { onOpenChange: setMenuOpen, closeWhen: popShown },
    pop: { onShownChange: setPopShown, dismissWhen: menuOpen },
  }
}
