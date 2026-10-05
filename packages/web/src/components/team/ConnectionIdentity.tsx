import { AgentisticsLoader } from '../../components/AgentisticsLoader'
import React, { useEffect, useRef, useState } from 'react'
import { COPY } from './copy'

export interface ProbedIdentity {
  ok: boolean
  user?: string
  org?: string
  /** The name the CENTRAL gave this machine (the token's label) — forwarded by
   *  `handleProbeConnection` (Plan 4 Task 1, fix 6). Distinct from `user`, the account this token
   *  authenticates as, and from the connection's purely-local nickname (`conn.label`). */
  machineName?: string
  latencyMs?: number
  error?: string
}

/**
 * ConnectionIdentity — read-only rows for one connection, fed by ONE
 * `POST /api/team/connections/:id/probe`, fired on EXPAND (never on mount for all N cards — an
 * offline central would otherwise block the whole list behind N timeouts).
 *
 * Endpoint and token are deliberately not editable here: rotating either is Disconnect-and-Add,
 * or `agentop member connect` for a token rotation on the machine itself. This is what let Task 10
 * delete the old `editing`/`userTouched`/`editingInitialized` ref machinery from `TeamSettings.tsx`
 * — there is no in-place edit state to guard here at all.
 *
 * `identity.machineName` is what `ConnectionCard.tsx`'s title prefers over `identity.org` (a
 * fixed org constant, not machine-specific) — it is "the name the central gave the machine" the
 * user actually expects to see there.
 */
export function ConnectionIdentity({
  connId, endpoint, expanded, lang, onResolved,
}: {
  connId: string
  endpoint: string
  expanded: boolean
  lang: 'pt' | 'en'
  /** Lets the parent card cache the resolved org for its own header label. */
  onResolved?: (identity: ProbedIdentity) => void
}) {
  const [identity, setIdentity] = useState<ProbedIdentity | null>(null)
  const [loading, setLoading] = useState(false)
  const fetchedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!expanded) return
    if (fetchedFor.current === connId) return // fetched once per expand session, not on every re-render
    fetchedFor.current = connId
    setLoading(true)
    fetch(`/api/team/connections/${encodeURIComponent(connId)}/probe`, { method: 'POST' })
      .then(r => r.json() as Promise<ProbedIdentity>)
      .then(data => {
        setIdentity(data)
        onResolved?.(data)
      })
      .catch(() => {
        setIdentity({ ok: false, error: COPY.networkError[lang] })
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, connId])

  function retry() {
    fetchedFor.current = null
    setLoading(true)
    fetch(`/api/team/connections/${encodeURIComponent(connId)}/probe`, { method: 'POST' })
      .then(r => r.json() as Promise<ProbedIdentity>)
      .then(data => { setIdentity(data); onResolved?.(data); fetchedFor.current = connId })
      .catch(() => { setIdentity({ ok: false, error: COPY.networkError[lang] }) })
      .finally(() => setLoading(false))
  }

  // Two columns, not six stacked rows: the values are short, the card is wide, and the machine and
  // the user are what a person opening this card is looking for. The token row is GONE — it showed
  // dots and said nothing. URL and latency are reference and sit below, the URL full-width because
  // it is the only long value here.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
          <AgentisticsLoader size={12} />
          {COPY.checking[lang]}
        </div>
      )}
      {!loading && identity?.ok && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px 16px' }}>
          {/* Read-only, and said so: the central assigns this name and nothing on this machine may
             write it. */}
          {identity.machineName && (
            <Cell
              label={COPY.identityMachineName[lang]}
              hint={COPY.machineNameByCentral[lang]}
              value={identity.machineName}
            />
          )}
          <Cell label={COPY.identityUser[lang]} value={identity.user || '—'} />
          {identity.org && <Cell label={COPY.identityOrg[lang]} value={identity.org} />}
          {identity.latencyMs != null && <Cell label={COPY.identityLatency[lang]} value={`${identity.latencyMs}ms`} />}
        </div>
      )}
      <Cell label={COPY.identityUrl[lang]} value={endpoint} full />
      {!loading && identity && !identity.ok && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#ef4444' }}>
          <span>{identity.error ?? COPY.couldNotIdentify[lang]}</span>
          <button
            type="button"
            onClick={retry}
            style={{
              padding: '3px 9px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text-secondary)', fontSize: 11.5,
              fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {COPY.retry[lang]}
          </button>
        </div>
      )}
    </div>
  )
}

/** Label above value, so a narrow column never squeezes the value into two characters. */
function Cell({ label, value, hint, full }: { label: string; value: React.ReactNode; hint?: string; full?: boolean }) {
  return (
    <div title={hint} style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, gridColumn: full ? '1 / -1' : undefined }}>
      <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}
