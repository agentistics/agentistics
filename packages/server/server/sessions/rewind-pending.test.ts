import { describe, expect, test } from 'bun:test'
import { applyPendingRewind } from './rewind-pending'

const t = (role: string, text: string, at: string) => ({ role, text, at })
const turns = [
  t('user', 'ONE', '2026-09-29T10:00:00Z'), t('assistant', 'um', '2026-09-29T10:00:01Z'),
  t('user', 'TWO', '2026-09-29T10:01:00Z'), t('assistant', 'dois', '2026-09-29T10:01:01Z'),
  t('user', 'THREE', '2026-09-29T10:02:00Z'), t('assistant', 'tres', '2026-09-29T10:02:01Z'),
]
const at = Date.parse('2026-09-29T10:05:00Z')

describe('applyPendingRewind', () => {
  test('cuts the chat at the restored prompt, before the transcript can say it', () => {
    const out = applyPendingRewind(turns, { prompt: 'TWO', occurrence: 0, atMs: at })
    expect(out.turns.map(x => x.text)).toEqual(['ONE', 'um'])
    expect(out.stale).toBe(false)
  })
  test('a person\'s turn newer than the rewind means the file carries the branch: stale', () => {
    const later = [...turns, t('user', 'AFTER', '2026-09-29T10:06:00Z')]
    expect(applyPendingRewind(later, { prompt: 'TWO', occurrence: 0, atMs: at }).stale).toBe(true)
  })
  test('a prompt that is not in these turns cuts nothing', () => {
    expect(applyPendingRewind(turns, { prompt: 'NOPE', occurrence: 0, atMs: at }).turns).toHaveLength(6)
  })
  test('occurrence picks among identical prompts, latest first', () => {
    const dup = [t('user', 'SAME', '2026-09-29T10:00:00Z'), t('assistant', 'a', '2026-09-29T10:00:01Z'), t('user', 'SAME', '2026-09-29T10:01:00Z'), t('assistant', 'b', '2026-09-29T10:01:01Z')]
    expect(applyPendingRewind(dup, { prompt: 'SAME', occurrence: 1, atMs: at }).turns).toHaveLength(0)
    expect(applyPendingRewind(dup, { prompt: 'SAME', occurrence: 0, atMs: at }).turns).toHaveLength(2)
  })
})
