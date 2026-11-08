import React from 'react'
import { Check, Circle } from 'lucide-react'
import { VAULT_PASSWORD_RULES, VAULT_PASSWORD_RULE_TEXT, checkVaultPassword, passwordChecks, passwordRuleText, type Lang } from '@agentistics/core'

/**
 * The password rule, stated where it is typed.
 *
 * It used to be discoverable only by being refused — and the refusals named one rule at a time,
 * so satisfying one revealed the next. Someone tried fifteen passwords against a message that
 * said "password is too common". A rule the user cannot read is a rule the user cannot follow.
 *
 * Ticks light up as each requirement is met, using the SAME function the server validates with
 * (`@agentistics/core`), so the form cannot promise something the server will refuse.
 *
 * `rules="vault"` (COFRE.DESBLOQUEIO, 2026-11-07) is the vault password's own set — at least 9
 * characters, 1 uppercase, 2 specials, 1 number (`checkVaultPassword`) — shown as a checklist from the
 * first keystroke, every rule on its own row so the one still missing is the one that is not ticked.
 */
export function PasswordHint({ value, lang = 'en', rules = 'account' }: { value: string; lang?: Lang; rules?: 'account' | 'vault' }) {
  const pt = lang === 'pt'
  if (rules === 'vault') {
    const c = checkVaultPassword(value)
    return (
      <ul aria-label={pt ? 'Regras da senha' : 'Password rules'} style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'grid', gap: 4 }}>
        {VAULT_PASSWORD_RULES.map(r => {
          const done = c.rules[r]
          return (
            <li key={r} data-rule={r} data-met={done} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: done ? '#22c55e' : 'var(--text-tertiary)' }}>
              {done ? <Check size={12} aria-hidden /> : <Circle size={9} aria-hidden />}
              <span>{VAULT_PASSWORD_RULE_TEXT[r][pt ? 'pt' : 'en']}</span>
              <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{done ? (pt ? ' — cumprida' : ' — met') : (pt ? ' — falta' : ' — missing')}</span>
            </li>
          )
        })}
      </ul>
    )
  }
  const c = passwordChecks(value)
  const items: [boolean, string][] = [
    [!c.too_short, pt ? '8 caracteres' : '8 characters'],
    [!c.no_uppercase, pt ? '1 letra maiúscula' : '1 uppercase letter'],
    [!c.no_symbol, pt ? '1 caractere especial' : '1 symbol'],
  ]
  // Before anything is typed, the rule reads as one sentence; once typing starts it becomes a
  // checklist, which is the form that answers "what is still missing".
  if (!value) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '-6px 0 12px', lineHeight: 1.5 }}>
        {passwordRuleText(pt ? 'pt' : 'en')}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '-6px 0 12px' }}>
      {items.map(([done, label]) => (
        <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: done ? '#22c55e' : 'var(--text-tertiary)' }}>
          {done ? <Check size={11} /> : <Circle size={9} />} {label}
        </span>
      ))}
    </div>
  )
}
