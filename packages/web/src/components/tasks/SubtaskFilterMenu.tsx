/**
 * SubtaskFilterMenu — the subtask grid's filter (status, assistant, model; t-63b7d3b2b0 #2) behind ONE
 * labeled trigger.
 *
 * It replaced three bare selects that each rested on "All": a row reading `All All All` names no
 * dimension, so the reader could not tell which one was which without opening each. Here the trigger
 * says what it filters and how many dimensions are narrowed, and the panel names every dimension
 * above its own options. Each dimension is single-choice — pressing the active pill again clears it.
 *
 * Same popover contract as `PickerMenu` (fixed, in a portal, clamped, closing on outside scroll),
 * because a panel opened inside a scrolling table is clipped by it. Client-side and NOT persisted, the
 * lifetime `subtaskFilter.ts`'s own header argues for.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Filter } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { scrollIsOutside } from '../../lib/popoverScroll'
import { harnessColor, liveStatusMap, liveStatusOrder, microLabel, surface } from './board'
import {
  distinctHarnesses, distinctModels, EMPTY_SUBTASK_FILTER, type SubtaskFilterState,
} from './subtaskFilter'
import { boardCopy, type Lang } from './copy'
import type { TaskSessionRow } from '../../lib/tasks'
import type { TaskStatusDef } from '@agentistics/core'

interface Option { value: string; label: string; color: string }

const WIDTH = 300

export function SubtaskFilterMenu({ value, onChange, sessions, statuses, lang, label, triggerStyle }: {
  value: SubtaskFilterState
  onChange: (next: SubtaskFilterState) => void
  /** The sessions the filtered rows can carry — the assistant/model options come from what is
   *  actually filed, so the panel never offers a value nothing could ever match. */
  sessions: readonly TaskSessionRow[]
  statuses: readonly TaskStatusDef[] | null
  lang: Lang
  /** The trigger's words; defaults to the plain "Filter". */
  label?: string
  triggerStyle?: React.CSSProperties
}) {
  const isMobile = useIsMobile()
  const copy = boardCopy(lang).subtaskFilter
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onScroll = (e: Event) => { if (scrollIsOutside(panel.current, e.target)) close() }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const map = liveStatusMap(statuses)
  const sections: { key: keyof SubtaskFilterState; title: string; options: Option[] }[] = [
    {
      key: 'status', title: copy.status,
      options: liveStatusOrder(statuses).map(id => ({
        value: id, label: map[id]?.label ?? id, color: map[id]?.color ?? 'var(--text-tertiary)',
      })),
    },
    {
      key: 'harness', title: copy.harness,
      options: distinctHarnesses(sessions).map(h => ({ value: h, label: h, color: harnessColor(h) })),
    },
    {
      key: 'model', title: copy.model,
      options: distinctModels(sessions).map(m => ({ value: m, label: m, color: 'var(--text-secondary)' })),
    },
  ]
  const active = sections.filter(s => value[s.key] !== null).length
  const width = Math.min(WIDTH, (typeof window === 'undefined' ? WIDTH + 16 : window.innerWidth) - 16)

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        style={{
          ...triggerStyle,
          ...(active > 0 ? {
            color: 'var(--anthropic-orange)', border: '1px solid var(--anthropic-orange)',
            background: 'var(--anthropic-orange-dim)',
          } : {}),
        }}
        onClick={() => {
          if (open) { setOpen(false); return }
          const r = trigger.current?.getBoundingClientRect()
          if (!r) return
          setAt({ left: Math.min(Math.max(8, r.left), window.innerWidth - width - 8), top: r.bottom + 6 })
          setOpen(true)
        }}
      >
        <Filter size={13} /> {label ?? copy.trigger}
        {active > 0 && (
          <span style={{
            marginLeft: 2, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, fontSize: 10,
            fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--anthropic-orange)', color: '#fff',
          }}>{active}</span>
        )}
      </button>
      {open && at && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1199 }} />
          <div ref={panel} role="dialog" aria-label={copy.title} style={{
            position: 'fixed', left: at.left, top: at.top, width, zIndex: 1200,
            ...surface, background: 'var(--bg-elevated)', padding: 12, display: 'grid', gap: 12,
            boxShadow: 'var(--shadow-elevated)', maxHeight: 420, overflowY: 'auto',
          }}>
            <div style={{ ...microLabel }}>{copy.title}</div>
            {sections.map(sec => (
              <div key={sec.key} style={{ display: 'grid', gap: 6 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{sec.title}</div>
                {sec.options.length === 0
                  // No session is filed yet, so nothing could match — said, not drawn as a dash.
                  ? <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                    {lang === 'pt' ? 'Nenhuma sessão arquivada ainda.' : 'No session filed yet.'}
                  </div>
                  : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {sec.options.map(o => {
                        const on = value[sec.key] === o.value
                        return (
                          <button
                            key={o.value} type="button" aria-pressed={on}
                            // `.ag-tap` projects the 44px mobile target around the pill instead of
                            // painting it — a 44px-tall pill is an ellipse (touchTarget.lint.test.ts).
                            className="ag-tap"
                            onClick={() => onChange({ ...value, [sec.key]: on ? null : o.value })}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                              fontFamily: 'inherit', fontSize: 11.5, borderRadius: 999,
                              padding: '0 9px', minHeight: 24,
                              maxWidth: '100%',
                              border: `1px solid ${on ? o.color : 'var(--border)'}`,
                              background: on ? 'var(--bg-card-hover)' : 'transparent',
                              color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                            }}
                          >
                            <span style={{ width: 7, height: 7, borderRadius: 4, background: o.color, flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {o.label}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
              </div>
            ))}
            {active > 0 && (
              <button
                type="button"
                onClick={() => onChange(EMPTY_SUBTASK_FILTER)}
                style={{
                  justifySelf: 'start', background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  color: 'var(--anthropic-orange)', fontSize: 11.5, fontFamily: 'inherit',
                  minHeight: isMobile ? 44 : undefined,
                }}
              >{copy.clear}</button>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
