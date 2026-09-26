/**
 * IdleSessionsModal — the review the bell/banner opens onto: file each idle session into a group and
 * end it, only end it, or keep it a while longer.
 *
 * The overlay/esc/focus-return conventions follow `HardwareModal.tsx` (this workspace's own
 * `ConfirmModal` equivalent does not exist as a shared component — every dialog in
 * `components/sessions/` builds the same shape by hand, and `HardwareModal` is the one that already
 * carries the full contract: `esc` closes, the backdrop closes, focus returns to whatever opened it).
 * The two-column shell (header / scrollable body / footer) follows `SessionPickModal.tsx`, the
 * closest sibling in `components/sessions/` — another dialog that lists several sessions, lets the
 * user narrow a per-row choice, and turns into a result screen once the verb runs.
 *
 * THE CANDIDATE LIST IS FROZEN AT OPEN. `candidates` is the live, every-five-seconds-recomputed
 * fleet reading; snapshotting it once (via a lazy `useState`) is what lets a half-filled "which group
 * for this one" selection survive a poll landing while the dialog is open, instead of the whole form
 * resetting under the reader's cursor. The safety net is `runIdlePlan`'s own `stillIdle` re-check —
 * a session that stopped being idle between the freeze and the click is reported `skipped`, never
 * ended on stale information.
 */
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  freedBytes, suggestGroup,
  type GroupSuggestion, type IdleCandidate, type IdleReason,
} from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { runIdlePlan, type IdleAction, type IdleEffects, type IdleOutcome, type IdlePlanItem } from '../../lib/idleExecution'
import { fmtGB } from '../../hooks/useIdleSessions'
import { lastPromptOf } from '../../lib/idleRows'
import { createSessionGroup, getSessionGroups, moveSessionToGroup } from '../../lib/sessionUserGroups'
import { keepSessions } from '../../lib/idleSessionsPrefs'
import { useIsMobile } from '../../hooks/useIsMobile'
import { overlayPadding } from '../../lib/mobileOverlay'
import { inputStyle } from './formBits'
import type { FleetState } from '../../lib/fleet'

const NEW_GROUP = '__new__'

interface RowPlan {
  action: IdleAction
  /** An existing group's id, or the `NEW_GROUP` sentinel. */
  groupSel: string
  newName: string
}

const REASON_LABEL: Record<IdleReason, { pt: string; en: string }> = {
  'task-delivered': { pt: 'tarefa já entregue', en: 'task already delivered' },
  'context-full': { pt: 'contexto quase cheio — reabrir sai mais barato', en: 'context nearly full — reopening is cheaper' },
}

/** "3 h 12 min" — the same words in both languages, so `pt` plays no part in this one. */
function fmtIdle(idleMs: number): string {
  const totalMin = Math.max(0, Math.floor(idleMs / 60000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10)
}

function buildInitialPlans(
  frozen: readonly IdleCandidate[],
  rows: readonly ControlSession[],
): Map<string, RowPlan> {
  const groups = getSessionGroups().groups
  const allIdleRows = frozen.map(c => c.row)
  const today = todayYmd()
  const map = new Map<string, RowPlan>()
  for (const c of frozen) {
    const row = rows.find(r => r.id === c.row.id)
    const suggestion = suggestGroup(c, groups, allIdleRows, row?.task, today)
    map.set(c.key, suggestion.kind === 'existing'
      ? { action: 'file-end', groupSel: suggestion.groupId, newName: '' }
      : { action: 'file-end', groupSel: NEW_GROUP, newName: suggestion.name })
  }
  return map
}

function resultSentence(o: IdleOutcome, pt: boolean): string {
  switch (o.result) {
    case 'ended': return pt ? 'Encerrada.' : 'Ended.'
    case 'kept': return pt ? 'Mantida.' : 'Kept.'
    case 'skipped':
      return pt
        ? 'Pulada — você mandou mensagem para ela ou ela retomou.'
        : 'Skipped — you messaged it or it resumed.'
    case 'failed':
      return o.message === 'group'
        ? (pt ? 'Falhou — não foi possível criar o grupo.' : 'Failed — could not create the group.')
        : (pt ? `Falhou — ${o.message ?? ''}` : `Failed — ${o.message ?? ''}`)
  }
}

export interface IdleSessionsModalProps {
  lang: 'pt' | 'en'
  candidates: IdleCandidate[]
  /** To read title, `lastPromptOf` and the task label — the live fleet, not the frozen candidates. */
  rows: ControlSession[]
  underPressure: boolean
  onClose: () => void
  act: FleetState['act']
  /**
   * Read the fleet again, right before ending anything. The real `useFleet().refresh` returns
   * `void` today (it fires the shared poll and lets every subscriber pick up the next answer) —
   * this is typed wider so a future version that hands back the fresh rows directly is used instead
   * of a redundant `GET /api/fleet`, without a signature change here.
   */
  refresh: () => Promise<ControlSession[]> | void
}

export function IdleSessionsModal({ lang, candidates, rows, underPressure, onClose, act, refresh }: IdleSessionsModalProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const opener = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : (document.activeElement as HTMLElement))

  const [frozen] = useState<readonly IdleCandidate[]>(() => candidates)
  const [plans, setPlans] = useState<Map<string, RowPlan>>(() => buildInitialPlans(frozen, rows))
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<IdleOutcome[] | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  useEffect(() => () => { opener.current?.focus?.() }, [])

  function updatePlan(key: string, patch: Partial<RowPlan>): void {
    setPlans(prev => {
      const cur = prev.get(key)
      if (!cur) return prev
      const next = new Map(prev)
      next.set(key, { ...cur, ...patch })
      return next
    })
  }

  async function stillIdle(id: string): Promise<boolean> {
    let freshRows: ControlSession[] | null = null
    try {
      const maybe = refresh()
      if (maybe && typeof (maybe as Promise<ControlSession[]>).then === 'function') {
        const awaited = await maybe
        if (Array.isArray(awaited)) freshRows = awaited
      }
    } catch { /* fall through to the direct read below */ }
    if (freshRows === null) {
      try {
        const res = await fetch(`/api/fleet?lang=${lang}`)
        if (!res.ok) return false
        const json = await res.json() as { rows?: ControlSession[] }
        freshRows = Array.isArray(json.rows) ? json.rows : []
      } catch {
        // An unverifiable state is never ended — see this module's own header.
        return false
      }
    }
    const row = freshRows.find(r => r.id === id)
    if (!row || row.state !== 'waiting') return false
    const original = frozen.find(c => c.row.id === id)?.row.lastUserMessageAt
    return row.lastUserMessageAt === original
  }

  function ensureGroup(g: GroupSuggestion): string | null {
    if (g.kind === 'existing') {
      const stillThere = getSessionGroups().groups.some(gr => gr.id === g.groupId)
      return stillThere ? g.groupId : createSessionGroup(g.name)
    }
    return createSessionGroup(g.name)
  }

  async function onApply(): Promise<void> {
    setBusy(true)
    const items: IdlePlanItem[] = frozen.map(c => {
      const row = rows.find(r => r.id === c.row.id)
      const plan = plans.get(c.key)
      const action: IdleAction = plan?.action ?? 'file-end'
      const group: GroupSuggestion = plan && plan.groupSel !== NEW_GROUP
        ? { kind: 'existing', groupId: plan.groupSel, name: getSessionGroups().groups.find(g => g.id === plan.groupSel)?.name ?? '' }
        : { kind: 'new', name: (plan?.newName ?? '').trim() || (pt ? 'Ocioso' : 'Idle') }
      return { id: c.row.id, key: c.key, title: row?.title ?? c.row.id, action, group }
    })
    const fx: IdleEffects = {
      stillIdle,
      ensureGroup,
      fileInto: (groupId, key) => { moveSessionToGroup(groupId, key) },
      end: async id => {
        const r = await act({ id, action: 'kill' })
        return { ok: r.ok, message: r.message }
      },
      keep: keys => { keepSessions(keys, Date.now()) },
    }
    const out = await runIdlePlan(items, fx)
    setOutcomes(out)
    setBusy(false)
  }

  const freed = freedBytes(frozen)
  const groups = getSessionGroups().groups
  const tap = isMobile ? 44 : 30

  const t = {
    title: pt ? 'Sessões ociosas' : 'Idle sessions',
    close: pt ? 'Fechar' : 'Close',
    cancel: pt ? 'Cancelar' : 'Cancel',
    apply: pt ? 'Aplicar' : 'Apply',
    applying: pt ? 'Aplicando…' : 'Applying…',
    actionFileEnd: pt ? 'Arquivar e encerrar' : 'File & end',
    actionEnd: pt ? 'Só encerrar' : 'End only',
    actionKeep: pt ? 'Manter' : 'Keep',
    newGroup: pt ? 'Novo grupo…' : 'New group…',
    newGroupPlaceholder: pt ? 'Nome do grupo' : 'Group name',
    memory: pt ? 'Memória' : 'Memory',
  }

  const summary = freed !== null
    ? (pt
      ? `${frozen.length} sessão(ões) · libera ~${fmtGB(freed)}`
      : `${frozen.length} session(s) · frees ~${fmtGB(freed)}`)
    : (pt ? `${frozen.length} sessão(ões)` : `${frozen.length} session(s)`)

  return (
    <div
      onClick={() => { if (!busy) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label={t.title}
      style={{
        position: 'fixed', inset: 0, zIndex: 640,
        background: 'var(--ag-scrim)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        padding: overlayPadding(isMobile, 20),
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface)',
          border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 16,
          width: '100%', maxWidth: isMobile ? '100%' : 620,
          height: isMobile ? '100%' : undefined, maxHeight: isMobile ? '100%' : '86vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <header style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {t.title}
            </h2>
            <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {summary}
              {underPressure && (
                <span style={{ color: 'var(--accent-orange, var(--anthropic-orange))' }}>
                  {' · '}
                  {pt ? 'memória apertada — limite reduzido' : 'memory is under pressure — threshold lowered'}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            // First focusable control in the dialog, so a keyboard user lands on the way out.
            autoFocus
            aria-label={t.close}
            style={{
              display: 'flex', width: tap, height: tap, alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, border: 'none', background: 'transparent', flexShrink: 0,
              color: 'var(--text-tertiary)', cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 20px' }}>
          {outcomes !== null ? (
            outcomes.map(o => (
              <div key={o.id} style={{
                display: 'flex', flexDirection: 'column', gap: 2,
                padding: '10px 12px', borderRadius: 10,
                background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
              }}>
                <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text-primary)' }}>{o.title}</span>
                <span style={{
                  fontSize: 11.5,
                  color: o.result === 'failed' ? 'var(--accent-red)' : 'var(--text-tertiary)',
                }}>
                  {resultSentence(o, pt)}
                </span>
              </div>
            ))
          ) : (
            frozen.map(c => {
              const row = rows.find(r => r.id === c.row.id)
              const plan = plans.get(c.key)
              const title = row?.title ?? c.row.id
              const prompt = row ? lastPromptOf(row) : null
              const mem = typeof c.row.rssBytes === 'number' ? fmtGB(c.row.rssBytes) : null
              const cpu = typeof c.row.cpuPercent === 'number' ? `${Math.round(c.row.cpuPercent)}%` : null
              return (
                <div key={c.key} style={{
                  display: 'flex', flexDirection: 'column', gap: 8,
                  padding: '12px 14px', borderRadius: 10,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    <span style={{
                      fontSize: 13, fontWeight: 650, color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {title}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {pt ? 'Ociosa há ' : 'Idle for '}{fmtIdle(c.idleMs)}
                      {mem && ` · ${t.memory} ${mem}`}
                      {cpu && ` · CPU ${cpu}`}
                    </span>
                    {prompt && (
                      <span style={{
                        fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        “{prompt}”
                      </span>
                    )}
                    {c.reasons.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
                        {c.reasons.map(r => (
                          <span key={r} style={{
                            fontSize: 10.5, padding: '2px 7px', borderRadius: 999,
                            background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
                            color: 'var(--text-tertiary)',
                          }}>
                            {REASON_LABEL[r][lang]}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <select
                      value={plan?.action ?? 'file-end'}
                      onChange={e => updatePlan(c.key, { action: e.target.value as IdleAction })}
                      style={{ ...inputStyle, padding: '7px 10px', flex: isMobile ? '1 1 100%' : '0 0 auto', width: isMobile ? '100%' : 190 }}
                    >
                      <option value="file-end">{t.actionFileEnd}</option>
                      <option value="end">{t.actionEnd}</option>
                      <option value="keep">{t.actionKeep}</option>
                    </select>

                    {plan?.action === 'file-end' && (
                      <>
                        <select
                          value={plan.groupSel}
                          onChange={e => updatePlan(c.key, { groupSel: e.target.value })}
                          style={{ ...inputStyle, padding: '7px 10px', flex: isMobile ? '1 1 100%' : '0 0 auto', width: isMobile ? '100%' : 190 }}
                        >
                          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                          <option value={NEW_GROUP}>{t.newGroup}</option>
                        </select>
                        {plan.groupSel === NEW_GROUP && (
                          <input
                            value={plan.newName}
                            onChange={e => updatePlan(c.key, { newName: e.target.value })}
                            placeholder={t.newGroupPlaceholder}
                            style={{
                              ...inputStyle, padding: '7px 10px 7px 10px',
                              flex: isMobile ? '1 1 100%' : '1 1 160px',
                              ...(isMobile ? { fontSize: 16 } : {}),
                            }}
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div style={{
          display: 'flex', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--border)',
          justifyContent: 'flex-end', flexDirection: isMobile ? 'column-reverse' : 'row',
        }}>
          {outcomes !== null ? (
            <button
              type="button"
              onClick={onClose}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
                width: isMobile ? '100%' : undefined,
                borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)',
                color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {t.close}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  padding: isMobile ? '0 14px' : '8px 14px', minHeight: isMobile ? 44 : undefined,
                  width: isMobile ? '100%' : undefined,
                  borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600,
                  cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                }}
              >
                {t.cancel}
              </button>
              <button
                type="button"
                onClick={() => { void onApply() }}
                disabled={busy || frozen.length === 0}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
                  width: isMobile ? '100%' : undefined,
                  borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)',
                  color: '#fff', fontSize: 13, fontWeight: 700,
                  cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: busy ? 0.75 : 1,
                }}
              >
                {busy ? t.applying : t.apply}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
