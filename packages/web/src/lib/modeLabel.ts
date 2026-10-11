/**
 * modeLabel.ts — PURE: the words the composer's mode chip and menu use for a mode.
 *
 * A mode that means one of the four canonical ones is shown in the product's own words and language
 * (the same `CANONICAL_MODE_TEXT` the New session "Mode" field uses), so the chip and the field agree;
 * the harness's own word ("skip permissions", "YOLO") stays in the tooltip. A mode with no canonical
 * meaning is shown as the harness says it.
 */
import { CANONICAL_MODE_TEXT, type SessionMode } from '@agentistics/core'

type Lang = 'pt' | 'en'

export function modeLabel(mode: { label: string; canonical?: SessionMode['canonical'] }, lang: Lang): string {
  return mode.canonical ? CANONICAL_MODE_TEXT[mode.canonical][lang].label : mode.label
}

/** The tooltip: the hint of what the mode does, plus the harness's own word when it differs. */
export function modeTitle(mode: { label: string; canonical?: SessionMode['canonical'] }, lang: Lang): string {
  if (!mode.canonical) return mode.label
  const text = CANONICAL_MODE_TEXT[mode.canonical][lang]
  return text.label === mode.label ? text.hint : `${text.hint} (${mode.label})`
}

const ONLY_MODE_NOTE: Record<Lang, string> = {
  en: 'This session runs over the harness protocol, where the only mode available is "No questions".',
  pt: 'Esta sessão roda pelo protocolo do harness, onde o único modo disponível é "Sem perguntas".',
}

/**
 * The note a menu carries when the session's protocol offers exactly ONE mode and it is "no questions"
 * (agy's structured mode): without it the menu reads as a choice that was left out.
 */
export function onlyModeNote(options: readonly { canonical?: SessionMode['canonical'] }[], lang: Lang): string | null {
  return options.length === 1 && options[0]?.canonical === 'no-questions' ? ONLY_MODE_NOTE[lang] : null
}
