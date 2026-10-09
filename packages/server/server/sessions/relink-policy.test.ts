import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER, type ConversationLinkReason } from '@agentistics/core'
import { HARNESS_PROCESS_TRANSCRIPTS } from './harness-session-file'
import { linkDecision, liveLinks, moveAllowed, sourceExclusive } from './relink-policy'

describe('relink-policy — which source may move which link', () => {
  // Iterated over the whole adapter set, so a harness added to HARNESS_PROCESS_TRANSCRIPTS is judged
  // here by having been added — never by remembering a second list.
  for (const harness of HARNESS_ORDER) {
    const spec = HARNESS_PROCESS_TRANSCRIPTS[harness]
    it(`${harness}: an unlinked row is asked only where a source exists`, () => {
      expect(linkDecision({ harness }, 'process-file')).toBe(spec ? 'link' : 'keep')
      expect(linkDecision({ harness }, 'managed-log')).toBe(spec?.managedLog ? 'link' : 'keep')
    })
    it(`${harness}: a reopened/assigned link moves only from an EXCLUSIVE source`, () => {
      for (const via of ['assigned-id', 'resumed-id'] as ConversationLinkReason[]) {
        for (const source of ['process-file', 'managed-log'] as const) {
          const d = linkDecision({ harness, conversationId: 'x', conversationLinkVia: via }, source)
          const reachable = Boolean(spec) && (source === 'process-file' || Boolean(spec?.managedLog))
          expect(d).toBe(reachable && sourceExclusive(harness, source) ? 'follow' : 'keep')
        }
      }
    })
    it(`${harness}: a link with no provenance or from the harness's own file is never moved`, () => {
      for (const source of ['process-file', 'managed-log'] as const) {
        expect(linkDecision({ harness, conversationId: 'x' }, source)).toBe('keep')
        expect(linkDecision({ harness, conversationId: 'x', conversationLinkVia: 'harness-session-file' }, source)).toBe('keep')
      }
    })
  }

  it('the measured exclusivity per harness: agy managed log yes, agy shared log no, codex/kimi files yes', () => {
    expect(sourceExclusive('antigravity', 'managed-log')).toBe(true)
    expect(sourceExclusive('antigravity', 'process-file')).toBe(false)
    expect(sourceExclusive('codex', 'process-file')).toBe(true)
    expect(sourceExclusive('kimi', 'process-file')).toBe(true)
    expect(sourceExclusive('codex', 'managed-log')).toBe(false)
    for (const h of ['claude', 'copilot', 'gemini', 'opencode'] as const) {
      expect(sourceExclusive(h, 'process-file')).toBe(false)
      expect(sourceExclusive(h, 'managed-log')).toBe(false)
    }
  })

  it('process-derived links keep following, from any source the harness has', () => {
    expect(linkDecision({ harness: 'antigravity', conversationId: 'x', conversationLinkVia: 'process-log' }, 'process-file')).toBe('follow')
    expect(linkDecision({ harness: 'kimi', conversationId: 'x', conversationLinkVia: 'first-sighting' }, 'process-file')).toBe('follow')
  })

  it('moveAllowed: a live row on the target blocks, the row itself and dead rows do not, rivals block', () => {
    const rows = [
      { id: 'a', conversationId: 'old' },
      { id: 'b', conversationId: 'new' },
      { id: 'dead', conversationId: 'gone' },
    ]
    const links = liveLinks(rows, id => id !== 'dead')
    expect(moveAllowed('a', 'new', links)).toBe(false)
    expect(moveAllowed('b', 'new', links)).toBe(true)
    expect(moveAllowed('a', 'gone', links)).toBe(true)
    expect(moveAllowed('a', 'fresh', links)).toBe(true)
    expect(moveAllowed('a', 'fresh', links, 2)).toBe(false)
  })
})
