/**
 * CheckinModal — the leader's check-in report in the app's own dialog shell (`Sheet`: a centred
 * dialog on desktop, a full-height sheet at phone width).
 *
 * Reading order: headline + when + state chip, then what NEEDS the person, then the latest round's
 * facts (delivered, in progress, next, health), then earlier rounds as a wrapped timeline that
 * opens one at a time. It is STANDALONE: `CheckinModalHost` (mounted once in App) draws it from the
 * `checkinModal` store, so the chat row, the ⓘ panel, the bell and Nay all open it alone.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Sheet } from '../../pages/vault/vaultUi'
import { Pill, type PillTone } from '../Pill'
import { microLabel, surface } from '../tasks/board'
import { useIsMobile } from '../../hooks/useIsMobile'
import { closeCheckinModal, openCheckinModal, useCheckinModalRequest } from '../../lib/checkinModal'
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
  return <Pill tone={roundTone(state)}>{state === 'needs_you' ? c.needsYou : state === 'resolved' ? c.resolved : c.ok}</Pill>
}

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 14 }}><div style={{ ...microLabel, color: LABEL }}>{label}</div>{children}</section>
}

/** The facts of one round, grouped. `needs` leads, in the fault tint, when present. */
export function CheckinRoundBody({ round, pt, hideEmpty = false }: { round: CheckinRound; pt: boolean; hideEmpty?: boolean }) {
  const c = copy(pt)
  const needs = round.needs ?? [], delivered = round.delivered ?? [], progress = round.inProgress ?? [], next = round.next ?? [], health = round.health ?? []
  const empty = needs.length + delivered.length + progress.length + next.length + health.length === 0
  return (
    <div data-testid="checkin-round-body" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
      {needs.length > 0 && (
        <section style={{ borderTop: '1px solid var(--border)', paddingTop: 14, minWidth: 0 }}>
        <div style={{ ...surface, padding: '10px 12px', display: 'grid', gap: 6, borderColor: 'color-mix(in srgb, var(--accent-red) 40%, var(--border))', background: 'color-mix(in srgb, var(--accent-red) 6%, var(--bg-card))' }}>
          <div style={{ ...microLabel, color: 'var(--accent-red)' }}>{c.needs}</div>
          {needs.map((n, i) => <div key={i} style={TEXT}><strong>{n.subject}</strong> — {n.text}</div>)}
        </div>
        </section>
      )}
      {delivered.length > 0 && <Group label={c.delivered}>{delivered.map((d, i) => <div key={i} style={TEXT}>{d.text}</div>)}</Group>}
      {progress.length > 0 && (
        <Group label={c.progress}>
          {progress.map((p, i) => (
            <div key={i} data-checkin-progress style={{ ...TEXT, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <strong>{p.item}</strong><Pill tone="neutral" nowrap>{p.stage}</Pill>
              {p.release && <Pill tone="warn" nowrap>{c.release} {p.release}</Pill>}
            </div>
          ))}
        </Group>
      )}
      {next.length > 0 && <Group label={c.next}>{next.map((n, i) => <div key={i} style={TEXT}>{n.text}{n.when && <span style={MUTED}> · {n.when}</span>}</div>)}</Group>}
      {health.length > 0 && (
        <Group label={c.health}>
          <div data-testid="checkin-health-list" style={{ display: 'grid', minWidth: 0 }}>
            {health.map((h, i) => (
              <div key={i} className="ag-checkin-health-row" style={{ ...TEXT, display: 'grid', gap: '4px 10px', padding: '8px 0',
                borderBottom: i < health.length - 1 ? '1px solid var(--border)' : undefined }}>
                <span role="img" aria-label={c.health3[h.state]} style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 5, background: DOT[h.state] }} />
                <span style={{ ...MUTED, minWidth: 0 }}>{h.label}</span>
                <span className="ag-checkin-health-value" style={TEXT}>{h.value}</span>
              </div>
            ))}
          </div>
        </Group>
      )}
      {empty && !hideEmpty && <div style={{ ...TEXT, ...MUTED }}>{round.summary || c.empty}</div>}
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

/** Earlier rounds: a wrapped row each (time + headline + state dot), one open at a time. */
export function CheckinTimeline({ history, pt, isMobile }: { history: TaskEvent[]; pt: boolean; isMobile: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const c = copy(pt)
  if (history.length === 0) return null
  return (
    <Group label={c.earlier}>
      <ol data-testid="checkin-timeline" style={{ listStyle: 'none', margin: 0, padding: 0, ...surface, minWidth: 0 }}>
        {history.map((event, i) => {
          const open = openId === event.id
          const when = event.at ? roundWhen(new Date(event.at).getTime(), pt) : `#${i + 1}`
          const tone = event.state === 'needs_you' ? 'var(--accent-red)' : 'var(--accent-green)'
          return (
            <li key={event.id} style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <button type="button" aria-expanded={open} onClick={() => setOpenId(open ? null : event.id)}
                style={{ all: 'unset', boxSizing: 'border-box', width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', minHeight: isMobile ? 44 : 34 }}>
                <ChevronRight size={13} aria-hidden style={{ ...MUTED, flexShrink: 0, transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }} />
                <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: tone }} />
                <span style={{ ...MUTED, fontSize: 12, flexShrink: 0 }}>{when}</span>
                <span style={{ ...TEXT, flex: 1, fontSize: 12.5 }}>{event.headline ?? event.summary ?? ''}</span>
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
    <div data-testid="checkin-modal" className="ag-checkin-modal" style={{ overflowWrap: 'anywhere' }}>
      <style>{`
        .ag-checkin-health-row { grid-template-columns: 8px 150px minmax(0, 1fr); }
        .ag-checkin-modal [data-checkin-progress] > span { flex-shrink: 0; max-width: 100%; box-sizing: border-box; }
        @media (max-width: 480px) {
          .ag-checkin-health-row { grid-template-columns: 8px minmax(0, 1fr); }
          .ag-checkin-health-value { grid-column: 2; }
        }
      `}</style>
      <Sheet closeLabel={c.close} isMobile={isMobile} title={checkinTitle(round, pt)} onClose={onClose} maxWidth={960} closeSize={32}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18 }}>
          <header style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
            <div style={{ ...TEXT, fontSize: 16, fontWeight: 650, lineHeight: 1.35 }}>{round.headline ?? round.summary}</div>
            {chip && <RoundStateChip state={round.state} pt={pt} />}
          </header>
          <CheckinRoundBody round={round} pt={pt} hideEmpty />
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

/** The stored round with the time it ran: the GET answer has no `at` on the round itself. */
export function roundWithTime(state: { last: CheckinRound | null; lastRunAt: number | null }): CheckinRound | null {
  const at = state.last?.at ?? state.lastRunAt ?? undefined
  return state.last ? { ...state.last, ...(at !== undefined ? { at } : {}) } : null
}

/** The check-in of a session as the chat names it: resolves the identity key and the task. */
function useCheckinRound(sessionId: string | undefined, lang: 'pt' | 'en') {
  const { fleet } = useFleet(lang)
  // The chat row knows the managed id; the check-in is keyed by the session's identity key.
  const row = sessionId ? fleet.rows.find(r => r.id === sessionId || r.conversationId === sessionId) : undefined
  const key = row ? sessionIdentityKey(row) : sessionId
  const checkin = useCheckin(key)
  const task = row ? sessionLinks(row, fleet.rows)?.task?.id : undefined
  // GET /api/checkin carries the round without its own `at` (only the SSE event does), so the
  // moment of the run stands in for it — otherwise the title has no time.
  const round = checkin.state ? roundWithTime(checkin.state) : null
  return { round, task }
}

/** "Open check-in", drawn only when there is a round to show — a click must never do nothing. */
export function OpenCheckinButton({ sessionId, lang, style, fallback = null }: { sessionId: string | undefined; lang: 'pt' | 'en'; style: CSSProperties; fallback?: ReactNode }) {
  const { round } = useCheckinRound(sessionId, lang)
  if (!round) return <>{fallback}</>
  return <button type="button" onClick={() => openCheckinModal(sessionId)} style={style}>{lang === 'pt' ? 'Abrir check-in' : 'Open check-in'}</button>
}

function Loaded({ sessionId, lang }: { sessionId: string; lang: 'pt' | 'en' }) {
  const isMobile = useIsMobile()
  const { round, task } = useCheckinRound(sessionId, lang)
  const activity = useTaskActivity(task, 20)
  if (!round) return null
  return <CheckinModalView round={round} history={activity.events.filter(e => e.kind === 'checkin')} pt={lang === 'pt'} isMobile={isMobile} onClose={closeCheckinModal} />
}
