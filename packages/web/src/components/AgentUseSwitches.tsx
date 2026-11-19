/**
 * AgentUseSwitches — the TWO switches that say how agents use an account (CONTAS.AGENDA-SALVAR):
 *
 * - "Agenda": the master. Off = agents never use the account, whatever else is set.
 * - "Sobrescrever a agenda": sticky. On = free at any hour; the schedule is kept, not erased.
 *   Disabled (and said so) while the Agenda is off — it releases nothing then.
 *
 * Two layouts of ONE component: the `card` (the account drawer, switches edit a DRAFT saved by the
 * drawer's single Save, with the "Agora" line) and the `inline` pair (the plan popup and the Nay
 * Limits card, where each switch writes at once). The rule behind them is the server's.
 */
import { ToggleSwitch } from './ToggleSwitch'
import { agentUseNow, type NowKind } from '../lib/agentUseDraft'
import type { AgentUseView } from '../lib/agentScheduleView'

type Lang = 'pt' | 'en'

const PILL: Record<NowKind, React.CSSProperties> = {
  ok: { background: 'color-mix(in srgb, var(--accent-green) 14%, transparent)', color: 'var(--accent-green)' },
  free: { background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange-light)' },
  off: { background: 'var(--ag-tint-3)', color: 'var(--text-secondary)' },
}

export function NowPill({ kind, text }: { kind: NowKind; text: string }) {
  return <span data-agent-now-pill={kind} style={{ padding: '2px 9px', borderRadius: 99, fontWeight: 600, fontSize: 11.5, overflowWrap: 'anywhere', ...PILL[kind] }}>{text}</span>
}

export function AgentUseSwitches({ enabled, override, view, onEnabled, onOverride, disabled = false, lang, isMobile = false, who, layout = 'card' }: {
  enabled: boolean
  override: boolean
  /** The server's verdict, for the "Agora" line. */
  view?: AgentUseView
  onEnabled: (next: boolean) => void
  onOverride: (next: boolean) => void
  /** A write is in flight (popup / card layouts). */
  disabled?: boolean
  lang: Lang
  isMobile?: boolean
  /** The account's name as the screen shows it, for the switches' accessible names. */
  who: string
  layout?: 'card' | 'inline'
}) {
  const pt = lang === 'pt'
  const tap = isMobile ? 44 : undefined
  const now = agentUseNow(view, { enabled, override }, lang)
  const L = {
    agenda: pt ? 'Agenda' : 'Schedule',
    over: pt ? 'Sobrescrever a agenda' : 'Override the schedule',
    agendaOn: pt ? 'Os agentes usam esta conta nos dias e horários abaixo.' : 'Agents use this account on the days and hours below.',
    agendaOff: pt ? 'Desligada: os agentes não usam esta conta, em hora nenhuma.' : 'Off: agents do not use this account, at any hour.',
    overNeedsAgenda: pt ? 'Ligue a agenda primeiro.' : 'Turn the schedule on first.',
    overOn: pt ? 'Uso livre: os agentes usam a qualquer hora. Desligue para voltar à agenda.' : 'Free use: agents use it at any hour. Turn it off to return to the schedule.',
    overOff: pt ? 'Libera a conta a qualquer hora, ignorando a agenda. A agenda fica guardada.' : 'Frees the account at any hour, ignoring the schedule. The schedule is kept.',
    now: pt ? 'Agora' : 'Now',
  }
  if (layout === 'inline') {
    return <div data-agent-use-switches="inline" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5, color: 'var(--text-secondary)' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        <ToggleSwitch on={enabled} disabled={disabled} onToggle={() => onEnabled(!enabled)} tap={tap} label={`${L.agenda} · ${who}`} />{L.agenda}
      </label>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, opacity: enabled ? 1 : 0.4 }}>
        <ToggleSwitch on={override && enabled} disabled={disabled || !enabled} onToggle={() => onOverride(!override)} tap={tap} label={`${L.over} · ${who}`} />{L.over}
      </label>
    </div>
  }
  const row = (name: string, desc: string, on: boolean, off: boolean, toggle: () => void, dim: boolean) => (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px' }}>
      <div style={{ flex: 1, minWidth: 0, opacity: dim ? 0.45 : 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{name}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>{desc}</div>
      </div>
      <ToggleSwitch on={on} disabled={off} onToggle={toggle} tap={tap} label={`${name} · ${who}`} />
    </div>
  )
  return <div data-agent-use-switches="card" style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-card)', overflow: 'hidden' }}>
    {row(L.agenda, enabled ? L.agendaOn : L.agendaOff, enabled, disabled, () => onEnabled(!enabled), false)}
    <div style={{ borderTop: '1px solid var(--border)' }}>
      {row(L.over, !enabled ? L.overNeedsAgenda : override ? L.overOn : L.overOff, override && enabled, disabled || !enabled, () => onOverride(!override), !enabled)}
    </div>
    <div data-agent-now style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '9px 14px', borderTop: '1px solid var(--border)', background: 'var(--ag-tint-1)', fontSize: 12 }}>
      <span style={{ color: 'var(--text-tertiary)' }}>{L.now}</span><NowPill kind={now.kind} text={now.text} />
    </div>
  </div>
}
