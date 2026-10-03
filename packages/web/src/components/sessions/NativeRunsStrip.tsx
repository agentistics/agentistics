/**
 * NativeRunsStrip — H6 in the native chat: the CONTEXT GAUGE (how full the model's window was on the
 * latest run's last call) and ONE LINE PER RUN (tokens, cost, cache share), above the composer.
 * The latest run's line is always visible; the others fold into a list. Nothing is drawn before a run
 * has billed a response: an empty strip is not a zero.
 */
import { contextGauge, runLineText, type RunLineView } from '../../lib/nativeRuns'
import { fmt } from '@agentistics/core'

export function NativeRunsStrip({ runs, lang }: { runs: readonly RunLineView[]; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const billed = runs.filter(r => r.responses > 0)
  if (billed.length === 0) return null
  const gauge = contextGauge(billed)
  const latest = billed[billed.length - 1]!
  const older = billed.slice(0, -1)
  const pct = gauge ? Math.min(100, Math.floor(gauge.fraction * 100)) : null
  return (
    <div data-testid="native-runs" style={{ maxWidth: 820, width: 'calc(100% - 28px)', margin: '0 auto 6px', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 0 }}>
      {gauge && pct !== null && (
        <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
          aria-label={pt ? 'Contexto usado' : 'Context used'}
          title={pt ? `${fmt(gauge.tokens)} de ${fmt(gauge.window)} tokens na janela, na última chamada` : `${fmt(gauge.tokens)} of ${fmt(gauge.window)} tokens in the window, on the last call`}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{pt ? 'Contexto' : 'Context'} {pct}%</span>
          <span style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--border-subtle, rgba(127,127,127,0.25))', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: pct >= 80 ? 'var(--accent-orange, #f59e0b)' : 'var(--accent)' }} />
          </span>
        </div>
      )}
      <div style={{ overflowWrap: 'anywhere' }}>{pt ? 'Última run' : 'Last run'}: {runLineText(latest, lang)}</div>
      {older.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer' }}>{pt ? `Runs anteriores (${older.length})` : `Earlier runs (${older.length})`}</summary>
          <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {older.map(r => <li key={r.runId} style={{ overflowWrap: 'anywhere' }}>{runLineText(r, lang)}</li>)}
          </ol>
        </details>
      )}
    </div>
  )
}
