import { describe, expect, it } from 'bun:test'
import { getReopening, markReopening, withReopening, reopeningLabel } from './reopeningStore'

describe('reopeningStore', () => {
  it('marks while the request runs and clears when it ends, even on a throw', async () => {
    let during = false
    await withReopening(['a', 'b'], async () => { during = getReopening().has('a') && getReopening().has('b') })
    expect(during).toBe(true)
    expect(getReopening().size).toBe(0)
    await expect(withReopening(['c'], async () => { throw new Error('x') })).rejects.toThrow()
    expect(getReopening().has('c')).toBe(false)
  })
  it('ignores empty ids and speaks both languages', () => {
    markReopening('')
    expect(getReopening().size).toBe(0)
    expect(reopeningLabel(true)).toBe('Reabrindo…')
    expect(reopeningLabel(false)).toBe('Reopening…')
  })
})

describe('every reopen surface shows the in-progress state', () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text()
  it('chat button, picker, aside row and recent-sessions button render the busy label', async () => {
    expect(await read('../components/sessions/SessionChat.tsx')).toContain('reopening ? reopeningLabel(pt)')
    expect(await read('../components/sessions/SessionPickModal.tsx')).toContain("busy && kind === 'reopen' ? reopeningLabel(pt)")
    const aside = await read('../components/nav/SessionsAside.tsx')
    expect(aside).toContain('useReopening().has(session.id)')
    expect(aside).toContain("withReopening([id], call)")
    expect(await read('../components/RecentSessions.tsx')).toContain("primary.kind === 'resume' && !!busy")
  })
  it('both resume dispatchers go through withReopening', async () => {
    for (const f of ['../components/SessionActions.tsx', '../components/sessions/SessionActions.tsx']) {
      expect(await read(f)).toContain("action === 'resume' ? withReopening([row.id], call)")
    }
  })
})
