/**
 * CodeBoxes — THE authenticator code input: six rounded boxes, one digit each (owner, 2026-10-06).
 *
 * Every 6-digit prompt in the app goes through this one component (the vault's `CodeField`, its code
 * stage, the account MFA screens), so they cannot drift apart. The editing rules are the pure
 * `lib/codeBoxes.ts`: typing moves on, Backspace goes back, a pasted (or iOS-autofilled) code fills every
 * box. `inputMode="numeric"` brings the number pad on a phone, and box 1 carries
 * `autocomplete="one-time-code"` so the keyboard can offer the code it just received.
 *
 * `error` paints every box red and shakes the row once (the shake is skipped under reduced motion);
 * `errorKey` re-runs the shake when the same error comes back for a second wrong code.
 */
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { CODE_LENGTH, eraseAt, typeAt, typedIn } from '../lib/codeBoxes'

export function CodeBoxes({
  value, onChange, label, autoFocus, onEnter, onComplete, error, errorKey, disabled, hideLabel, length = CODE_LENGTH, style,
}: {
  value: string
  onChange: (v: string) => void
  /** The visible name of the field; each box is announced as "<label> (n/6)". */
  label: string
  autoFocus?: boolean
  onEnter?: () => void
  /** Called once when the last digit lands (the caller may submit). */
  onComplete?: (v: string) => void
  error?: boolean
  errorKey?: unknown
  disabled?: boolean
  hideLabel?: boolean
  length?: number
  style?: React.CSSProperties
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const labelId = useRef(`ag-code-${Math.random().toString(36).slice(2, 9)}`).current
  const [shake, setShake] = useState(false)
  // Typing again after an error is the person answering it: the red goes until the next refusal.
  const [edited, setEdited] = useState(false)
  const red = Boolean(error) && !edited

  const focus = (i: number) => {
    const el = refs.current[Math.min(Math.max(0, i), length - 1)]
    if (el) { el.focus(); el.select() }
  }
  useEffect(() => {
    if (!error) return
    setEdited(false)
    setShake(true)
    // The refused code is usually cleared by the caller: start again from the first empty box.
    requestAnimationFrame(() => focus(value.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, errorKey])

  const apply = (next: { value: string; focus: number }) => {
    const before = value
    if (next.value !== before) setEdited(true)
    onChange(next.value)
    // Move NOW, inside the same event: a fast typist's (or an autofill's) next key must land in the next
    // box — deferring to a frame let it hit this box again and lose a digit. The boxes all exist already,
    // and an input event re-renders synchronously, so the next keystroke sees the new value.
    focus(next.focus)
    if (next.value.length === length && before.length !== length) onComplete?.(next.value)
  }

  return (
    <div style={{ marginBottom: 10, ...style }}>
      <span id={labelId} style={hideLabel ? srOnly : { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>{label}</span>
      <div
        role="group" aria-labelledby={labelId}
        className={`ag-code-boxes${red ? ' is-error' : ''}${shake ? ' is-shaking' : ''}`}
        onAnimationEnd={() => setShake(false)}
      >
        {Array.from({ length }, (_, i) => (
          <input
            key={i}
            ref={el => { refs.current[i] = el }}
            className="ag-code-box"
            value={value[i] ?? ''}
            disabled={disabled}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            autoFocus={autoFocus && i === 0}
            aria-label={`${label} (${i + 1}/${length})`}
            aria-invalid={red ? true : undefined}
            onFocus={e => e.currentTarget.select()}
            onChange={e => apply(typeAt(value, i, typedIn(e.currentTarget.value, value[i]), length))}
            onPaste={e => { e.preventDefault(); apply(typeAt(value, i, e.clipboardData.getData('text'), length)) }}
            onKeyDown={e => {
              // A digit is handled HERE, not in onChange: retyping the digit a box already holds changes no
              // value, React fires no onChange, and the focus would never move on. (A phone keyboard that
              // reports 'Unidentified' still goes through onChange.)
              if (/^\d$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); apply(typeAt(value, i, e.key, length)) }
              else if (e.key === 'Backspace') { e.preventDefault(); apply(eraseAt(value, i)) }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); focus(i - 1) }
              else if (e.key === 'ArrowRight') { e.preventDefault(); focus(Math.min(i + 1, value.length)) }
              else if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter() }
            }}
          />
        ))}
      </div>
    </div>
  )
}

const srOnly: React.CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }
