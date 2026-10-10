/**
 * HarnessPicker — the assistant card grid, pulled out of `NewSessionModal`'s step 1 so a second
 * dialog that needs "which assistant" does not fall back to a native `<select>` (see
 * `formBits.tsx`'s own note on what a restated control costs).
 *
 * A bare `<select>` draws the platform's own menu — it ignores this application's palette in both
 * themes, cannot show the harness's mark, and is the one control that misses the 44px mobile
 * target every other row in these dialogs meets. This is a row of cards instead: the same shape
 * `NewSessionModal` always used, just no longer copied by hand.
 */
import { useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HarnessMark } from './HarnessMark'
import { Muted } from './formBits'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import { mostRoom, type PlanLimits } from '@agentistics/core'
import { PlanLimitsTooltip } from '../PlanLimitMeter'

export interface HarnessPickerOption {
  id: string
  label: string
  installed?: boolean
}

export interface HarnessPickerProps {
  lang: 'pt' | 'en'
  /** `null` while the machine is still being asked what it can start; `[]` once it has looked and
   *  found nothing startable — two different sentences, never a shared empty grid. */
  harnesses: readonly HarnessPickerOption[] | null
  /** The chosen harness's id, or `''` for "none chosen yet". */
  value: string
  onChange: (id: string) => void
  /**
   * The server's own sentence for WHY the list is empty, when that is a fault rather than a fact —
   * e.g. a service whose PATH reaches no assistant at all, which names the PATH it sees. Shown in
   * place of the generic "nothing was found", which would send someone to reinstall a tool that is
   * installed.
   */
  notice?: string
  onRetry?: () => void
  onInstall?: (id: string) => void
  /** PLAN.LIMITS: each harness's plan windows (`usePlanLimits`). The chip keeps its shape; the one
   *  with most room wears a small "mais folga" tag, and hovering a chip shows its windows. */
  planLimits?: readonly PlanLimits[] | null
  /** The clock the forecast is read against (the store's minute tick). */
  now?: number
}

export function HarnessPicker({ lang, harnesses, value, onChange, notice, onRetry, onInstall, planLimits, now = Date.now() }: HarnessPickerProps) {
  const pt = lang === 'pt'
  const roomiest = planLimits ? mostRoom(planLimits, now) : null
  const known = (harnesses ?? []).filter(h => h.installed !== false).map(h => h.id)
  const shown = (planLimits ?? []).filter(l => known.includes(l.harness))
  const isMobile = useIsMobile()
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)

  if (harnesses === null) {
    return <Muted text={pt ? 'Vendo o que está instalado…' : 'Checking what is installed…'} />
  }
  if (harnesses.length === 0) {
    // Not an empty picker: the machine looked and found nothing it knows how to start.
    if (notice) return <>
      <Muted text={notice} />
      {onRetry && <button type="button" onClick={onRetry} style={{ alignSelf: 'flex-start', padding: '7px 11px', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
        {pt ? 'Tentar de novo' : 'Try again'}
      </button>}
    </>
    return <Muted text={pt
      ? 'Nenhum assistente que o agentop saiba iniciar foi encontrado nesta máquina.'
      : 'No assistant agentop knows how to start was found on this machine.'} />
  }

  return (
    // On a phone the chips are a two-column grid (owner, 2026-10-10): a wrapped row of chips of
    // different widths left ragged gaps, worse once the "mais folga" tag widened one of them.
    <div style={isMobile
      ? { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 8, rowGap: 12, paddingTop: 4 }
      : { display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {harnesses.map(h => {
        const on = value === h.id
        const color = (HARNESS_COLORS as Record<string, string>)[h.id] ?? 'var(--text-secondary)'
        const name = (HARNESS_LABELS as Record<string, string>)[h.id] ?? h.label
        const missing = h.installed === false
        const limits = missing ? undefined : shown.find(l => l.harness === h.id)
        // The limits open on HOVER (owner, 2026-10-09: bars inside every chip were too much). A
        // phone has no hover, so there they are read on the wizard's last step instead.
        const peek = (e: React.SyntheticEvent<HTMLElement>) => {
          if (!limits || isMobile) return
          const r = e.currentTarget.getBoundingClientRect()
          setHover({ id: h.id, x: r.left, y: r.top - 6 })
        }
        // ONE chip per harness. A missing one is greyed and its click opens the install flow, with a
        // small inline "Instalar" saying so — it is never a second control beside the chip.
        return (
          <button
            key={h.id}
            type="button"
            title={missing ? (pt ? `${name} não está instalado — clique para instalar` : `${name} is not installed — click to install`) : undefined}
            onClick={() => (missing ? onInstall?.(h.id) : onChange(h.id))}
            onMouseEnter={peek} onFocus={peek}
            onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}
            data-harness-card={h.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '9px 13px', borderRadius: 10, cursor: 'pointer',
              border: `1px ${missing ? 'dashed' : 'solid'} ${on ? color : 'var(--border-subtle)'}`,
              background: on ? `color-mix(in srgb, ${color} 14%, transparent)` : 'var(--bg-elevated)',
              color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 650 : 500,
              opacity: missing ? 0.62 : 1,
              minHeight: isMobile ? 44 : undefined,
              ...(isMobile ? { minWidth: 0, padding: '9px 10px', position: 'relative' as const } : {}),
            }}
          >
            <HarnessMark harness={h.id} size={18} />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{name}</span>
            {limits && roomiest === h.id && (
              <span data-most-room style={{
                flexShrink: 0, fontSize: 10, fontWeight: 650, padding: '0 6px', borderRadius: 999, lineHeight: '16px',
                color: 'var(--accent-green)', background: 'color-mix(in srgb, var(--accent-green) 14%, transparent)',
                // On a phone the tag sits ON the chip's top edge, so a half-width chip keeps its name.
                ...(isMobile ? { position: 'absolute' as const, top: -8, right: 8, background: 'var(--bg-elevated)', border: '1px solid color-mix(in srgb, var(--accent-green) 45%, transparent)' } : {}),
              }}>{pt ? 'mais folga' : 'most room'}</span>
            )}
            {missing && (
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--anthropic-orange)', marginLeft: 2 }}>
                {pt ? 'Instalar' : 'Install'}
              </span>
            )}
          </button>
        )
      })}
      {hover && (() => {
        const l = shown.find(x => x.harness === hover.id)
        return l ? <PlanLimitsTooltip limits={l} now={now} lang={lang} x={hover.x} y={hover.y} /> : null
      })()}
    </div>
  )
}
