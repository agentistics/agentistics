/**
 * CalendarFilters — the filter row, built from the app's own pickers: `Select` for the task scope (default: the tasks
 * being worked on), `MultiPicker` + removable pills for stage, version, harness and priority (the pattern the Live
 * line's task filter uses), `ToggleSwitch` for "confirmed only". The state is core's `CalFilters` in a UI shape;
 * `toCalFilters` is the one conversion, so the screen filters with the very function the MCP tool calls.
 */
import { useMemo } from 'react'
import { Filter, X } from 'lucide-react'
import { CAL_PRIORITIES, CAL_STAGES, type CalFilters, type CalPiece, type CalPriority, type CalStage } from '@agentistics/core'
import { MultiPicker, Select } from '../../pages/settings/primitives'
import { ToggleSwitch } from '../ToggleSwitch'
import { pill } from '../tasks/board'
import { PRIORITY_LABEL, TEXT, pick } from './calendarText'
import { stageName } from './calendarUi'

export interface UiFilters {
  /** `active` | `all` | `task:<id>` */
  tasks: string
  versions: string[]
  stages: CalStage[]
  harnesses: string[]
  priorities: CalPriority[]
  confirmedOnly: boolean
}
export const DEFAULT_FILTERS: UiFilters = { tasks: 'active', versions: [], stages: [], harnesses: [], priorities: [], confirmedOnly: false }

/** URL data is untrusted; unknown stage/priority names must never reach the label lookup. */
export function readCalendarFilters(raw: string | null): UiFilters {
  try {
    const f = JSON.parse(raw ?? 'null')
    if (!f || typeof f.tasks !== 'string' || !(f.tasks === 'active' || f.tasks === 'all' || f.tasks.startsWith('task:')) || typeof f.confirmedOnly !== 'boolean') return DEFAULT_FILTERS
    if (!['versions', 'stages', 'harnesses', 'priorities'].every(k => Array.isArray(f[k]) && f[k].every((v: unknown) => typeof v === 'string'))) return DEFAULT_FILTERS
    if (!f.stages.every((v: CalStage) => CAL_STAGES.includes(v)) || !f.priorities.every((v: CalPriority) => CAL_PRIORITIES.includes(v))) return DEFAULT_FILTERS
    return f
  } catch { return DEFAULT_FILTERS }
}

export function toCalFilters(f: UiFilters): CalFilters {
  const one = f.tasks.startsWith('task:')
  return {
    tasks: f.tasks === 'active' ? 'active' : 'all',
    ...(one ? { task: f.tasks.slice(5) } : {}),
    ...(f.versions.length ? { versions: f.versions } : {}),
    ...(f.stages.length ? { stages: f.stages } : {}),
    ...(f.harnesses.length ? { harnesses: f.harnesses } : {}),
    ...(f.priorities.length ? { priorities: f.priorities } : {}),
    ...(f.confirmedOnly ? { confirmedOnly: true } : {}),
  }
}

/** Counts the dimensions narrowing the view beyond the default — the "reset" affordance appears only then. */
export function filtersActive(f: UiFilters): boolean {
  return f.tasks !== 'active' || f.versions.length + f.stages.length + f.harnesses.length + f.priorities.length > 0 || f.confirmedOnly
}

function Multi({ label, options, chosen, labelOf, onChange, pt, mobile, sheet }: {
  label: string; options: { value: string; label: string }[]; chosen: readonly string[]; labelOf: (v: string) => string; onChange: (v: string[]) => void; pt: boolean; mobile: boolean; sheet: boolean
}) {
  const left = options.filter(o => !chosen.includes(o.value))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: mobile && !sheet ? 'nowrap' : 'wrap', minWidth: 0, flexShrink: 0 }}>
      <div data-cal-field style={sheet ? { width: '100%' } : { width: mobile ? 130 : 116, flexShrink: 0 }}>
        <MultiPicker
          options={left} onCommit={v => onChange([...chosen, ...v.filter(x => !chosen.includes(x))])}
          placeholder={label} searchPlaceholder={`${label}…`} confirmLabel={n => pick(TEXT.confirmAdd(n), pt)}
          selectAllLabel={pick(TEXT.selectAll, pt)} emptyLabel={pick(TEXT.noTasks, pt)} disabled={left.length === 0 && chosen.length === 0}
        />
      </div>
      {chosen.map(v => (
        <span key={v} data-cal-chip={v} style={{ ...pill('var(--anthropic-orange)'), gap: 5, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange-light)' }}>
          {labelOf(v)}
          <button type="button" aria-label={`${pick(TEXT.removeFilter, pt)}: ${labelOf(v)}`} onClick={() => onChange(chosen.filter(x => x !== v))}
            style={{ display: 'inline-flex', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', minWidth: mobile ? 28 : undefined, minHeight: mobile ? 28 : undefined, alignItems: 'center', justifyContent: 'center' }}><X size={11} /></button>
        </span>
      ))}
    </div>
  )
}

export function CalendarFilters({ value, onChange, pieces, harnessOf, versionList, showVersions = true, pt, mobile, sheet = false, shown }: {
  value: UiFilters; onChange: (f: UiFilters) => void; pieces: readonly CalPiece[]
  /** Display name of a harness id (`HARNESS_LABELS`). */
  harnessOf: (id: string) => string
  versionList: readonly string[]; showVersions?: boolean; pt: boolean; mobile: boolean
  /** Inside the phone's Filters sheet: one column, every field the same full width, left-aligned. */
  sheet?: boolean
  /** The count caption on the right: `9 pieces · 4 versions · BRT`. */
  shown: string
}) {
  const tasks = useMemo(() => {
    const seen = new Map<string, string>()
    for (const p of pieces) if (!seen.has(p.taskId)) seen.set(p.taskId, p.taskTitle)
    return [...seen].map(([id, title]) => ({ value: `task:${id}`, label: title })).sort((a, b) => a.label.localeCompare(b.label))
  }, [pieces])
  const harnesses = useMemo(() => [...new Set(pieces.flatMap(p => (p.harness ? [p.harness] : [])))].sort(), [pieces])
  const set = (patch: Partial<UiFilters>) => onChange({ ...value, ...patch })

  return (
    // A phone gets ONE row that scrolls sideways (the mockup's), a desktop wraps.
    <div data-cal-filters data-cal-sheet={sheet || undefined} style={sheet
      ? { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 12, paddingTop: 12, minWidth: 0 }
      : { display: 'flex', alignItems: 'center', gap: 8, flexWrap: mobile ? 'nowrap' : 'wrap', overflowX: mobile ? 'auto' : undefined, paddingBottom: 8, minWidth: 0, flexShrink: 0 }}>
      <div data-cal-field style={sheet ? { display: 'flex', alignItems: 'center', gap: 6, width: '100%' } : { minWidth: mobile ? 220 : 200, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        {!sheet && <Filter size={13} aria-hidden style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Select control
            value={value.tasks} onChange={v => set({ tasks: v })} searchable searchPlaceholder={pick(TEXT.searchTask, pt)}
            options={[{ value: 'active', label: `${pick(TEXT.tasks, pt)}: ${pick(TEXT.active, pt).toLowerCase()}` }, { value: 'all', label: pick(TEXT.allTasks, pt) }, ...tasks]}
          />
        </div>
      </div>
      <Multi label={pick(TEXT.stage, pt)} pt={pt} mobile={mobile} sheet={sheet} chosen={value.stages} labelOf={v => stageName(v as CalStage, pt)}
        options={CAL_STAGES.map(s => ({ value: s, label: stageName(s, pt) }))} onChange={v => set({ stages: v as CalStage[] })} />
      {showVersions && <Multi label={pick(TEXT.version, pt)} pt={pt} mobile={mobile} sheet={sheet} chosen={value.versions} labelOf={v => v}
        options={versionList.map(v => ({ value: v, label: v }))} onChange={v => set({ versions: v })} />}
      <Multi label={pick(TEXT.harness, pt)} pt={pt} mobile={mobile} sheet={sheet} chosen={value.harnesses} labelOf={harnessOf}
        options={harnesses.map(h => ({ value: h, label: harnessOf(h) }))} onChange={v => set({ harnesses: v })} />
      <Multi label={pick(TEXT.priority, pt)} pt={pt} mobile={mobile} sheet={sheet} chosen={value.priorities} labelOf={v => pick(PRIORITY_LABEL[v as CalPriority], pt)}
        options={CAL_PRIORITIES.map(p => ({ value: p, label: pick(PRIORITY_LABEL[p], pt) }))} onChange={v => set({ priorities: v as CalPriority[] })} />
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', minHeight: mobile ? 44 : undefined, width: sheet ? '100%' : undefined }}>
        <ToggleSwitch on={value.confirmedOnly} onToggle={() => set({ confirmedOnly: !value.confirmedOnly })} label={pick(TEXT.onlyConfirmed, pt)} {...(mobile ? { tap: 44 } : {})} />
        {pick(TEXT.onlyConfirmed, pt)}
      </label>
      {!sheet && <span style={{ flex: 1 }} />}
      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0 }}>{shown}</span>
    </div>
  )
}
