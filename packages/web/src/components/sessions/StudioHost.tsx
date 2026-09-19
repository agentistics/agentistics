/**
 * StudioHost — the Studio's own persistent element, physically moved between slots.
 *
 * THE PROBLEM THIS SOLVES (design §1.4, load-bearing). The Studio holds unsaved Monaco buffers that
 * exist in exactly one place in the world — its own live DOM. React reconciles by TREE POSITION, so
 * rendering `<Studio/>` once under the right slot's box and, later, once under the bottom band's box
 * are two DIFFERENT elements as far as React is concerned: the first unmounts, Monaco disposes its
 * models, and the second mounts fresh and re-reads the tree from the server. Moving the Studio
 * between `right` and `bottom` (`lib/panelSlots.ts`) must not do that.
 *
 * THE FIX is the standard "portal into a node you move yourself" pattern: this component renders
 * `<Studio/>` through `createPortal` into a plain DOM element it creates ONCE and never replaces (the
 * "carrier"). `createPortal`'s contract is that React owns the CHILDREN of the container node it is
 * given — never the container's own parent. So physically `appendChild`-ing the carrier into a
 * different real DOM box, from OUTSIDE React's render cycle, does not unmount anything inside it:
 * the Studio's React tree, its Monaco models and their undo stacks are untouched by the move, and
 * `automaticLayout` re-measures the new box on its own.
 *
 * `target` decides where the carrier currently lives:
 *   - the right slot's own box, while `layout.right === 'studio'`;
 *   - the bottom band's own box, while `layout.bottom === 'studio'` AND the band is expanded;
 *   - `null` — PARKED, in a permanent zero-size, `inert` holder this component renders itself —
 *     whenever the Studio is not currently visible (the bottom band holding it is COLLAPSED) but is
 *     still mounted, because collapsing must not be a way to lose a buffer.
 *
 * This component itself decides NOTHING about visibility or gating: the caller renders it at all
 * only once `isPanelShown(layout, 'studio')` is true (and, historically, once the reader has opened
 * it at least once — see `Studio.tsx`'s own note on being lazy), and computes `target` from the same
 * layout. Unmounting `StudioHost` is a real, final unmount — the moment the Studio is fully closed
 * (`panelSlots.ts`'s `hidePanel('studio')` / a displacing `showPanel`), which already asks first when
 * buffers are dirty.
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Studio, type StudioProps } from './Studio'

export interface StudioHostProps extends StudioProps {
  /** Where the Studio's own DOM node should physically live right now — see the module header.
   *  `null` parks it: mounted, hidden, taking no layout space anywhere. */
  target: HTMLElement | null
}

export function StudioHost({ target, ...studioProps }: StudioHostProps) {
  const parkRef = useRef<HTMLDivElement | null>(null)

  /**
   * THE CARRIER. Created exactly once for the life of this component instance — never on a
   * dependency change, never re-created because a prop changed — which is the whole point: a new
   * node here would be exactly the re-parenting-by-recreation this component exists to avoid.
   * Sized to fill whatever box it is appended into; `Studio`'s own root is already `flex: 1`, so it
   * needs a flex ancestor to resolve against in every one of its three possible homes.
   */
  const carrierRef = useRef<HTMLDivElement | null>(null)
  if (carrierRef.current === null) {
    const el = document.createElement('div')
    Object.assign(el.style, {
      display: 'flex', flexDirection: 'column',
      width: '100%', height: '100%', minWidth: '0', minHeight: '0',
    })
    carrierRef.current = el
  }

  /**
   * THE MOVE ITSELF. Runs after every commit (no dependency array — the check is cheap and a
   * dependency on `target` alone would miss the very first attach, where the parking div's ref has
   * only just been set). `appendChild` on a node that already has a parent is a MOVE in the DOM
   * spec — it detaches the node from its old parent first, so this never needs to remove it by hand.
   */
  useEffect(() => {
    const carrier = carrierRef.current
    const dest = target ?? parkRef.current
    if (carrier && dest && carrier.parentElement !== dest) dest.appendChild(carrier)
  })

  // On a REAL unmount (the Studio fully closed, or the session changed and a fresh host takes
  // over) the carrier is detached immediately rather than left appended to whatever box last held
  // it — the DOM node would otherwise sit, empty, inside a component that has moved on.
  useEffect(() => () => { carrierRef.current?.remove() }, [])

  return (
    <>
      {/* THE PARK. Zero size and `inert`, so a Studio with nowhere to be shown yet (still mounting)
          or momentarily hidden (the bottom band collapsed while it holds the Studio) takes no space
          and is unreachable to the keyboard or a screen reader — never `display: none` or
          `visibility`, which `Layer`'s own note in `Studio.tsx` already rules out for hiding this
          feature: those are fine for opacity-hiding something that never moves, and this is the one
          case where there is no "in place" to hide it, because no slot currently claims it. */}
      <div
        ref={parkRef}
        aria-hidden
        inert
        style={{ position: 'fixed', top: -99999, left: -99999, width: 0, height: 0, overflow: 'hidden' }}
      />
      {createPortal(<Studio {...studioProps} />, carrierRef.current)}
    </>
  )
}
