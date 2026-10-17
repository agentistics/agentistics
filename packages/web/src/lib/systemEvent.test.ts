import { roleChangeNote, roleLine } from '@agentistics/core'
import { describe, expect, test } from 'bun:test'
import { parseSystemEvent, systemEventLine } from './systemEvent'

describe('parseSystemEvent', () => {
  test('a session message wrapped as pasted content by the harness is still a system event', () => {
    const wrapped = '\n\n<pasted_content id="a245">\n[from session 0bcf21c173 · handback]\nfix ready @ fc61e0d4\n- tests 6671 pass\n</pasted_content id="a245">\n'
    expect(parseSystemEvent(wrapped)).toEqual({ kind: 'handback', sender: '0bcf21c173', body: 'fix ready @ fc61e0d4\n- tests 6671 pass' })
    expect(parseSystemEvent('<pasted_content id="x1">\n[from agentistics · away]\nAway on\n</pasted_content id="x1">')?.kind).toBe('away')
  })
  test('pasted ordinary text, or a wrapper that does not span the whole message, stays the person\'s', () => {
    expect(parseSystemEvent('<pasted_content id="a">\nsome log\n</pasted_content id="a">')).toBeNull()
    expect(parseSystemEvent('look at this\n<pasted_content id="a">\n[from session abc · handback]\nx\n</pasted_content id="a">')).toBeNull()
    expect(parseSystemEvent('<pasted_content id="a">\n[from session abc · handback]\nx\n</pasted_content id="a">\nmy comment')).toBeNull()
    expect(parseSystemEvent('<pasted_content id="a">\n[from session abc · handback]\nx\n</pasted_content id="b">')).toBeNull()
  })
  test('marked check-in keeps the checklist and away instructions as the body', () => {
    const body = 'Faça o check-in da liderança agora.\n- Review sessions\nAWAY MODE — decide within the authorisations.'
    expect(parseSystemEvent(`[from agentistics · check-in]\n${body}`)).toEqual({ kind: 'checkin', body })
  })
  test('legacy Portuguese and English check-in prompts keep their full text', () => {
    for (const opener of ['Faça o check-in da liderança agora.', 'Run the leadership check-in now.']) {
      const body = `${opener}\n- Review sessions\n\nagentistics_checkin_report`
      expect(parseSystemEvent(body)).toEqual({ kind: 'checkin', body })
    }
  })
  test('legacy prompt tolerates leading whitespace; a quoted reply stays ordinary text', () => {
    expect(parseSystemEvent('\n  Run the leadership check-in now.\nx')?.kind).toBe('checkin')
    expect(parseSystemEvent('> [from agentistics · check-in]\nreply')).toBeNull()
  })
  test('merely mentioning check-in is ordinary user text', () => {
    expect(parseSystemEvent('Can you explain the leadership check-in?')).toBeNull()
    expect(parseSystemEvent('Please discuss: Faça o check-in da liderança agora.')).toBeNull()
    expect(parseSystemEvent('Please discuss: Run the leadership check-in now.')).toBeNull()
    expect(parseSystemEvent('[from session abc · check-in]\nx')?.kind).toBe('session-note')
  })
  test('check-in system lines are localized', () => {
    const event = parseSystemEvent('[from agentistics · check-in]\nx')!
    expect(systemEventLine(event, true)).toBe('Check-in da liderança · sistema')
    expect(systemEventLine(event, false)).toBe('Leadership check-in · system')
  })
  test('agentistics headers', () => {
    expect(parseSystemEvent('[from agentistics · away]\nAway off')).toEqual({ kind: 'away', body: 'Away off' })
    expect(parseSystemEvent('[from agentistics · question]\nhand off?')?.kind).toBe('question')
  })
  test('away OFF is told apart from ON/updated', () => {
    const off = parseSystemEvent('[from agentistics · away]\n[agentistics · away mode is now OFF for this session] back')!
    expect(off.kind).toBe('away-off')
    expect(systemEventLine(off, true)).toBe('Modo ausente desligado nesta sessão')
    expect(systemEventLine(parseSystemEvent('[from agentistics · away]\nAway on')!, true)).toBe('Modo ausente atualizado')
    expect(systemEventLine(parseSystemEvent('[from agentistics · question]\nx')!, true)).toBe('Dica de passagem de contexto')
  })
  test('session headers carry the sender', () => {
    expect(parseSystemEvent('[from session child-1 · handback]\ndone')).toEqual({ kind: 'handback', sender: 'child-1', body: 'done' })
    expect(parseSystemEvent('[from session ab12 · block]\nx')?.kind).toBe('block')
    expect(parseSystemEvent('[from session ab12 · question]\nx')?.kind).toBe('session-question')
  })
  test('ordinary text is not an event; unknown headers are generic system events', () => {
    expect(parseSystemEvent('hello [from agentistics · away]')).toBeNull()
    expect(parseSystemEvent('[from agentistics · nope]\nx')?.kind).toBe('notice')
    expect(parseSystemEvent('[from session a · nope]\nx')?.kind).toBe('session-note')
  })
  test('lines are localized', () => {
    const e = parseSystemEvent('[from session s1 · block]\nx')!
    expect(systemEventLine(e, true)).toBe('Sessão s1 está bloqueada')
    expect(systemEventLine(e, false, 'Title')).toBe('Session Title is blocked')
  })
})

test('r2: multi-line body and CRLF headers parse', () => {
  expect(parseSystemEvent('[from session ab1 · block]\nl1\nl2\n')).toEqual({ kind: 'block', sender: 'ab1', body: 'l1\nl2' })
  expect(parseSystemEvent('[from agentistics · away]\r\nAway mode is now OFF')?.kind).toBe('away-off')
})
test('r2: header-like prose does not match', () => {
  expect(parseSystemEvent('please see [from session x · handback] text')).toBeNull()
  expect(parseSystemEvent('[from session x · handback] same line')).toBeNull()
  expect(parseSystemEvent('hello\n[from agentistics · away]\nx')).toBeNull()
})


test('role notices: marked and exact historical output, wrapped or plain', () => {
  for (const role of ['leader', 'worker', null] as const) {
    const legacy = `[agentistics] your role is now ${role ? role.toUpperCase() : 'AUTO'} — ${roleLine(role)}`
    for (const text of [roleChangeNote(role), legacy]) {
      expect(parseSystemEvent(text)?.kind).toBe('role')
      expect(parseSystemEvent(`<pasted_content id="r">\n${text}\n</pasted_content id="r">`)?.kind).toBe('role')
    }
  }
  expect(systemEventLine({ kind: 'role', body: '' }, false)).toBe('Session role updated')
  expect(systemEventLine({ kind: 'role', body: '' }, true)).toBe('Papel da sessão atualizado')
})

test('typed prose merely containing the agentistics marker remains ordinary text', () => {
  for (const text of ['Please explain [agentistics]', '[agentistics] is the app name', '[agentistics] your role is now LEADER', `Please review:\n${roleChangeNote('leader')}`]) {
    expect(parseSystemEvent(text)).toBeNull()
  }
})

describe('relay and unknown headers fail closed', () => {
  test('the relay header is a relay event, readable', () => {
    const e = parseSystemEvent('[from agentistics · relay]\nChegou na sessão anterior')!
    expect(e.kind).toBe('relay')
    expect(systemEventLine(e, false)).toContain('previous session')
  })
  test('unknown headers are system events, never null', () => {
    expect(parseSystemEvent('[from agentistics · brand-new]\nx')).toEqual({ kind: 'notice', label: 'brand-new', body: 'x' })
    const s = parseSystemEvent('<pasted_content id="z">\n[from session abc123 · fyi]\nx\n</pasted_content id="z">')!
    expect(s.kind).toBe('session-note')
    expect(systemEventLine(s, true)).toBe('Sessão abc123 (fyi)')
  })
  test('every producer header in the codebase is recognised', async () => {
    const { Glob } = await import('bun')
    const found = new Set<string>()
    for (const f of new Glob('packages/{server,core,mcp}/**/*.ts').scanSync({ cwd: new URL('../../../../', import.meta.url).pathname })) {
      if (/\.test\.|node_modules/.test(f)) continue
      const src = await Bun.file(new URL('../../../../' + f, import.meta.url)).text()
      for (const m of src.matchAll(/\[from agentistics · ([a-z-]+)\]/g)) found.add(m[1]!)
    }
    expect(found.size).toBeGreaterThan(3)
    for (const k of found) expect(parseSystemEvent(`[from agentistics · ${k}]\nbody`)).not.toBeNull()
    expect(parseSystemEvent('[from agentistics · relay]\nx')?.kind).toBe('relay')
  })
})
