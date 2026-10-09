import { useMemo, useState } from 'react'
import { useFleet } from '../lib/fleet'
import { planReopen } from '../lib/mcpAuth'

/**
 * "Reopen the sessions this affects" — shown once a server is signed in.
 *
 * A running assistant keeps the MCP tools it started with, so a session opened BEFORE the login does
 * not see the server until it is reopened. Only sessions of the SAME harness are listed, only idle
 * ones are offered (reopening ends the process and resumes the same conversation, which must not
 * interrupt a turn in flight or a permission prompt), and the rest are named and left alone.
 * Nothing happens until the person presses a button.
 */
export function McpReopenSessions({ harness, harnessLabel, pt }: { harness: string; harnessLabel: string; pt: boolean }) {
  const lang = pt ? 'pt' : 'en'
  const { fleet, act } = useFleet(lang)
  const plan = useMemo(() => planReopen(fleet.sessions, harness), [fleet.sessions, harness])
  const [doing, setDoing] = useState<string | null>(null)
  const [done, setDone] = useState<Set<string>>(new Set())
  const [said, setSaid] = useState('')

  const reopen = async (id: string): Promise<boolean> => {
    setDoing(id)
    const killed = await act({ id, action: 'kill' })
    if (!killed.ok) { setSaid(killed.message); setDoing(null); return false }
    // The ended row stays in the fleet, so the SAME id resumes the conversation.
    const resumed = await act({ id, action: 'resume' })
    setDoing(null)
    if (!resumed.ok) { setSaid(resumed.message); return false }
    setDone(prev => new Set(prev).add(id))
    return true
  }

  const reopenAll = async () => {
    setSaid('')
    for (const s of plan.reopenable) if (!done.has(s.id) && !(await reopen(s.id))) return
  }

  const todo = plan.reopenable.filter(s => !done.has(s.id))
  if (plan.reopenable.length === 0 && plan.busy.length === 0) return null
  return (
    <div data-testid="mcp-reopen" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
        {pt
          ? `As sessões do ${harnessLabel} que já estavam abertas não enxergam este servidor até serem reabertas.`
          : `${harnessLabel} sessions that were already open do not see this server until they are reopened.`}
      </div>
      {plan.reopenable.map(s => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
          {done.has(s.id)
            ? <span style={{ fontSize: 11.5, color: 'var(--accent-green)', flexShrink: 0 }}>{pt ? 'Reaberta' : 'Reopened'}</span>
            : (
              <button type="button" disabled={doing !== null} onClick={() => { setSaid(''); void reopen(s.id) }}
                style={{ flexShrink: 0, minHeight: 44, padding: '0 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: doing !== null ? 'not-allowed' : 'pointer', opacity: doing !== null ? 0.5 : 1 }}>
                {doing === s.id ? (pt ? 'Reabrindo…' : 'Reopening…') : (pt ? 'Reabrir' : 'Reopen')}
              </button>
            )}
        </div>
      ))}
      {todo.length > 1 && (
        <button type="button" disabled={doing !== null} onClick={() => void reopenAll()}
          style={{ minHeight: 44, padding: '0 14px', borderRadius: 7, border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: doing !== null ? 'not-allowed' : 'pointer', opacity: doing !== null ? 0.5 : 1 }}>
          {pt ? `Reabrir ${todo.length} sessões` : `Reopen ${todo.length} sessions`}
        </button>
      )}
      {plan.busy.length > 0 && (
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
          {pt
            ? `${plan.busy.length} em andamento ou esperando uma resposta sua — deixei como estão: ${plan.busy.map(b => b.title).join(', ')}.`
            : `${plan.busy.length} mid-turn or waiting on you — left as they are: ${plan.busy.map(b => b.title).join(', ')}.`}
        </div>
      )}
      {said && <div role="alert" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{said}</div>}
    </div>
  )
}
