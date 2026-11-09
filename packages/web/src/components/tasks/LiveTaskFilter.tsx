/**
 * LiveTaskFilter — the Live view's task filter: MULTI-SELECT, with the tasks that have live work or
 * recent movement listed first under "Recentes (com atividade)". Chosen tasks are removable chips.
 *
 * Built on the app's own `MultiPicker` (tick several, confirm) — the picker the rest of the product
 * uses — and the shared `pill` chip; it owns only the list order and the chips.
 */

import { X } from 'lucide-react'
import { useMemo } from 'react'
import { shortTitle } from '@agentistics/core'
import { MultiPicker } from '../../pages/settings/primitives'
import { pill } from './board'
import type { TaskOption } from './liveCardModel'

export const RECENT_HEAD = '__live_recent__'
export const REST_HEAD = '__live_rest__'

/** PURE: the picker's options — a "Recentes" block first, the others after, chosen ones removed. */
export function pickerOptions(options: readonly TaskOption[], chosen: readonly string[], pt: boolean): { value: string; label: string; disabled?: boolean; hint?: string; heading?: boolean }[] {
  const left = options.filter(o => !chosen.includes(o.value))
  const recent = left.filter(o => o.recent)
  const rest = left.filter(o => !o.recent)
  const row = (o: TaskOption) => ({ value: o.value, label: o.label, ...(o.live > 0 ? { hint: pt ? `${o.live} ativo${o.live === 1 ? '' : 's'}` : `${o.live} live` } : {}) })
  return [
    ...(recent.length ? [{ value: RECENT_HEAD, label: pt ? 'Recentes (com atividade)' : 'Recent (with activity)', disabled: true, heading: true }, ...recent.map(row)] : []),
    // "Todas as tarefas" is already the trigger's own word; the second block is the rest, said as such.
    ...(rest.length ? [...(recent.length ? [{ value: REST_HEAD, label: pt ? 'Outras tarefas' : 'Other tasks', disabled: true, heading: true }] : []), ...rest.map(row)] : []),
  ]
}

export function LiveTaskFilter({ options, chosen, onChange, pt, mobile }: {
  options: readonly TaskOption[]
  chosen: readonly string[]
  onChange: (ids: string[]) => void
  pt: boolean
  mobile?: boolean
}) {
  const opts = useMemo(() => pickerOptions(options, chosen, pt), [options, chosen, pt])
  return (
    // `display: contents`: the picker is a flex item of the toolbar's filter row (same line as the tabs), and
    // the chips sit on a line of their own below it, so selecting tasks never moves or grows the first row.
    <div data-live-taskfilter style={{ display: 'contents' }}>
      <div style={{ minWidth: mobile ? 0 : 130, flex: mobile ? '1 1 100%' : '0 1 180px' }}>
        <MultiPicker
          options={opts}
          onCommit={v => onChange([...chosen, ...v.filter(x => !chosen.includes(x))])}
          placeholder={chosen.length === 0 ? (pt ? 'Todas as tarefas' : 'All tasks') : (pt ? 'Adicionar tarefa…' : 'Add a task…')}
          searchPlaceholder={pt ? 'Buscar tarefa…' : 'Search tasks…'}
          confirmLabel={n => (pt ? `Adicionar ${n}` : `Add ${n}`)}
          selectAllLabel={pt ? 'Selecionar todas' : 'Select all'}
          emptyLabel={pt ? 'Nenhuma tarefa' : 'No tasks'}
          panelMinWidth={360}
          triggerHeight={mobile ? 44 : 32}
        />
      </div>
    </div>
  )
}

/** The chosen tasks as removable chips — their own row BELOW the controls, never inside the row they would push. */
export function LiveTaskChips({ options, chosen, onChange, pt, mobile }: {
  options: readonly TaskOption[]
  chosen: readonly string[]
  onChange: (ids: string[]) => void
  pt: boolean
  mobile?: boolean
}) {
  const labelOf = (id: string) => options.find(o => o.value === id)?.label ?? id
  if (chosen.length === 0) return null
  return (
    <div data-live-chips style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
      {chosen.map(id => (
        <span key={id} data-live-chip={id} title={labelOf(id)} style={{ ...pill('var(--anthropic-orange)'), gap: 6, maxWidth: 260, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange-light)' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortTitle(labelOf(id), 34)}</span>
          <button
            type="button" aria-label={pt ? `Tirar ${labelOf(id)}` : `Remove ${labelOf(id)}`} data-live-chip-remove
            onClick={() => onChange(chosen.filter(x => x !== id))}
            style={{ display: 'inline-flex', position: 'relative', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit' }}
          >
            <X size={11} aria-hidden />
            {/* The glyph stays 11 px; on a phone the TARGET is a 45 px box around it (QA LOW 11). */}
            {mobile && <span aria-hidden data-live-chip-hit style={{ position: 'absolute', inset: -17 }} />}
          </button>
        </span>
      ))}
    </div>
  )
}
