import React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { useIsMobile } from '../hooks/useIsMobile'

/**
 * The show/hide control for a password field.
 *
 * One implementation rather than one per screen: this app asks for a password in six places
 * (sign-in, owner setup, both change-password flows, the step-up prompt, the account creator),
 * and a reveal that exists on some of them is worse than none — the user learns to look for it.
 *
 * Usage: give the field's wrapper `position: relative`, add `REVEAL_PAD` to the input's
 * `paddingRight` so the text never runs under the button, and render this beside it.
 *
 * The button is `type="button"`: inside a <form> a bare <button> submits, so a plain one here
 * would send a half-typed password every time someone tried to look at it.
 */
export const REVEAL_PAD = 38

export function RevealButton({ shown, onToggle, lang }: {
  shown: boolean
  onToggle: () => void
  lang?: Lang
}) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const label = shown ? (pt ? 'Ocultar a senha' : 'Hide password') : (pt ? 'Mostrar a senha' : 'Show password')
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={shown}
      style={{
        position: 'absolute', top: 1, bottom: 1, right: 1,
        // 44px wide on a phone (the touch-target rule); the height is the field's own, which is
        // as tall as a text input gets without making every form on the page taller.
        width: isMobile ? 44 : 34,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', border: 'none', borderRadius: 7,
        color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0,
      }}
      onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-secondary)' }}
      onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-tertiary)' }}
    >
      {shown ? <EyeOff size={15} /> : <Eye size={15} />}
    </button>
  )
}

/**
 * Wraps an input so `RevealButton` can sit inside it, and reports the type the input should
 * carry. The caller still owns the input — this only positions the affordance.
 */
export function Revealable({ shown, onToggle, lang, disabled, children }: {
  shown: boolean
  onToggle: () => void
  lang?: Lang
  /** The field is not secret right now (the account step-up prompt in one-time-code mode). The
   *  button is then ABSENT, not present and inert — an eye that does nothing is a bug report. */
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      {children}
      {!disabled && <RevealButton shown={shown} onToggle={onToggle} lang={lang} />}
    </div>
  )
}
