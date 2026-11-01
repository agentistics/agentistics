import { afterEach, expect, test } from 'bun:test'
import { __setFleetHostForTest, compactionAbsent, readConversationFacts } from './fleet-web'

afterEach(() => { __setFleetHostForTest('pt', null); __setFleetHostForTest('en', null) })

const host = (harness: string) => ({
  sessions: async () => ({ sessions: [{ id: 'oc1', harness, cwd: '/w', conversationId: 'ses_abc', title: 't', actionable: true }] }),
}) as never

test('an OpenCode session never reads "transcript not found": it records no compactions, and says so (pt + en)', async () => {
  __setFleetHostForTest('pt', host('opencode'))
  expect(await readConversationFacts('pt', 'oc1')).toEqual({ unavailable: 'OpenCode não registra compactações da conversa.' })
  __setFleetHostForTest('en', host('opencode'))
  expect(await readConversationFacts('en', 'oc1')).toEqual({ unavailable: 'OpenCode does not record conversation compactions.' })
})

test('the sentence names the harness by its label', () => {
  expect(compactionAbsent('codex', false)).toBe('Codex CLI does not record conversation compactions.')
})
