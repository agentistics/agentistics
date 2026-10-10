/**
 * ModePicker — the New session "Mode" field (MODE.EVERYWHERE): the four canonical permission modes the
 * owner named for every harness, narrowed to the ones THIS harness can start in here (the server's
 * `modes`, from each CLI's own flags plus what its structured driver takes).
 *
 * The same control as the composer's mode chip, in the wizard's terms: the same colours
 * (`modeStyle` by canonical meaning), the same words (`CANONICAL_MODE_TEXT`), and the same warning on
 * "no questions" (`NO_QUESTIONS_WARNING`), which is shown whenever that mode is chosen — never behind a
 * hover, because a phone has none. Built on `EffortPicker`'s button row so the step reads as one form.
 */
import { AlertTriangle } from 'lucide-react'
import { CANONICAL_MODE_TEXT, NO_QUESTIONS_WARNING, type CanonicalMode } from '@agentistics/core'
import { modeStyle } from '../../lib/modeStyle'

export interface ModePickerProps {
  /** The modes this harness can start in, `default` first. */
  modes: readonly CanonicalMode[]
  value: CanonicalMode
  onChange: (value: CanonicalMode) => void
  lang: 'pt' | 'en'
}

export function ModePicker({ modes, value, onChange, lang }: ModePickerProps) {
  if (modes.length < 2) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div role="radiogroup" aria-label={lang === 'pt' ? 'Modo' : 'Mode'} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {modes.map(mode => {
          const on = value === mode
          const style = modeStyle({ id: mode, canonical: mode })
          // The default chip is neutral by design; its dot still needs a colour to read as a choice.
          const dot = mode === 'default' ? 'var(--text-tertiary)' : style.fg
          const text = CANONICAL_MODE_TEXT[mode][lang]
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={on}
              data-mode={mode}
              title={text.hint}
              onClick={() => onChange(mode)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '8px 13px', borderRadius: 9, cursor: 'pointer', minHeight: 36,
                border: `1px solid ${on ? (mode === 'default' ? 'var(--border)' : style.border) : 'var(--border-subtle)'}`,
                background: on ? style.bg : 'var(--bg-elevated)',
                color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontFamily: 'inherit', fontSize: 12.5, fontWeight: on ? 650 : 500,
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, flexShrink: 0 }} />
              {text.label}
            </button>
          )
        })}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45 }}>
        {CANONICAL_MODE_TEXT[value][lang].hint}
      </div>
      {value === 'no-questions' && <NoQuestionsWarning lang={lang} />}
    </div>
  )
}

/** The warning "no questions" carries wherever it can be chosen — here and in the chip's menu. */
export function NoQuestionsWarning({ lang, compact }: { lang: 'pt' | 'en'; compact?: boolean }) {
  return (
    <div role="note" data-no-questions-warning style={{
      display: 'flex', gap: 8, alignItems: 'flex-start',
      padding: compact ? '6px 8px' : '9px 11px', borderRadius: 8,
      border: '1px solid color-mix(in srgb, var(--anthropic-orange) 45%, transparent)',
      background: 'var(--anthropic-orange-dim)',
      color: 'var(--text-primary)', fontSize: compact ? 11 : 12, lineHeight: 1.45,
    }}>
      <AlertTriangle size={compact ? 12 : 14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--anthropic-orange)' }} />
      <span>{NO_QUESTIONS_WARNING[lang]}</span>
    </div>
  )
}
