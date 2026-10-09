import { describe, expect, test } from 'bun:test'
import { terminalNeedsConfirm, terminalToast } from './terminalSwitch'

describe('terminalNeedsConfirm', () => {
  test('asks only while a reply is being written', () => {
    expect(terminalNeedsConfirm('working')).toBe(true)
    for (const s of ['waiting', 'waiting-approval', 'closed', 'lost', 'unknown']) expect(terminalNeedsConfirm(s)).toBe(false)
  })
})

describe('terminalToast', () => {
  test('success is a success toast carrying the server\'s own sentence', () => {
    expect(terminalToast({ ok: true, message: 'now in a terminal' }, 'en'))
      .toEqual({ type: 'success', title: 'Open in terminal', message: 'now in a terminal' })
  })
  test('a refusal (gemini cannot resume by id) is a warning with the sentence untouched, in PT too', () => {
    const msg = 'o gemini não retoma uma conversa pelo id num terminal, então esta sessão fica onde está'
    expect(terminalToast({ ok: false, message: msg }, 'pt'))
      .toEqual({ type: 'warning', title: 'Abrir no terminal', message: msg })
  })
})
