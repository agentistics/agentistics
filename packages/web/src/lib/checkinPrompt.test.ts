import { describe, expect, test } from 'bun:test'
import { CHECKIN_PROMPT_MARKER, isCheckinPrompt } from './checkinPrompt'

describe('check-in prompt detector', () => {
  test('matches marked prompts', () => {
    expect(isCheckinPrompt(`${CHECKIN_PROMPT_MARKER}\nFaça o check-in da liderança agora.`)).toBe(true)
  })

  test('matches the legacy opener in old transcripts', () => {
    expect(isCheckinPrompt('Faça o check-in da liderança agora.\n- Sessões e memória')).toBe(true)
  })

  test('does not classify ordinary user text', () => {
    expect(isCheckinPrompt('Você pode fazer o check-in da liderança agora?')).toBe(false)
    expect(isCheckinPrompt('Faça o check-in da liderança agora, por favor.')).toBe(false)
  })
})
