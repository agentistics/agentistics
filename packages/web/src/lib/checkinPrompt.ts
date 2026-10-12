/** Stable envelope used by scheduled leadership check-ins in every harness transcript. */
export const CHECKIN_PROMPT_MARKER = '[agentistics · check-in]'
export const LEGACY_CHECKIN_OPENER = 'Faça o check-in da liderança agora.'

/** Detects both new scheduled prompts and the unmarked prompt in older transcripts. */
export function isCheckinPrompt(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith(CHECKIN_PROMPT_MARKER) || trimmed.startsWith(LEGACY_CHECKIN_OPENER)
}

/** The checklist text shown inside the collapsed system notice. */
export function checkinPromptBody(text: string): string {
  const trimmed = text.trimStart()
  return trimmed.startsWith(CHECKIN_PROMPT_MARKER)
    ? trimmed.slice(CHECKIN_PROMPT_MARKER.length).trimStart()
    : trimmed
}
