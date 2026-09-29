/**
 * ModelSelect — the model picker, pulled out of `NewSessionModal`'s step 1 so a second dialog (the
 * staged-session compose panel, t-918cc82233) does not restate it as a free-text field.
 *
 * CLOSED wherever the list is the CLI's own (`modelsSource: 'cli'` — the account's real set): a
 * typed id there could only be one the CLI does not offer. OPEN (`freeText`) where the list is the
 * server's fallback table, which cannot name every id the CLI accepts — there a closed picker would
 * forbid models that work. The typed id is checked for shape here and again on the server.
 *
 * It is built the way `FiltersBar`'s value pickers are built — a trigger, a popover, one checked
 * row per value — rather than a bare `<select>`, which on every platform draws the OS's own menu: a
 * control that ignores this application's palette and its 44px mobile target.
 *
 * WHAT A ROW SAYS: the name the harness's own CLI prints, and — only when the two differ — the id
 * that will actually be sent, in the trailing tag. `opus`/`Opus 5` are the same model under two
 * names, and a picker that shows only one of them leaves the reader unable to match what they chose
 * against what the CLI reports back. Where the harness publishes no name, `label === id` and the
 * tag is ABSENT rather than a repetition.
 *
 * The popover is constrained to the trigger's own width (`left: 0; right: 0`), so it cannot give
 * the page a horizontal scrollbar at any viewport.
 *
 * `open` is the CALLER's state: a dialog that owns the keyboard needs `esc` to close this before it
 * closes the dialog itself.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { modelDisplay } from '../../lib/wizardSteps'
import { inputStyle } from './formBits'
import { typedModelId } from '../../lib/chatModel'

export interface ModelSelectProps {
  lang: 'pt' | 'en'
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The id, or `''` for "leave it to the assistant". */
  value: string
  onChange: (id: string) => void
  options: { id: string; label: string }[]
  /** The sentence for the unset row — what happens when nothing is picked, in words. */
  unsetLabel: string
  /** Also accept a typed id — true only where the list is the incomplete fallback table. */
  freeText?: boolean
}

export function ModelSelect({ lang, open, onOpenChange, value, onChange, options, unsetLabel, freeText }: ModelSelectProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onOpenChange])

  const chosen = modelDisplay(options, value)
  const rowHeight = isMobile ? 44 : undefined

  const row = (key: string, selected: boolean, label: string, tag: string | null, pick: () => void) => (
    <button
      key={key}
      role="option"
      aria-selected={selected}
      onClick={() => { pick(); onOpenChange(false) }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: isMobile ? '0 10px' : '7px 10px', minHeight: rowHeight, boxSizing: 'border-box',
        borderRadius: 6, border: 'none', cursor: 'pointer',
        background: selected ? 'var(--anthropic-orange-dim)' : 'transparent',
        color: selected ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
        fontSize: 12.5, fontFamily: 'inherit', textAlign: 'left',
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-card-hover)' }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
    >
      <span style={{ width: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {selected && <Check size={12} strokeWidth={3} />}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {/* The id, and only when it is not already the label — `modelDisplay`'s rule. */}
      {tag && <ModelId id={tag} />}
    </button>
  )

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        style={{
          ...inputStyle,
          display: 'flex', alignItems: 'center', gap: 8,
          paddingLeft: 12, paddingRight: 10, minHeight: isMobile ? 44 : undefined,
          cursor: 'pointer', textAlign: 'left',
          borderColor: open ? 'var(--anthropic-orange)' : 'var(--border-subtle)',
        }}
      >
        <span style={{
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: chosen ? 'var(--text-primary)' : 'var(--text-tertiary)',
        }}>
          {chosen ? chosen.label : unsetLabel}
        </span>
        {chosen?.id && <ModelId id={chosen.id} />}
        <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={pt ? 'Modelo' : 'Model'}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 10,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            maxHeight: 260, overflowY: 'auto', overflowX: 'hidden',
            boxSizing: 'border-box', padding: 6,
          }}
        >
          {/* The unset row FIRST, and named — "no model" is a decision the CLI acts on, not a
              blank. It is also the row the picker opens on, so it may never be hard to find. */}
          {row('', value === '', unsetLabel, null, () => onChange(''))}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          {options.map(o => {
            const shown = modelDisplay(options, o.id)!
            return row(o.id, o.id === value, shown.label, shown.id, () => onChange(o.id))
          })}
          {freeText && (
            <TypedModel lang={lang} onPick={id => { onChange(id); onOpenChange(false) }} />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A typed model id — the row a picker adds where its list is the fallback table. A form, so `enter`
 * submits; the button is disabled until the text is a usable id (one token, never flag-shaped).
 */
export function TypedModel({ lang, onPick }: { lang: 'pt' | 'en'; onPick: (id: string) => void }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [text, setText] = useState('')
  const id = typedModelId(text)
  return (
    <form
      onSubmit={e => { e.preventDefault(); if (id) onPick(id) }}
      style={{ display: 'flex', gap: 6, padding: '6px 4px 2px', borderTop: '1px solid var(--border)', marginTop: 4 }}
    >
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={pt ? 'outro id de modelo…' : 'other model id…'}
        aria-label={pt ? 'Id de modelo' : 'Model id'}
        style={{ ...inputStyle, flex: 1, minWidth: 0, minHeight: isMobile ? 44 : undefined }}
      />
      <button
        type="submit"
        disabled={!id}
        style={{
          flexShrink: 0, padding: '0 12px', minHeight: isMobile ? 44 : 32, borderRadius: 6,
          border: '1px solid var(--border)', background: 'transparent', fontFamily: 'inherit', fontSize: 12,
          color: id ? 'var(--text-primary)' : 'var(--text-tertiary)', cursor: id ? 'pointer' : 'default',
        }}
      >
        {pt ? 'Usar' : 'Use'}
      </button>
    </form>
  )
}

/** The id beside a model's name. Monospace and quiet: it is what is SENT, not what is read. */
export function ModelId({ id }: { id: string }) {
  return (
    <span style={{
      flexShrink: 0, fontSize: 10.5, color: 'var(--text-tertiary)',
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    }}>{id}</span>
  )
}
