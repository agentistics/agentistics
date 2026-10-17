import { describe, expect, test } from 'bun:test'
import { personQueuedCount, visibleQueued } from './queuedCards'

const q = [{ text: 'hello there', at: 1 }]

describe('visibleQueued', () => {
  test('pending + transcript not loaded -> no cards', () => {
    expect(visibleQueued(q, [], false)).toEqual([])
  })
  test('loaded and the turn is present -> no cards', () => {
    expect(visibleQueued(q, ['hello there'], true)).toEqual([])
  })
  test('loaded without the turn -> card shows', () => {
    expect(visibleQueued(q, ['other'], true)).toEqual(q)
  })
  test('fresh echo after load shows', () => {
    expect(visibleQueued([{ text: 'new one' }], [], true)).toEqual([{ text: 'new one' }])
  })
  test('delivered ones are dropped', () => {
    expect(visibleQueued(q, [], true, new Set(['hello there']))).toEqual([])
  })
})

import { shouldRestoreDraft } from './queuedCards'
describe('shouldRestoreDraft', () => {
  test('send failure with no server copy -> text kept', () => {
    expect(shouldRestoreDraft([], 'x')).toBe(true)
    expect(shouldRestoreDraft(undefined, 'x')).toBe(true)
  })
  test('failure but the server already holds it -> composer stays empty', () => {
    expect(shouldRestoreDraft([{ text: 'x' }], 'x')).toBe(false)
  })
})

describe('visibleQueued local echoes', () => {
  test('a local echo shows before the transcript loads; a server copy does not', () => {
    const q = [{ text: 'mine' }, { text: 'old' }]
    expect(visibleQueued(q, [], false, new Set(), new Set(['mine']))).toEqual([{ text: 'mine' }])
  })
})

describe('visibleQueued restored echoes', () => {
  test('an echo restored from storage (not sent in this mount) waits for the transcript like a server copy', () => {
    const q = [{ text: 'sent earlier, maybe consumed' }, { text: 'sent now' }]
    expect(visibleQueued(q, [], false, new Set(), new Set(['sent now']))).toEqual([{ text: 'sent now' }])
    expect(visibleQueued(q, ['sent earlier, maybe consumed'], true, new Set(), new Set(['sent now']))).toEqual([{ text: 'sent now' }])
  })
})


describe('personQueuedCount', () => {
  const notice = { text: '[from session ab12 · handback]\nready', at: 1 }
  test('system notices stay visible but never offer send-now', () => {
    const queued = visibleQueued([notice], [], true)
    expect(queued).toEqual([notice])
    expect(personQueuedCount(queued)).toBe(0)
  })
  test('mixed queues count only the person’s messages', () => {
    expect(personQueuedCount([notice, { text: 'Please review' }, { text: 'Then publish' }])).toBe(2)
  })
  test('ordinary messages and mentions retain their count', () => {
    expect(personQueuedCount([{ text: 'hello' }, { text: 'Explain [from session ab12 · handback]' }])).toBe(2)
    expect(personQueuedCount([])).toBe(0)
  })
  test('wrapped and other recognized notices are excluded', () => {
    expect(personQueuedCount([
      { text: '<pasted_content id="q">\n[from session ab12 · handback]\nready\n</pasted_content id="q">' },
      { text: '[from session ab12 · block]\nblocked' },
      { text: '[from agentistics · away]\naway' },
      { text: 'Run the leadership check-in now.' },
    ])).toBe(0)
  })
})
