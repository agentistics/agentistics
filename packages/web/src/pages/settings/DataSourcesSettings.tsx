import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { SurfaceHarnessId } from '@agentistics/core'
import type { AppContext } from '../../lib/app-context'
import { HARNESS_LABELS, HARNESS_COLORS } from '../../lib/harness'
import { HarnessInfoPanel } from '../../components/HarnessInfoPanel'
import { SectionHeader } from './primitives'
import { NATIVE_HARNESS_ID, surfaceHarnesses } from '@agentistics/core'

export default function DataSourcesSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const harnesses = ctx.data.harnesses
  // `ctx.data` is gated by `useData` (`withoutHiddenNative`): the native entry exists only when it may be seen.
  const order: SurfaceHarnessId[] = surfaceHarnesses(harnesses.includes(NATIVE_HARNESS_ID))
  const present = order.filter(h => harnesses.includes(h))
  const [selected, setSelected] = useState<SurfaceHarnessId>(present[0] ?? 'claude')

  if (present.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', textAlign: 'center', padding: '24px 0' }}>
        {pt ? 'Nenhum harness com dados ainda.' : 'No harness data yet.'}
      </div>
    )
  }

  const active = present.includes(selected) ? selected : present[0]!

  return (
    <div>
      <SectionHeader label={pt ? 'Dados & fontes' : 'Data & sources'} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
        {pt
          ? 'De onde vêm as métricas de cada harness, o que é capturado e o que falta (e por quê).'
          : 'Where each harness’s metrics come from, what is captured, and what is missing (and why).'}
      </p>

      {/* Per-harness selector — only shown when more than one harness has data */}
      {present.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {present.map(h => {
            const isActive = h === active
            const color = HARNESS_COLORS[h]
            return (
              <button
                key={h}
                onClick={() => setSelected(h)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 12, fontWeight: 600,
                  border: `1px solid ${isActive ? color : 'var(--border)'}`,
                  background: isActive ? `${color}1f` : 'var(--bg-elevated)',
                  color: isActive ? color : 'var(--text-secondary)',
                }}
              >
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                  background: color, flexShrink: 0,
                }} />
                {HARNESS_LABELS[h]}
              </button>
            )
          })}
        </div>
      )}

      <HarnessInfoPanel harness={active} lang={pt ? 'pt' : 'en'} />
    </div>
  )
}
