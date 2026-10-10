/**
 * ResourcesSection — the "Resources" block of the Hardware overlay: every agentop process on this
 * machine, what each holds, who owns it, and the governor's alerts with their fix (RES.1).
 *
 * Reads `GET /api/resources` (the governor's last snapshot — the route never touches `/proc` on a
 * request) every 10 s while mounted. The only action it performs is the one-click STOP the governor
 * offers for a process it is allowed to stop; every other fix is the exact command, in words.
 * On a phone the table becomes a list of cards; nothing scrolls the page sideways.
 */

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, AlertTriangle, Layers } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { ConfirmModal } from '../pages/settings/primitives'
import { useFleet } from '../lib/fleet'
import { HARNESS_LABELS } from '../lib/harness'
import {
  alertSentence, endNote, fixFor, harnessBreakdown, orphansOf, orphanWhySentence, recommendedActions, recommendedSentence, staleBySession, staleSessionsSentence, fmtAge, fmtMb, groupAlerts, heavyLine, killSentence, kindLabel, ownerText, staleMcpSentence,
  type ResLang, type ResourcesSnapshot,
} from '../lib/resourcesView'

function useResources(lang: ResLang): { snap: ResourcesSnapshot | null; error: string | null; reload: () => void } {
  const [snap, setSnap] = useState<ResourcesSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/resources')
      if (res.status === 403) {
        setError(lang === 'pt'
          ? 'Desativado pelo perfil de exposição desta instalação (CAPS.localShell).'
          : 'Disabled by this installation’s exposure profile (CAPS.localShell).')
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSnap(await res.json() as ResourcesSnapshot)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [lang])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 10_000)
    return () => clearInterval(t)
  }, [load])
  return { snap, error, reload: () => void load() }
}

export function ResourcesSection({ lang, isMobile, onNavigate }: { lang: Lang; isMobile: boolean; onNavigate?: () => void }) {
  const navigate = useNavigate()
  const l: ResLang = lang === 'pt' ? 'pt' : 'en'
  const { snap, error, reload } = useResources(l)
  const [busy, setBusy] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const { fleet } = useFleet(l)
  const [confirm, setConfirm] = useState<null | 'orphans'>(null)
  const fleetMap = new Map<string, { id: string; title: string; harness: string }>()
  for (const r of fleet?.sessions ?? []) fleetMap.set(r.id, r)

  /** Ends one pid and reports the OBSERVED outcome (the server escalates to SIGKILL). */
  const endOne = async (pid: number): Promise<boolean> => {
    try {
      const res = await fetch('/api/resources/kill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }),
      })
      const body = await res.json().catch(() => null) as { ended?: boolean } | null
      return res.ok && body?.ended === true
    } catch { return false }
  }
  const stop = async (pid: number) => {
    setBusy(pid)
    try {
      const ok = await endOne(pid)
      setNote(endNote(pid, { ended: ok }, l))
    } finally {
      setBusy(null)
      reload()
    }
  }
  const endOrphans = async () => {
    setConfirm(null)
    const targets = snap ? orphansOf(snap.inventory) : []
    let ended = 0
    for (const p of targets) { setBusy(p.pid); if (await endOne(p.pid)) ended++ }
    setBusy(null)
    setNote(l === 'pt' ? `${ended} de ${targets.length} órfão(s) encerrado(s).${ended < targets.length ? ' Os que sobraram não encerraram — tente de novo.' : ''}` : `${ended} of ${targets.length} orphan(s) ended.${ended < targets.length ? ' The rest did not end — try again.' : ''}`)
    reload()
  }

  const cancelQueued = async (id: string) => {
    const res = await fetch(`/api/resources/queue/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setNote(res.ok
      ? (l === 'pt' ? 'Removida da fila.' : 'Removed from the queue.')
      : (l === 'pt' ? `Não foi possível remover (HTTP ${res.status}).` : `Could not remove it (HTTP ${res.status}).`))
    reload()
  }

  const h2: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }
  const box: React.CSSProperties = { padding: 12, borderRadius: 10, background: 'var(--bg-surface)', border: '1px solid var(--border)', fontSize: 13 }
  const btn: React.CSSProperties = {
    minHeight: isMobile ? 44 : 28, padding: '0 12px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.4)',
    background: 'rgba(239,68,68,0.08)', color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 600, flexShrink: 0,
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-label={l === 'pt' ? 'Recursos' : 'Resources'}>
      <h2 style={h2}><Activity size={17} />{l === 'pt' ? 'Recursos' : 'Resources'}</h2>

      {error && <div style={{ ...box, color: 'var(--text-tertiary)' }}>{error}</div>}
      {!error && !snap && <div style={{ ...box, color: 'var(--text-tertiary)' }}>{l === 'pt' ? 'Lendo…' : 'Reading…'}</div>}
      {snap && !snap.measured && (
        <div style={{ ...box, color: 'var(--text-tertiary)' }}>
          {l === 'pt' ? 'Esta máquina não expõe /proc — os processos não podem ser lidos aqui (N/A, não zero).' : 'This machine exposes no /proc — processes cannot be read here (N/A, not zero).'}
        </div>
      )}

      {snap && (() => {
        const groups = staleBySession(snap.inventory, snap.alerts, fleetMap)
        const rec = recommendedActions(snap.inventory, groups)
        const sentence = recommendedSentence(rec, l)
        if (!sentence) return null
        return (
          <div style={{ ...box, borderColor: 'rgba(59,130,246,0.4)', display: 'flex', gap: 10, flexDirection: 'column' }} data-testid="res-recommended">
            <strong style={{ color: 'var(--text-primary)' }}>{l === 'pt' ? 'Ações recomendadas' : 'Recommended actions'}</strong>
            <span style={{ color: 'var(--text-secondary)' }}>{sentence}</span>
            {rec.orphanCount > 0 && (
              <div><button style={btn} onClick={() => setConfirm('orphans')} disabled={busy !== null}>
                {l === 'pt' ? `Encerrar órfãos (${rec.orphanCount})` : `End orphans (${rec.orphanCount})`}
              </button></div>
            )}
            {rec.reopenCount > 0 && <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{l === 'pt' ? 'Para reabrir sessões, use "Abrir" na lista abaixo.' : 'To reopen sessions, use "Open" in the list below.'}</span>}
          </div>
        )
      })()}

      {snap && snap.alerts.length > 0 && (() => {
        const { single, staleMcpPids } = groupAlerts(snap.alerts, snap.inventory)
        return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {staleMcpPids.length > 0 && (() => {
            const groups = staleBySession(snap.inventory, snap.alerts, fleetMap)
            const label = (h: string) => (HARNESS_LABELS as Record<string, string>)[h] ?? h
            return (
              <div style={{ ...box, display: 'flex', gap: 10, flexDirection: 'column' }}>
                <span style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{staleSessionsSentence(groups, harnessBreakdown(groups, label), l)}</span>
                {groups.map(g => (
                  <div key={g.managedId ?? g.pids[0]} style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      {g.session ? `${g.session.title} · ${label(g.session.harness)}` : (l === 'pt' ? 'Sessão que já acabou' : 'A session that has ended')}
                      <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}> · pid {g.pids.join(', ')}</span>
                    </span>
                    {g.session ? (
                      <button style={{ ...btn, color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent' }}
                        onClick={() => { navigate(`/sessions/${encodeURIComponent(g.session!.id)}`); onNavigate?.() }}>
                        {l === 'pt' ? 'Abrir' : 'Open'}
                      </button>
                    ) : (
                      <button style={btn} disabled={busy !== null} onClick={() => void stop(g.pids[0]!)}>{l === 'pt' ? 'Encerrar' : 'End'}</button>
                    )}
                  </div>
                ))}
              </div>
            )
          })()}
          {single.map(a => {
            const fix = fixFor(a, l)
            return (
              <div key={`${a.pid}:${a.reason}`} style={{ ...box, borderColor: 'rgba(245,158,11,0.4)', display: 'flex', gap: 10, alignItems: isMobile ? 'stretch' : 'center', flexDirection: isMobile ? 'column' : 'row' }}>
                <AlertTriangle size={16} style={{ color: '#f59e0b', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ color: 'var(--text-primary)' }}>{alertSentence(a, l)}</span>
                  {fix?.text && <span style={{ color: 'var(--text-tertiary)', fontSize: 12, overflowWrap: 'anywhere' }}>{fix.text}</span>}
                </div>
                {fix?.button && (
                  <button style={btn} disabled={busy === a.pid} onClick={() => void stop(a.pid)}>
                    {busy === a.pid ? '…' : fix.button}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        )
      })()}
      {note && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }} role="status">{note}</div>}

      {snap && snap.measured && (
        isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {snap.inventory.map(p => (
              <div key={p.pid} style={{ ...box, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ overflowWrap: 'anywhere' }}>{p.label}</strong>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMb(p.usedBytes)}</span>
                </div>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
                  {kindLabel(p.kind, l)} · pid {p.pid} · {fmtAge(p.ageSec)} · CPU {p.cpuPercent ?? 'N/A'}{p.cpuPercent !== null ? '%' : ''}
                </span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
                  {l === 'pt' ? 'Dono' : 'Owner'}: {ownerText(p, l)}{p.stale ? ` · ${l === 'pt' ? 'binário antigo' : 'old binary'}` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ overflowX: 'auto', width: '100%' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text-tertiary)' }}>
                  <th style={{ padding: '8px 12px' }}>{l === 'pt' ? 'Processo' : 'Process'}</th>
                  <th style={{ padding: '8px 12px' }}>pid</th>
                  <th style={{ padding: '8px 12px' }}>{l === 'pt' ? 'RAM+swap' : 'RAM+swap'}</th>
                  <th style={{ padding: '8px 12px' }}>CPU</th>
                  <th style={{ padding: '8px 12px' }}>{l === 'pt' ? 'Idade' : 'Age'}</th>
                  <th style={{ padding: '8px 12px' }}>{l === 'pt' ? 'Dono' : 'Owner'}</th>
                </tr>
              </thead>
              <tbody>
                {snap.inventory.map(p => (
                  <tr key={p.pid} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                      <strong>{p.label}</strong>{' '}
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{kindLabel(p.kind, l)}{p.stale ? ` · ${l === 'pt' ? 'binário antigo' : 'old binary'}` : ''}{p.orphanWhy ? ` · ${orphanWhySentence(p, l)}` : ''}</span>
                    </td>
                    <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums' }}>{p.pid}</td>
                    <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums' }}>{fmtMb(p.usedBytes)}</td>
                    <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums' }}>{p.cpuPercent === null ? 'N/A' : `${p.cpuPercent}%`}</td>
                    <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums' }}>{fmtAge(p.ageSec)}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{ownerText(p, l)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {snap && (
        <div style={{ ...box, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: 'var(--text-secondary)' }}>
            <Layers size={14} />{l === 'pt' ? 'Tarefas pesadas' : 'Heavy jobs'}
          </span>
          <span style={{ color: 'var(--text-tertiary)' }}>{heavyLine(snap.heavy, l)}</span>
          {[...snap.heavy.running.map(r => ({ ...r, state: l === 'pt' ? 'rodando' : 'running' })), ...snap.heavy.waiting.map(w => ({ ...w, state: l === 'pt' ? 'na fila' : 'queued' }))].map(j => (
            <span key={j.pid} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, overflowWrap: 'anywhere' }}>{j.state}: {j.command}</span>
          ))}
          <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
            {l === 'pt' ? 'Rode compilações e suítes completas com' : 'Run full builds and test suites with'} <code>agentop heavy -- &lt;cmd&gt;</code>
          </span>
        </div>
      )}

      {snap && (snap.spawnQueue?.length ?? 0) > 0 && (
        <div style={{ ...box, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
            {l === 'pt' ? 'Sessões na fila (aguardando memória)' : 'Sessions queued (waiting for memory)'}
          </span>
          {snap.spawnQueue!.map(q => (
            <div key={q.id} style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                {q.position}. {q.label} <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>· {fmtAge(Math.round((Date.now() - q.sinceMs) / 1000))}</span>
              </span>
              <button style={{ ...btn, color: 'var(--text-secondary)', borderColor: 'var(--border)', background: 'transparent' }} onClick={() => void cancelQueued(q.id)}>
                {l === 'pt' ? 'Cancelar' : 'Cancel'}
              </button>
            </div>
          ))}
        </div>
      )}

      {snap && snap.recent.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-tertiary)' }}>
          <span style={{ fontWeight: 600 }}>{l === 'pt' ? 'Encerrados automaticamente' : 'Stopped automatically'}</span>
          {snap.recent.slice(0, 8).map(k => <span key={`${k.pid}:${k.atMs}`}>{new Date(k.atMs).toLocaleTimeString()} — {killSentence(k, l)}</span>)}
        </div>
      )}
      {snap && !snap.killsEnabled && (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {l === 'pt' ? 'Encerramento automático desligado (AGENTISTICS_GOVERNOR=0) — só alertas.' : 'Automatic stopping is off (AGENTISTICS_GOVERNOR=0) — alerts only.'}
        </span>
      )}
      {snap && (
        <ConfirmModal
          open={confirm === 'orphans'}
          title={l === 'pt' ? 'Encerrar órfãos?' : 'End orphans?'}
          message={l === 'pt' ? 'Estes processos ficaram para trás — quem os iniciou já acabou. Nada que esteja em uso será afetado:' : 'These processes were left behind — whoever started them is gone. Nothing in use is affected:'}
          confirmLabel={l === 'pt' ? 'Encerrar' : 'End them'}
          cancelLabel={l === 'pt' ? 'Cancelar' : 'Cancel'}
          focusCancel
          onCancel={() => setConfirm(null)}
          onConfirm={() => void endOrphans()}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, maxHeight: 200, overflow: 'auto' }}>
            {orphansOf(snap.inventory).map(p => (
              <span key={p.pid} style={{ overflowWrap: 'anywhere' }}>{p.label} · pid {p.pid} · {fmtMb(p.usedBytes)} — {orphanWhySentence(p, l)}</span>
            ))}
          </div>
        </ConfirmModal>
      )}
    </section>
  )
}
