/**
 * NewTag — the mark that says a feature has JUST ARRIVED.
 *
 * A sibling of `BetaTag` and deliberately not part of it: the two say different things and a feature
 * can carry either, both or neither. `beta` is a CAVEAT ("it works, it is still being changed");
 * `new` is an INVITATION ("this was not here last week, go and look"). Collapsing them into one
 * badge would make the caveat read as excitement or the invitation read as a warning.
 *
 * It is a component for the reason `BetaTag` is one: a mark that appears on the desktop entry and not
 * on the mobile one is worse than none, because the reader concludes the unmarked one is something
 * else. One component, every surface that names the feature.
 *
 * LOCALIZED, which `BetaTag` does not have to be — `beta` is the same word in both languages and
 * `new` is not. The word is the signal and the colour is only emphasis, so a colour-blind reader and
 * a screen reader get the same thing everybody else does.
 */

import type { CSSProperties } from 'react'

export interface NewTagProps {
  lang: 'pt' | 'en'
  style?: CSSProperties
}

export function NewTag({ lang, style }: NewTagProps) {
  const pt = lang === 'pt'
  return (
    <span
      title={pt
        ? 'Isto é novo — acabou de chegar ao produto.'
        : 'This is new — it has just arrived in the product.'}
      style={{
        display: 'inline-flex', alignItems: 'center', flexShrink: 0,
        padding: '1px 5px', borderRadius: 4,
        fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em', lineHeight: 1.5,
        textTransform: 'uppercase',
        // FILLED, where `BetaTag` is hollow. The two sit side by side on the same control, so they
        // have to be told apart at a glance without reading either word — and the filled one is the
        // invitation, which is the half that is meant to catch an eye.
        border: '1px solid var(--anthropic-orange)',
        background: 'var(--anthropic-orange)',
        color: '#fff',
        ...style,
      }}
    >{pt ? 'novo' : 'new'}</span>
  )
}
