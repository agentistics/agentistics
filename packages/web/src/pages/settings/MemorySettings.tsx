/**
 * MemorySettings — Settings → Memory (B6.6, §24.6): every fact the native runtime remembers, where it
 * applies (a repository, or you), who noted it and when, and what it replaced — inspectable in full
 * (rule 1). "Forget" deletes it for good (rule 6): every version leaves memory and its words are
 * deleted from this machine. Memory never leaves this machine (D14).
 */
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { memoryGroups, type MemoryFactWire } from '../../lib/memoryView'
import { SectionHeader } from './primitives'

export default function MemorySettings() {
  const { lang } = useOutletContext<AppContext>()
  const pt = lang === 'pt'
  const [facts, setFacts] = useState<MemoryFactWire[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/memory')
      const b = await r.json().catch(() => null) as { facts?: MemoryFactWire[]; sentence?: string; sentencePt?: string } | null
      if (!r.ok) { setError((pt ? b?.sentencePt : undefined) ?? b?.sentence ?? `HTTP ${r.status}`); setFacts([]); return }
      setError(null)
      setFacts(b?.facts ?? [])
    } catch {
      setError(pt ? 'Erro de rede ao ler a memória.' : 'Network error reading the memory.')
      setFacts([])
    }
  }, [pt])
  useEffect(() => { void load() }, [load])

  const forget = async (chainId: string) => {
    setConfirming(null)
    const r = await fetch(`/api/memory/${encodeURIComponent(chainId)}`, { method: 'DELETE' }).catch(() => null)
    if (!r || !r.ok) setError(pt ? 'Não foi possível esquecer esse fato.' : 'That fact could not be forgotten.')
    await load()
  }

  const origin = (o: MemoryFactWire['origin']) => (o === 'person' ? (pt ? 'você' : 'you') : o === 'model' ? (pt ? 'o modelo, com sua aprovação' : 'the model, approved by you') : (pt ? 'derivado' : 'derived'))
  const groups = facts ? memoryGroups(facts, lang) : []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      <SectionHeader label={pt ? 'Memória' : 'Memory'} />
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        {pt
          ? 'O que as sessões nativas lembram entre uma sessão e outra: fatos que você pediu (/remember) ou aprovou. Cada repositório vê só os seus. Nada sai desta máquina.'
          : 'What native sessions remember from one session to the next: facts you asked for (/remember) or approved. Each repository sees only its own. Nothing leaves this machine.'}
      </p>
      {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--accent-red)' }}>{error}</div>}
      {facts === null && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>…</div>}
      {facts !== null && groups.length === 0 && !error && (
        <div data-testid="memory-empty" style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{pt ? 'Nada lembrado ainda.' : 'Nothing remembered yet.'}</div>
      )}
      {groups.map(g => (
        <section key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{g.label}</div>
          {g.rows.map(r => (
            <div key={r.chainId} data-testid="memory-fact" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{r.statement ?? (pt ? '(texto apagado)' : '(statement deleted)')}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <span>{r.category}</span><span>{r.since}</span><span>{origin(r.origin)}</span><span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{r.chainId}</span>
                <span style={{ flex: 1 }} />
                {confirming === r.chainId
                  ? (<>
                      <span>{pt ? 'Esquecer para sempre?' : 'Forget for good?'}</span>
                      <button type="button" onClick={() => void forget(r.chainId)} style={{ fontSize: 11.5, color: 'var(--accent-red)' }}>{pt ? 'Esquecer' : 'Forget'}</button>
                      <button type="button" onClick={() => setConfirming(null)} style={{ fontSize: 11.5 }}>{pt ? 'Cancelar' : 'Cancel'}</button>
                    </>)
                  : <button type="button" onClick={() => setConfirming(r.chainId)} style={{ fontSize: 11.5 }}>{pt ? 'Esquecer' : 'Forget'}</button>}
              </div>
              {r.history.length > 0 && (
                <details style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  <summary style={{ cursor: 'pointer' }}>{pt ? `Substituiu ${r.history.length}` : `Replaced ${r.history.length}`}</summary>
                  {r.history.map((h, i) => <div key={i} style={{ marginTop: 4, overflowWrap: 'anywhere' }}>{h.from} → {h.to}: {h.statement ?? '—'}</div>)}
                </details>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
