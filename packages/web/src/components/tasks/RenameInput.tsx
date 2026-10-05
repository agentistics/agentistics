import { useEffect, useRef, useState } from 'react'
import { planRename, renameKey, TITLE_MAX } from './renameTitle'

/**
 * The inline title editor — ONE component for the task page's heading and the table row, so both
 * answer the same keys: Enter or leaving the field saves, Escape cancels, a blank or unchanged title
 * writes nothing (`planRename`). It selects the text on open so typing replaces it.
 */
export function RenameInput({ value, onSave, onCancel, ariaLabel, style }: {
  value: string
  onSave: (title: string) => void | Promise<void>
  onCancel: () => void
  ariaLabel: string
  style?: React.CSSProperties
}) {
  const [draft, setDraft] = useState(value)
  const done = useRef(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    const next = save ? planRename(value, draft) : null
    if (next) void onSave(next); else onCancel()
  }
  return (
    <input
      ref={ref}
      data-rename-input
      value={draft}
      maxLength={TITLE_MAX}
      aria-label={ariaLabel}
      onChange={e => setDraft(e.target.value)}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        const k = renameKey(e.key)
        if (!k) return
        e.preventDefault(); e.stopPropagation()
        finish(k === 'save')
      }}
      onBlur={() => finish(true)}
      style={{
        minWidth: 0, width: '100%', boxSizing: 'border-box', font: 'inherit', color: 'var(--text-primary)',
        background: 'var(--bg-elevated)', border: '1px solid var(--anthropic-orange)', borderRadius: 6, padding: '2px 8px',
        ...style,
      }}
    />
  )
}
