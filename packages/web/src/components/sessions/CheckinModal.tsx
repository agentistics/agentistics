/**
 * CheckinModal — the leader's check-in report in the app's own dialog shell (`Sheet`: a centred
 * dialog on desktop, a full-height sheet at phone width).
 *
 * Reading order: headline + when + state chip, then what NEEDS the person, then the latest round's
 * facts (delivered, in progress, next, health), then earlier rounds as a one-line-each timeline that
 * opens one at a time. It is STANDALONE: `CheckinModalHost` (mounted once in App) draws it from the
 * `checkinModal` store, so the chat row, the ⓘ panel, the bell and Nay all open it alone.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Sheet } from '../../pages/vault/vaultUi'
import { Pill, type PillTone } from '../Pill'
import { microLabel, surface } from '../tasks/board'
import { useIsMobile } from '../../hooks/useIsMobile'
import { closeCheckinModal, useCheckinModalRequest } from '../../lib/checkinModal'
import { useCheckin, type CheckinHealthState, type CheckinRound } from '../../lib/checkin'
import { useTaskActivity, type TaskEvent } from '../../lib/tasks'
import { useFleet } from '../../lib/fleet'
import { sessionIdentityKey } from '../../lib/sessionIdentity'
import { sessionLinks } from '../../lib/sessionParent'

const DOT: Record<CheckinHealthState, string> = { ok: 'var(--accent-green)', warn: 'var(--anthropic-orange)', bad: 'var(--accent-red)' }
const TEXT: CSSProperties = { color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.45, minWidth: 0, overflowWrap: 'anywhere' }
// --text-tertiary is ~2.5:1 on the light card; labels here need AA (4.5:1), so they read from the primary ink.
const LABEL = 'color-mix(in srgb, var(--text-primary) 68%, transparent)'
const MUTED: CSSProperties = { color: LABEL }

function copy(pt: boolean) {
  return pt
    ? { title: 'Check-in', needs: 'Precisa de você', delivered: 'Entregue', progress: 'Em andamento', next: 'Próximos passos', health: 'Saúde',
        earlier: 'Rodadas anteriores', ok: 'tudo certo', needsYou: 'precisa de você', resolved: 'resolvido', release: 'release', close: 'Fechar',
        health3: { ok: 'Saudável', warn: 'Atenção', bad: 'Crítico' } as Record<CheckinHealthState, string>, empty: 'Sem detalhes nesta rodada.' }
    : { title: 'Check-in', needs: 'Needs you', delivered: 'Delivered', progress: 'In progress', next: 'Next steps', health: 'Health',
        earlier: 'Earlier rounds', ok: 'all good', needsYou: 'needs you', resolved: 'resolved', release: 'release', close: 'Close',
        health3: { ok: 'Healthy', warn: 'Warning', bad: 'Critical' } as Record<CheckinHealthState, string>, empty: 'No details in this round.' }
}

export function roundTone(state: CheckinRound['state']): PillTone { return state === 'needs_you' ? 'error' : state === 'resolved' ? 'neutral' : 'ok' }

export function RoundStateChip({ state, pt }: { state: CheckinRound['state']; pt: boolean }) {
  const c = copy(pt)
  return <Pill tone={roundTone(state)} nowrap>{state === 'needs_you' ? c.needsYou : state === 'resolved' ? c.resolved : c.ok}</Pill>
}

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return <section style={{ display: 'grid', gap: 6 }}><div style={{ ...microLabel, color: LABEL }}>{label}</div>{children}</section>
}

/** The facts of one round, grouped. `needs` leads, in the fault tint, when present. */
export function CheckinRoundBody({ round, pt }: { round: CheckinRound; pt: boolean }) {
  const c = copy(pt)
  const needs = round.needs ?? [], delivered = round.delivered ?? [], progress = round.inProgress ?? [], next = round.next ?? [], health = round.health ?? []
  const empty = needs.length + delivered.length + progress.length + next.length + health.length === 0
  return (
    <div data-testid="checkin-round-body" style={{ display: 'grid', gap: 16 }}>
      {needs.length > 0 && (
        <div style={{ ...surface, padding: '10px 12px', display: 'grid', gap: 6, borderColor: 'color-mix(in srgb, var(--accent-red) 40%, var(--border))', background: 'color-mix(in srgb, var(--accent-red) 6%, var(--bg-card))' }}>
          <div style={{ ...microLabel, color: 'var(--accent-red)' }}>{c.needs}</div>
          {needs.map((n, i) => <div key={i} style={TEXT}><strong>{n.subject}</strong> — {n.text}</div>)}
        </div>
      )}
      {delivered.length > 0 && <Group label={c.delivered}>{delivered.map((d, i) => <div key={i} style={TEXT}>{d.text}</div>)}</Group>}
      {progress.length > 0 && (
        <Group label={c.progress}>
          {progress.map((p, i) => (
            <div key={i} style={{ ...TEXT, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <strong>{p.item}</strong><Pill tone="neutral" nowrap>{p.stage}</Pill>
              {p.release && <Pill tone="warn" nowrap>{c.release} {p.release}</Pill>}
            </div>
          ))}
        </Group>
      )}
      {next.length > 0 && <Group label={c.next}>{next.map((n, i) => <div key={i} style={TEXT}>{n.text}{n.when && <span style={MUTED}> · {n.when}</span>}</div>)}</Group>}
      {health.length > 0 && (
        <Group label={c.health}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6 }}>
            {health.map((h, i) => (
              <div key={i} title={`${h.label}: ${h.value}`} style={{ ...surface, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span role="img" aria-label={c.health3[h.state]} style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: DOT[h.state] }} />
                <span style={{ minWidth: 0, display: 'grid', lineHeight: 1.3 }}>
                  <span style={{ fontSize: 11, color: LABEL, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.label}</span>
                  <span style={{ ...TEXT, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.value}</span>
                </span>
              </div>
            ))}
          </div>
        </Group>
      )}
      {empty && <div style={{ ...TEXT, ...MUTED }}>{round.summary || c.empty}</div>}
    </div>
  )
}

/** Time only for today, "ontem 18:02" for yesterday, "16/10 18:02" for older. */
export function roundWhen(ms: number, pt: boolean, now = Date.now()): string {
  const d = new Date(ms), n = new Date(now)
  const hm = d.toLocaleTimeString(pt ? 'pt-BR' : 'en-GB', { hour: '2-digit', minute: '2-digit' })
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(n) - day(d)) / 86_400_000)
  if (diff === 0) return hm
  if (diff === 1) return `${pt ? 'ontem' : 'yesterday'} ${hm}`
  return `${d.toLocaleDateString(pt ? 'pt-BR' : 'en-GB', { day: '2-digit', month: '2-digit' })} ${hm}`
}

function roundOf(event: TaskEvent): CheckinRound {
  return { state: (event.state as CheckinRound['state']) ?? 'ok', summary: event.summary ?? '', ...(event.headline ? { headline: event.headline } : {}),
    ...(event.delivered ? { delivered: event.delivered } : {}), ...(event.inProgress ? { inProgress: event.inProgress } : {}),
    ...(event.next ? { next: event.next } : {}), ...(event.health ? { health: event.health } : {}), ...(event.needs ? { needs: event.needs } : {}) }
}

/** Earlier rounds: one line each (time + headline + state dot), one open at a time. */
export function CheckinTimeline({ history, pt, isMobile }: { history: TaskEvent[]; pt: boolean; isMobile: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const c = copy(pt)
  if (history.length === 0) return null
  return (
    <Group label={c.earlier}>
      <ol data-testid="checkin-timeline" style={{ listStyle: 'none', margin: 0, padding: 0, ...surface, overflow: 'hidden' }}>
        {history.map((event, i) => {
          const open = openId === event.id
          const when = event.at ? roundWhen(new Date(event.at).getTime(), pt) : `#${i + 1}`
          const tone = event.state === 'needs_you' ? 'var(--accent-red)' : 'var(--accent-green)'
          return (
            <li key={event.id} style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <button type="button" aria-expanded={open} onClick={() => setOpenId(open ? null : event.id)}
                style={{ all: 'unset', boxSizing: 'border-box', width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', minHeight: isMobile ? 44 : 34 }}>
                {open ? <ChevronDown size={13} style={MUTED} /> : <ChevronRight size={13} style={MUTED} />}
                <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: tone }} />
                <span style={{ ...MUTED, fontSize: 12, flexShrink: 0 }}>{when}</span>
                <span style={{ ...TEXT, fontSize: 12.5, ...(isMobile ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' } : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }) }}>{event.headline ?? event.summary ?? ''}</span>
              </button>
              {open && <div style={{ padding: '4px 12px 12px 32px' }}><CheckinRoundBody round={roundOf(event)} pt={pt} /></div>}
            </li>
          )
        })}
      </ol>
    </Group>
  )
}

/** The modal's title row: "Check-in · 12h13" — the headline then stands alone below it. */
export function checkinTitle(round: CheckinRound, pt: boolean): string {
  return round.at ? `Check-in · ${roundWhen(round.at, pt)}` : 'Check-in'
}

export function CheckinModalView({ round, history, pt, isMobile, onClose }: { round: CheckinRound; history: TaskEvent[]; pt: boolean; isMobile: boolean; onClose: () => void }) {
  const c = copy(pt)
  const earlier = useMemo(() => history.filter(e => !e.at || !round.at || new Date(e.at).getTime() !== round.at).slice(0, 8), [history, round.at])
  // The "needs you" box already says it; the chip only speaks when the state is something else.
  const chip = !(round.state === 'needs_you' && (round.needs?.length ?? 0) > 0)
  return (
    <div data-testid="checkin-modal">
      <Sheet closeLabel={c.close} isMobile={isMobile} title={checkinTitle(round, pt)} onClose={onClose} maxWidth={720}>
        <div style={{ display: 'grid', gap: 18 }}>
          <header style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
            <div style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 650, lineHeight: 1.35 }}>{round.headline ?? round.summary}</div>
            {chip && <RoundStateChip state={round.state} pt={pt} />}
          </header>
          <CheckinRoundBody round={round} pt={pt} />
          <CheckinTimeline history={earlier} pt={pt} isMobile={isMobile} />
        </div>
      </Sheet>
    </div>
  )
}

/** Mounted ONCE (App): draws the modal for whichever session asked, alone. */
export function CheckinModalHost({ lang }: { lang: 'pt' | 'en' }) {
  const request = useCheckinModalRequest()
  if (!request) return null
  return <Loaded sessionId={request.sessionId} lang={lang} />
}

function Loaded({ sessionId, lang }: { sessionId: string; lang: 'pt' | 'en' }) {
  const isMobile = useIsMobile()
  const { fleet } = useFleet(lang)
  // The chat row knows the managed id; the check-in is keyed by the session's identity key.
  const row = fleet.rows.find(r => r.id === sessionId || r.conversationId === sessionId)
  const key = row ? sessionIdentityKey(row) : sessionId
  const checkin = useCheckin(key)
  const task = row ? sessionLinks(row, fleet.rows)?.task?.id : undefined
  const activity = useTaskActivity(task, 20)
  const round = checkin.state?.last
  if (!round) return null
  return <CheckinModalView round={round} history={activity.events.filter(e => e.kind === 'checkin')} pt={lang === 'pt'} isMobile={isMobile} onClose={closeCheckinModal} />
}
