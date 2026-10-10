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
import { useIsMobile } from '../../hooks/useIsMobile'
import { HarnessMark } from './HarnessMark'
import { Muted } from './formBits'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import { mostRoom, type PlanLimits } from '@agentistics/core'
import { PlanLimitsBlock } from '../PlanLimitMeter'

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
  /** PLAN.LIMITS: each harness's plan windows (`usePlanLimits`). A harness with a record draws
   *  them under its name, with the at-current-pace forecast; the one with most room is marked. */
  planLimits?: readonly PlanLimits[] | null
  /** The clock the forecast is read against (the store's minute tick). */
  now?: number
}

export function HarnessPicker({ lang, harnesses, value, onChange, notice, onRetry, onInstall, planLimits, now = Date.now() }: HarnessPickerProps) {
  const pt = lang === 'pt'
  const roomiest = planLimits ? mostRoom(planLimits, now) : null
  const isMobile = useIsMobile()

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
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {harnesses.map(h => {
        const on = value === h.id
        const color = (HARNESS_COLORS as Record<string, string>)[h.id] ?? 'var(--text-secondary)'
        const name = (HARNESS_LABELS as Record<string, string>)[h.id] ?? h.label
        const missing = h.installed === false
        const limits = missing ? undefined : planLimits?.find(l => l.harness === h.id)
        // ONE chip per harness. A missing one is greyed and its click opens the install flow, with a
        // small inline "Instalar" saying so — it is never a second control beside the chip.
        return (
          <button
            key={h.id}
            type="button"
            title={missing ? (pt ? `${name} não está instalado — clique para instalar` : `${name} is not installed — click to install`) : undefined}
            onClick={() => (missing ? onInstall?.(h.id) : onChange(h.id))}
            data-harness-card={h.id}
            style={{
              display: 'flex', alignItems: limits ? 'stretch' : 'center', gap: 8,
              ...(limits ? { flexDirection: 'column' as const, flex: isMobile ? '1 1 100%' : '1 1 250px', maxWidth: isMobile ? undefined : 340, textAlign: 'left' as const } : {}),
              padding: '9px 13px', borderRadius: 10, cursor: 'pointer',
              border: `1px ${missing ? 'dashed' : 'solid'} ${on ? color : 'var(--border-subtle)'}`,
              background: on ? `color-mix(in srgb, ${color} 14%, transparent)` : 'var(--bg-elevated)',
              color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 650 : 500,
              opacity: missing ? 0.62 : 1,
              minHeight: isMobile ? 44 : undefined,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HarnessMark harness={h.id} size={18} />
            {name}
            {limits && roomiest === h.id && (
              <span style={{
                marginLeft: 'auto', fontSize: 10.5, fontWeight: 650, padding: '1px 7px', borderRadius: 999,
                color: 'var(--accent-green)', background: 'color-mix(in srgb, var(--accent-green) 14%, transparent)',
              }}>{pt ? 'mais folga' : 'most room'}</span>
            )}
            </span>
            {limits && <PlanLimitsBlock limits={limits} now={now} lang={lang} forecast />}
            {missing && (
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--anthropic-orange)', marginLeft: 2 }}>
                {pt ? 'Instalar' : 'Install'}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
