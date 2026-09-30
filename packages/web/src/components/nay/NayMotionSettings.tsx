/**
 * NayMotionSettings.tsx — the three motion choices of the Nay button, each on its own (owner,
 * 2026-09-30): how the BUTTON moves when dragged, how the open DOCK follows it, and how a
 * NOTIFICATION CARD follows it. Any combination is allowed.
 *
 * The dock and the card default to "same as the button" — an ABSENT choice inherits, so a browser
 * that never touched these keeps exactly what it had. Choosing the inherit row again clears the
 * choice rather than pinning the button's current style, so a later change to the button still
 * carries along.
 *
 * ONE component for both places it appears (the dock's gear and Settings → Chat), over one store
 * (`nayFabPrefsStore.ts`), so the two can never disagree.
 */

import { type ReactNode } from 'react'
import { Select } from '../../pages/settings/primitives'
import { NAY_FAB_STYLES, NAY_FAB_STYLE_LABEL, isNayFabStyle, type NayFabPrefs, type NayFabStyle } from '../../lib/nayFab'
import { setNayFabPrefs, useNayFabPrefs } from '../../lib/nayFabPrefsStore'

const INHERIT = 'inherit'

export interface NayMotionSettingsProps {
  pt: boolean
  /** Also offer the button's own drag style (Settings → Chat). The gear already has its own buttons for it. */
  includeButton?: boolean
  /** Lay each choice out as a row with its label beside it (Settings), or stacked (the narrow gear). */
  row?: (label: string, hint: string, control: ReactNode) => ReactNode
}

export function NayMotionSettings({ pt, includeButton, row }: NayMotionSettingsProps) {
  const prefs = useNayFabPrefs()
  const lang = pt ? 'pt' : 'en'
  const styleOptions = NAY_FAB_STYLES.map(s => ({ value: s, label: NAY_FAB_STYLE_LABEL[s][lang] }))
  const inheritOption = {
    value: INHERIT,
    label: pt ? `Igual ao botão (${NAY_FAB_STYLE_LABEL[prefs.style].pt})` : `Same as the button (${NAY_FAB_STYLE_LABEL[prefs.style].en})`,
  }
  const set = (patch: Partial<NayFabPrefs>) => setNayFabPrefs({ ...prefs, ...patch })
  const setOwn = (key: 'dockStyle' | 'cardStyle', v: string) => {
    const next: NayFabPrefs = { ...prefs }
    if (isNayFabStyle(v)) next[key] = v as NayFabStyle
    else delete next[key]
    setNayFabPrefs(next)
  }

  const layout = row ?? ((label: string, hint: string, control: ReactNode) => (
    <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{label}</div>
      {control}
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{hint}</div>
    </div>
  ))

  return (
    <>
      {includeButton && layout(
        pt ? 'Ao arrastar o botão' : 'Dragging the button',
        pt ? 'Como o próprio botão se move' : 'How the button itself moves',
        <Select value={prefs.style} onChange={v => { if (isNayFabStyle(v)) set({ style: v }) }} options={styleOptions} />,
      )}
      {layout(
        pt ? 'A janela segue o botão com' : 'The window follows the button with',
        pt ? 'A janela do Nay aberta, enquanto o botão é arrastado' : 'The open Nay window, while the button is dragged',
        <Select value={prefs.dockStyle ?? INHERIT} onChange={v => setOwn('dockStyle', v)} options={[inheritOption, ...styleOptions]} />,
      )}
      {layout(
        pt ? 'A notificação segue o botão com' : 'The notification follows the button with',
        pt ? 'O cartão de notificação, enquanto o botão é arrastado' : 'The notification card, while the button is dragged',
        <Select value={prefs.cardStyle ?? INHERIT} onChange={v => setOwn('cardStyle', v)} options={[inheritOption, ...styleOptions]} />,
      )}
    </>
  )
}
