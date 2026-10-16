import { expect, test } from 'bun:test'
import { cliStrings } from '../cli-i18n'

for (const lang of ['en', 'pt'] as const) {
  test(`post-spawn filing failures have localized reasons (${lang})`, () => {
    const s = cliStrings(lang)
    for (const reason of ['no_such_task', 'no_such_session', 'no_such_subtask', 'needs_subtask', 'wrong_delivery', 'blocked', 'subtask_in_group']) {
      const message = s.spawnFilingFailed(reason)
      expect(message.startsWith(lang === 'pt' ? 'A sessão iniciou' : 'The session started')).toBe(true)
      expect(message).not.toContain(reason)
      expect(message).not.toBe(s.spawnFilingFailed('unknown'))
    }
    expect(s.spawnFilingFailed('unknown')).not.toContain('unknown')
  })
}
