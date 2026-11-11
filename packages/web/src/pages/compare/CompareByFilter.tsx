import React, { useMemo, useState } from 'react'
import { Plus, Trash2, Save, Check, Home as HomeIcon, X } from 'lucide-react'
import {
  MAX_COMPARISON_SIDES,
  MIN_COMPARISON_SIDES,
  removeComparison,
  upsertComparison,
  type ComparisonSide,
  type CostBasis,
  type Filters,
  type HarnessId,
  type SavedComparison,
} from '@agentistics/core'
import type { AppContext } from '../../lib/app-context'
import { buildCompareRows, describeFilters } from '../../lib/compareMetrics'
import { FiltersBar } from '../../components/FiltersBar'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HARNESS_LABELS } from '../../lib/harness'
import { ComparisonTable, sideColour, type TableSide } from './ComparisonTable'
import { useComparisonSides } from './useComparisonSides'

const newId = (p: string) => `${p}_${Math.random().toString(16).slice(2, 8)}${Date.now().toString(16).slice(-5)}`
const blankFilters = (): Filters => ({ dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] })

/**
 * The comparison editor: N independent scopes, measured against the first.
 *
 * A comparison is a QUESTION, so it can be named, saved and pinned to Home — the recurring ones
 * ("is Codex cheaper for me", "did this month cost more than last") are worth asking once and
 * reading forever.
 *
 * THE BASIS IS PER SIDE, on each card. A comparison-wide basis forbade the one question this
 * whole feature was built to answer — what the plan cost against what the same work would have
 * cost at API prices. A mixed table is deliberate here, so every column is labelled with the
 * basis it used, and a column that ASKED for the plan basis and could not have it says so rather
 * than quietly borrowing the other's heading.
 */
export function CompareByFilter({ ctx }: { ctx: AppContext }) {
  const pt = ctx.lang === 'pt'
  const isMobile = useIsMobile()

  const [sides, setSides] = useState<ComparisonSide[]>(() => [
    { id: newId('s'), filters: { ...ctx.filters } },
    { id: newId('s'), filters: blankFilters() },
  ])
  /** One basis PER SIDE. Comparing what the plan cost against what the same work would have cost
   *  at API prices is the core question here, and a single comparison-wide basis forbade it. */
  const [bases, setBases] = useState<CostBasis[]>(() => [ctx.costBasis, 'api'])
  const [name, setName] = useState('')
  /** The saved comparison currently loaded, so Save updates it instead of duplicating it. */
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [onHome, setOnHome] = useState(false)
  /** Mobile mounts ONE filter bar; this is the side it edits. */
  const [editing, setEditing] = useState(0)
  /** What the last save (or load) wrote. Without it the button stayed orange forever after
   *  saving, reading as a pending action that never completes — there was no way for the screen
   *  to say "this is already saved". */
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null)

  const derivedSides = useComparisonSides({
    data: ctx.data,
    sides,
    billing: ctx.billing,
    brlRate: ctx.brlRate,
    tags: ctx.tags,
  })
  const rows = useMemo(() => buildCompareRows(derivedSides, bases), [derivedSides, bases])
  const planUsable = ctx.billingReady.ready && ctx.planBasis.basis !== null
  const setSideBasis = (i: number, b: CostBasis) =>
    setBases(list => list.map((x, j) => (j === i ? b : x)))

  const harnessLabel = (id: string) => HARNESS_LABELS[id as HarnessId] ?? id
  const describe = (s: ComparisonSide) => describeFilters(s.filters, pt ? 'pt' : 'en', harnessLabel)
  const sideLabel = (s: ComparisonSide, i: number) => s.label?.trim() || `${String.fromCharCode(65 + i)}`

  const tableSides: TableSide[] = sides.map((s, i) => ({
    id: s.id,
    label: sideLabel(s, i),
    description: describe(s),
    basis: bases[i] ?? 'api',
  }))

  const setSideFilters = (id: string, f: Filters) =>
    setSides(list => list.map(s => (s.id === id ? { ...s, filters: f } : s)))
  const addSide = () => {
    if (sides.length >= MAX_COMPARISON_SIDES) return
    setSides(list => [...list, { id: newId('s'), filters: blankFilters() }])
    setBases(list => [...list, 'api'])
  }
  const dropSide = (id: string) => {
    const at = sides.findIndex(s => s.id === id)
    if (at === -1 || sides.length <= MIN_COMPARISON_SIDES) return
    setSides(list => list.filter(s => s.id !== id))
    setBases(list => list.filter((_, j) => j !== at))
    setEditing(e => Math.min(e, sides.length - 2))
  }

  const snapshot = JSON.stringify({ name: name.trim(), onHome, bases, sides })
  const dirty = savedSnapshot !== snapshot
  const canSave = name.trim() !== '' && dirty

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const comparison: SavedComparison = {
      id: loadedId ?? newId('cmp'),
      name: trimmed,
      sides: sides.map((side, i) => ({ ...side, basis: bases[i] ?? 'api' })),
      ...(onHome ? { onHome: true } : {}),
    }
    setLoadedId(comparison.id)
    setSavedSnapshot(snapshot)
    await ctx.saveComparisons(upsertComparison(ctx.comparisons, comparison))
  }

  const load = (c: SavedComparison) => {
    setSides(c.sides)
    setBases(c.sides.map(s => s.basis ?? 'api'))
    setName(c.name)
    setLoadedId(c.id)
    setOnHome(c.onHome === true)
    setEditing(0)
    setSavedSnapshot(JSON.stringify({
      name: c.name,
      onHome: c.onHome === true,
      bases: c.sides.map(x => x.basis ?? 'api'),
      sides: c.sides,
    }))
  }

  const drop = async (id: string) => {
    if (loadedId === id) { setLoadedId(null); setName(''); setOnHome(false) }
    await ctx.saveComparisons(removeComparison(ctx.comparisons, id))
  }

  const barProps = {
    projects: ctx.data.projects ?? [],
    sessionCountByProject: ctx.sessionCountByProject,
    models: ctx.models,
    modelGroups: ctx.modelGroups,
    modelsInProject: ctx.modelsInProject,
    harnesses: ctx.harnesses,
    tags: ctx.tags,
    lang: ctx.lang,
    compact: true,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Saved comparisons — the reason this page is worth returning to. */}
      {ctx.comparisons.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{pt ? 'Salvos:' : 'Saved:'}</span>
          {ctx.comparisons.map(c => (
            <span key={c.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 2,
              border: `1px solid ${loadedId === c.id ? 'var(--anthropic-orange)' : 'var(--border)'}`,
              borderRadius: 999, background: loadedId === c.id ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
              paddingLeft: 10,
            }}>
              <button
                onClick={() => load(c)}
                style={{
                  border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 12, padding: '5px 2px 5px 0',
                  color: loadedId === c.id ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                }}
              >
                {c.name}
                {c.onHome && <HomeIcon size={10} style={{ marginLeft: 5, verticalAlign: -1 }} />}
              </button>
              <button
                onClick={() => void drop(c.id)}
                aria-label={pt ? `Remover ${c.name}` : `Remove ${c.name}`}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: '5px 8px 5px 4px', lineHeight: 0 }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Toolbar: what this comparison is called, which basis it asks in, and where it shows. */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 12px', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)',
      }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={pt ? 'Nome da comparação' : 'Comparison name'}
          style={{
            flex: '1 1 200px', minWidth: 0, padding: '8px 11px', borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)', background: 'var(--bg-input)',
            color: 'var(--text-primary)', fontFamily: 'inherit',
          }}
        />
        <button
          onClick={addSide}
          disabled={sides.length >= MAX_COMPARISON_SIDES}
          title={sides.length >= MAX_COMPARISON_SIDES
            ? (pt ? `Máximo de ${MAX_COMPARISON_SIDES} lados` : `At most ${MAX_COMPARISON_SIDES} sides`)
            : undefined}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px',
            borderRadius: 'var(--radius-md)', cursor: sides.length >= MAX_COMPARISON_SIDES ? 'default' : 'pointer',
            fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
            border: '1px solid var(--border)', background: 'var(--bg-elevated)',
            color: sides.length >= MAX_COMPARISON_SIDES ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            opacity: sides.length >= MAX_COMPARISON_SIDES ? 0.5 : 1, flexShrink: 0,
          }}
        >
          <Plus size={13} />
          {pt ? 'Adicionar coluna comparativa' : 'Add comparison column'}
        </button>
        <button
          onClick={() => setOnHome(v => !v)}
          title={pt ? 'Exibir esta comparação na Home' : 'Show this comparison on Home'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px',
            borderRadius: 'var(--radius-md)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
            border: `1px solid ${onHome ? 'var(--anthropic-orange)' : 'var(--border)'}`,
            background: onHome ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
            color: onHome ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
          }}
        >
          <HomeIcon size={13} />
          {pt ? 'Na Home' : 'On Home'}
        </button>
        {/* Orange ONLY while there is something to save. Once saved it goes quiet and says so —
            a permanently highlighted button reads as an action still owed. */}
        <button
          onClick={() => void save()}
          disabled={!canSave}
          title={name.trim() === ''
            ? (pt ? 'Dê um nome para salvar' : 'Name it to save')
            : !dirty ? (pt ? 'Nada mudou desde o último salvamento' : 'Nothing changed since the last save') : undefined}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px',
            borderRadius: 'var(--radius-md)', fontFamily: 'inherit', fontSize: 12,
            fontWeight: 600, cursor: canSave ? 'pointer' : 'default', flexShrink: 0,
            border: canSave ? 'none' : '1px solid var(--border)',
            background: canSave ? 'var(--anthropic-orange)' : 'transparent',
            color: canSave ? '#fff' : 'var(--text-tertiary)',
          }}
        >
          {canSave ? <Save size={13} /> : savedSnapshot !== null ? <Check size={13} /> : <Save size={13} />}
          {canSave
            ? (loadedId ? (pt ? 'Atualizar' : 'Update') : (pt ? 'Salvar' : 'Save'))
            : savedSnapshot !== null ? (pt ? 'Salvo' : 'Saved') : (pt ? 'Salvar' : 'Save')}
        </button>
      </div>

      {/* The sides. On a phone one bar is mounted and a switch chooses which side it edits — both
          sides' filters stay described above, so nothing the user set is ever hidden. */}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            {sides.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setEditing(i)}
                style={{
                  flex: 1, minHeight: 44, border: 'none', fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
                  background: editing === i ? 'var(--anthropic-orange-dim)' : 'transparent',
                  color: editing === i ? sideColour(i) : 'var(--text-tertiary)', cursor: 'pointer',
                }}
              >
                {sideLabel(s, i)}
              </button>
            ))}
          </div>
          {sides[editing] && (
            <SideCard
              index={editing}
              label={sideLabel(sides[editing]!, editing)}
              description={describe(sides[editing]!)}
              basis={bases[editing] ?? 'api'}
              onBasis={b => setSideBasis(editing, b)}
              planUsable={planUsable}
              onPlanSetup={ctx.openBillingSetup}
              pt={pt}
              onRemove={sides.length > MIN_COMPARISON_SIDES ? () => dropSide(sides[editing]!.id) : undefined}
              removeLabel={pt ? 'Remover lado' : 'Remove side'}
            >
              <FiltersBar {...barProps} filters={sides[editing]!.filters} onChange={f => setSideFilters(sides[editing]!.id, f)} />
            </SideCard>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
          {sides.map((s, i) => (
            <SideCard
              key={s.id}
              index={i}
              label={sideLabel(s, i)}
              description={describe(s)}
              basis={bases[i] ?? 'api'}
              onBasis={b => setSideBasis(i, b)}
              planUsable={planUsable}
              onPlanSetup={ctx.openBillingSetup}
              pt={pt}
              onRemove={sides.length > MIN_COMPARISON_SIDES ? () => dropSide(s.id) : undefined}
              removeLabel={pt ? 'Remover lado' : 'Remove side'}
            >
              <FiltersBar {...barProps} filters={s.filters} onChange={f => setSideFilters(s.id, f)} />
            </SideCard>
          ))}
        </div>
      )}

      <ComparisonTable rows={rows} sides={tableSides} currency={ctx.currency} brlRate={ctx.brlRate} lang={ctx.lang} />

      <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: 0 }}>
        {pt
          ? `Cada variação é medida contra ${sideLabel(sides[0]!, 0)}, o lado de base. Um crescimento a partir de zero não tem porcentagem — aparece só como valor absoluto, porque uma porcentagem ali seria um denominador inventado.`
          : `Every change is measured against ${sideLabel(sides[0]!, 0)}, the baseline. Growth from zero has no percentage — only the absolute figure is shown, because a percentage there would be an invented denominator.`}
      </p>
    </div>
  )
}

function SideCard({ index, label, description, basis, onBasis, planUsable, onPlanSetup, pt, onRemove, removeLabel, children }: {
  index: number
  label: string
  description: string
  basis: CostBasis
  onBasis: (b: CostBasis) => void
  planUsable: boolean
  onPlanSetup: () => void
  pt: boolean
  onRemove?: () => void
  removeLabel: string
  children: React.ReactNode
}) {
  const colour = sideColour(index)
  return (
    <div style={{
      border: `1px solid ${colour}`, borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-card)', padding: '12px 12px 4px', position: 'relative',
    }}>
      <div style={{
        position: 'absolute', top: -9, left: 12, padding: '0 6px', background: 'var(--bg-base)',
        fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: colour,
      }}>
        {label}{index === 0 && ' · base'}
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
          style={{
            position: 'absolute', top: 6, right: 6, border: 'none', background: 'none',
            cursor: 'pointer', color: 'var(--text-tertiary)', padding: 6, lineHeight: 0,
          }}
        >
          <Trash2 size={13} />
        </button>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 9, paddingRight: onRemove ? 24 : 0 }}>
        {/* This side's basis. Per card, because comparing a plan against API prices is the
            question, and the answer changes with WHICH side is which. */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
          {(['api', 'plan'] as const).map(b => {
            const active = basis === b
            const usable = b === 'api' || planUsable
            return (
              <button
                key={b}
                onClick={() => (usable ? onBasis(b) : onPlanSetup())}
                title={!usable ? (pt ? 'Cadastre seu plano para comparar em custo real' : 'Register your plan to compare in real cost') : undefined}
                style={{
                  padding: '4px 9px', border: 'none', fontFamily: 'inherit', fontSize: 11,
                  fontWeight: active ? 700 : 400, cursor: 'pointer', opacity: usable ? 1 : 0.5,
                  background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                  color: active ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                }}
              >
                {b === 'api' ? 'API' : (pt ? 'Plano' : 'Plan')}
              </button>
            )
          })}
        </div>
        <span style={{
          fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {description}
        </span>
      </div>
      {children}
    </div>
  )
}
