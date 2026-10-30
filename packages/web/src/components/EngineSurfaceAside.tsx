import type { ReactNode } from 'react'
import { TabStrip } from './sessions/formBits'
import { EngineSurfaceSideSlot } from './EngineSurfaceHost'

/**
 * The right aside's frame when an engine surface may be drawn as one of its sections.
 *
 * ONE STABLE TREE in every state: the wrapper, the strip position, the slot box and the box around
 * `children` are always the same elements at the same positions, only shown or hidden. Opening or
 * closing a side surface therefore never remounts what the aside already holds (a terminal's
 * scrollback, the Studio carrier, a Contents tab). With `engine === null` the slot and the strip are
 * absent and `children` is the only thing visible.
 */
export interface EngineAsideSection {
  sessionId: string
  slotId: string
  label: string
  /** Whether this aside's slot is the one the surface was mounted into (two panes, one session). */
  owned: boolean
}

export function EngineSurfaceAside({ engine, shown, panelsLabel, onPickEngine, onPickPanels, showStrip, children }: {
  engine: EngineAsideSection | null
  /** The engine section is the selected one. Ignored unless `engine` is owned. */
  shown: boolean
  panelsLabel: string
  onPickEngine: () => void
  onPickPanels: () => void
  /** False on a phone: the aside already has its own panel switcher there, a second row is not added. */
  showStrip: boolean
  children?: ReactNode
}) {
  const engineVisible = engine !== null && engine.owned && shown
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      {engine !== null && engine.owned && showStrip ? (
        <div style={{ padding: '6px 8px 0', flexShrink: 0 }}>
          <TabStrip
            tabs={['engine', 'panels'] as const}
            value={shown ? 'engine' : 'panels'}
            onPick={t => (t === 'engine' ? onPickEngine() : onPickPanels())}
            label={t => (t === 'engine' ? engine.label : panelsLabel)}
          />
        </div>
      ) : null}
      <div style={{ display: engineVisible ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
        {engine !== null ? <EngineSurfaceSideSlot sessionId={engine.sessionId} slotId={engine.slotId} /> : null}
      </div>
      <div style={{ display: engineVisible ? 'none' : 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
        {children}
      </div>
    </div>
  )
}
